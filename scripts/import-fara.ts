/**
 * Import Foreign Agents Registration Act (FARA) data from the DOJ FARA
 * eFiling API.
 *
 * Data source: https://efile.fara.gov/api/v1/
 *   - Active registrants:  GET /Registrants/json
 *   - Short-form filers:   GET /ShortForms/json
 *   - Foreign principals:  GET /ForeignPrincipals/json
 *
 * No API key is required.  All three endpoints return the entire dataset in a
 * single response (no pagination).
 *
 * What this script does:
 *   1. Fetches all active FARA registrants and upserts each as a graph entity
 *      (entity_type = 'lobbying_firm').  Registrants are firms or individuals
 *      that have registered with the DOJ as foreign agents.
 *   2. Upserts an entity_lobbying_firms detail row for each registrant,
 *      keyed on the FARA registration number stored in external_ids.
 *   3. Fetches all foreign principals and upserts each as a graph entity
 *      (entity_type = 'foreign_principal').
 *   4. Upserts an entity_foreign_principals detail row for each principal.
 *   5. Resolves the registrant entity for every principal and upserts a
 *      relationships row linking registrant → principal via
 *      relationship_type = 'registered_for'.
 *   6. Fetches short-form filers (exempt registrations) and upserts them as
 *      entity_type = 'lobbying_firm' with fara_short_form = true in metadata.
 *      Short-form registrants are not linked to foreign principals (the
 *      short-form exemption does not require principal disclosure).
 *
 * All DB writes are batched in groups of BATCH_SIZE (500) before being sent
 * to Supabase.
 *
 * Run with:  npm run import:fara
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FARA_API_BASE = 'https://efile.fara.gov/api/v1';
const BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// FARA API response shapes
// ---------------------------------------------------------------------------

/**
 * Top-level envelope returned by all three FARA endpoints.
 * The API always returns the full dataset in one shot — no pagination cursor.
 */
interface FaraEnvelope<TData> {
  SIGNATURE: {
    STATUS: string;       // "OK" on success
    REQUEST_DATE: string; // e.g. "03/10/2026 14:32:01"
    ROWCOUNT: number;
  };
  // The data array key differs per endpoint.
  REGISTRANTS?: TData[];
  SHORTFORMS?: TData[];
  FOREIGNPRINCIPALS?: TData[];
}

/**
 * A single active registrant from /Registrants/json.
 * Fields follow the DOJ FARA eFiling API schema.
 */
interface FaraRegistrant {
  /** Unique DOJ registration number, e.g. "1234". */
  RegistrationNumber: string;
  /** Registrant legal name. */
  Name: string;
  /** Registration date, e.g. "01/15/2020". */
  RegistrationDate: string | null;
  /** Date of last amendment filing, if any. */
  AmendmentDate: string | null;
  /** Date the registration was terminated, if applicable. */
  TerminationDate: string | null;
  /** Registrant's business address — street. */
  Address1: string | null;
  Address2: string | null;
  City: string | null;
  State: string | null;
  Zip: string | null;
  /** Country of the registrant (usually "United States"). */
  Country: string | null;
  /** Primary phone. */
  Phone: string | null;
  /** Primary email. */
  Email: string | null;
}

/**
 * A single short-form filer from /ShortForms/json.
 * Short-form registrations are exempt from the full FARA registration
 * requirements (22 U.S.C. § 613) — commonly lawyers and lobbyists acting
 * as "informational representatives" rather than full political agents.
 */
interface FaraShortForm {
  RegistrationNumber: string;
  /** Filer legal name (individual or firm). */
  Name: string;
  /** DOJ-assigned short-form document number. */
  DocType: string | null;
  /** Filing date. */
  FilingDate: string | null;
  /** Year of the filing period. */
  Year: string | null;
  ForeignPrincipalName: string | null;
  ForeignPrincipalCountry: string | null;
  ForeignPrincipalCity: string | null;
  Address1: string | null;
  Address2: string | null;
  City: string | null;
  State: string | null;
  Zip: string | null;
  Country: string | null;
}

/**
 * A single foreign principal from /ForeignPrincipals/json.
 * A foreign principal is the foreign government, political party, entity, or
 * individual on whose behalf the registrant is acting.
 */
interface FaraForeignPrincipal {
  /** The registration this principal is linked to. */
  RegistrationNumber: string;
  /** DOJ-assigned unique principal ID (e.g. "FP-1234"). */
  ForeignPrincipalId: string | null;
  /** Principal name. */
  Name: string;
  /** ISO or plain-text country name. */
  Country: string | null;
  /** Principal type, e.g. "Foreign Government", "Political Party",
   *  "Foreign-Based Political Organization", "Other". */
  PrincipalType: string | null;
  /** Date the principal relationship commenced. */
  RegistrationDate: string | null;
  /** Date the principal relationship terminated, if applicable. */
  TerminationDate: string | null;
  Address1: string | null;
  Address2: string | null;
  City: string | null;
  State: string | null;
  Zip: string | null;
  /** Country field for the principal's address (may differ from Country). */
  CountryOfAddress: string | null;
}

// ---------------------------------------------------------------------------
// DB insert shapes
// ---------------------------------------------------------------------------

interface EntityInsert {
  entity_type:
    | 'lobbying_firm'
    | 'foreign_principal'
    | 'individual'
    | 'corporation';
  name: string;
  aliases: string[];
  external_ids: Record<string, string | number | null>;
  metadata: Record<string, unknown>;
}

interface EntityLobbyingFirmInsert {
  entity_id: string;
  lda_registrant_id: string;  // stored as text — FARA reg numbers are not LDA IDs
  client_count: number;
}

interface EntityForeignPrincipalInsert {
  entity_id: string;
  country: string;
  principal_type: string | null;
  /** Present in the 007_entities migration schema as a dedicated column. */
  fara_reg_number?: string | null;
  /** Present in the 007_entities migration schema as a dedicated column. */
  registration_date?: string | null;
}

interface RelationshipInsert {
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: string;
  amount: number | null;
  date_start: string | null;
  date_end: string | null;
  metadata: Record<string, unknown>;
  confidence_score: number;
}

// ---------------------------------------------------------------------------
// In-process caches  (RegistrationNumber → entity UUID)
// ---------------------------------------------------------------------------

/** Maps FARA RegistrationNumber → entity UUID for registrant entities. */
const registrantEntityCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Convert a FARA date string "MM/DD/YYYY" to an ISO-8601 date "YYYY-MM-DD",
 * or return null when the input is absent or unparseable.
 */
function faraDateToIso(raw: string | null | undefined): string | null {
  if (!raw || raw.trim() === '') return null;
  // Normalise separators — some records use "-" instead of "/"
  const normalised = raw.trim().replace(/-/g, '/');
  const parts = normalised.split('/');
  if (parts.length !== 3) return null;
  const [month, day, year] = parts;
  if (!month || !day || !year) return null;
  // Basic sanity check before building the string.
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  const y = parseInt(year, 10);
  if (isNaN(m) || isNaN(d) || isNaN(y)) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Build a compact address string from optional parts.
 * Returns null when all parts are absent.
 */
function buildAddress(
  a1: string | null,
  a2: string | null,
  city: string | null,
  state: string | null,
  zip: string | null,
  country: string | null,
): string | null {
  const parts = [a1, a2, city, state, zip, country].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Attempt to infer the entity_type for a FARA registrant based on the name.
 * Almost all registrants are firms or unambiguous individuals — we default to
 * 'lobbying_firm' and use 'individual' only for obvious personal names
 * (contains comma or looks like "First Last").
 *
 * Using 'lobbying_firm' as the default aligns with how the LDA importer
 * treats Senate registrants and keeps the two datasets consistent in the graph.
 */
function inferRegistrantEntityType(
  name: string,
): 'lobbying_firm' | 'individual' {
  // "LAST, FIRST" pattern — DOJ commonly stores individual registrants this way.
  if (/^[A-Z][A-Z\s'-]+,\s+[A-Z]/.test(name.trim())) return 'individual';
  return 'lobbying_firm';
}

// ---------------------------------------------------------------------------
// API fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetch one of the FARA bulk endpoints and return the parsed envelope.
 * All three endpoints return the full dataset in a single JSON response.
 */
async function fetchFaraEndpoint<TData>(
  path: string,
): Promise<FaraEnvelope<TData>> {
  const url = `${FARA_API_BASE}${path}`;
  process.stdout.write(`Fetching ${url} ...\n`);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    throw new Error(
      `FARA API network error at ${url}: ${(err as Error).message}\n` +
        `  Check that https://efile.fara.gov is reachable from this host.`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `FARA API HTTP ${res.status} at ${url}: ${res.statusText}\n` +
        `  The DOJ FARA eFiling API may be temporarily unavailable.\n` +
        `  Visit https://efile.fara.gov/api/v1/ to check.`,
    );
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json') && !contentType.includes('text/json')) {
    throw new Error(
      `FARA API returned non-JSON content-type "${contentType}" at ${url}\n` +
        `  Ensure the endpoint path ends with /json.`,
    );
  }

  const body = (await res.json()) as FaraEnvelope<TData>;

  if (body.SIGNATURE?.STATUS !== 'OK') {
    throw new Error(
      `FARA API returned non-OK status "${body.SIGNATURE?.STATUS}" at ${url}`,
    );
  }

  const rowcount = body.SIGNATURE?.ROWCOUNT ?? '(unknown)';
  process.stdout.write(`  ${rowcount} rows received.\n`);
  return body;
}

// ---------------------------------------------------------------------------
// Generic batch upsert helpers
// ---------------------------------------------------------------------------

async function flushEntityLobbyingFirms(
  batch: EntityLobbyingFirmInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('entity_lobbying_firms')
    .upsert(batch, { onConflict: 'entity_id' });

  if (error) {
    console.error(
      `  BATCH ERROR entity_lobbying_firms (${batch.length} rows): ${error.message}`,
    );
    return { ok: 0, err: batch.length };
  }
  return { ok: batch.length, err: 0 };
}

async function flushEntityForeignPrincipals(
  batch: EntityForeignPrincipalInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('entity_foreign_principals')
    .upsert(batch, { onConflict: 'entity_id' });

  if (error) {
    console.error(
      `  BATCH ERROR entity_foreign_principals (${batch.length} rows): ${error.message}`,
    );
    return { ok: 0, err: batch.length };
  }
  return { ok: batch.length, err: 0 };
}

async function flushRelationships(
  batch: RelationshipInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('relationships')
    .upsert(batch, {
      onConflict: 'source_entity_id,target_entity_id,relationship_type,date_start',
    });

  if (error) {
    console.error(
      `  BATCH ERROR relationships (${batch.length} rows): ${error.message}`,
    );
    return { ok: 0, err: batch.length };
  }
  return { ok: batch.length, err: 0 };
}

// ---------------------------------------------------------------------------
// Entity upsert helper (select-then-insert pattern, same as import-lobbying)
// ---------------------------------------------------------------------------

/**
 * Look up an existing entity by a JSONB external_ids key, or insert a new
 * one.  Returns the UUID on success, null on error.
 *
 * The external_ids key must be a flat string value so it can be compared via
 * the ->> operator.
 */
async function upsertEntity(
  insert: EntityInsert,
  externalIdKey: string,
  externalIdValue: string,
): Promise<string | null> {
  // 1. Check if an entity already exists with this external ID.
  const { data: existing, error: selectErr } = await supabase
    .from('entities')
    .select('id')
    .eq(`external_ids->>${externalIdKey}`, externalIdValue)
    .maybeSingle();

  if (selectErr) {
    console.error(
      `  ERROR selecting entity (${externalIdKey}=${externalIdValue}): ${selectErr.message}`,
    );
    return null;
  }

  if (existing) {
    return (existing as { id: string }).id;
  }

  // 2. Insert and return the new UUID.
  const { data: created, error: insertErr } = await supabase
    .from('entities')
    .insert(insert)
    .select('id')
    .single();

  if (insertErr || !created) {
    console.error(
      `  ERROR inserting entity "${insert.name}": ${insertErr?.message}`,
    );
    return null;
  }

  return (created as { id: string }).id;
}

// ---------------------------------------------------------------------------
// Pass 1: active registrants
// ---------------------------------------------------------------------------

interface RegistrantPassResult {
  ok: number;
  err: number;
  firmDetailBatch: EntityLobbyingFirmInsert[];
}

async function processRegistrants(): Promise<RegistrantPassResult> {
  console.log('\n--- Pass 1: Active Registrants ---');

  const envelope = await fetchFaraEndpoint<FaraRegistrant>('/Registrants/json');
  const registrants = envelope.REGISTRANTS ?? [];

  let ok = 0;
  let err = 0;
  const firmDetailBatch: EntityLobbyingFirmInsert[] = [];

  for (const reg of registrants) {
    const regNum = reg.RegistrationNumber?.trim();
    if (!regNum) {
      console.error('  SKIP registrant with missing RegistrationNumber');
      err++;
      continue;
    }

    // Skip if already cached from a prior record (API sometimes repeats rows).
    if (registrantEntityCache.has(regNum)) {
      ok++;
      process.stdout.write('.');
      continue;
    }

    const entityType = inferRegistrantEntityType(reg.Name ?? '');

    const entityInsert: EntityInsert = {
      entity_type: entityType,
      name: (reg.Name ?? '').trim() || `FARA Registrant ${regNum}`,
      aliases: [],
      external_ids: {
        fara_registration_number: regNum,
      },
      metadata: {
        address: buildAddress(
          reg.Address1,
          reg.Address2,
          reg.City,
          reg.State,
          reg.Zip,
          reg.Country,
        ),
        phone: reg.Phone ?? null,
        email: reg.Email ?? null,
        registration_date: faraDateToIso(reg.RegistrationDate),
        amendment_date: faraDateToIso(reg.AmendmentDate),
        termination_date: faraDateToIso(reg.TerminationDate),
        country: reg.Country ?? null,
        source: 'fara',
      },
    };

    const entityId = await upsertEntity(
      entityInsert,
      'fara_registration_number',
      regNum,
    );

    if (!entityId) {
      err++;
      continue;
    }

    registrantEntityCache.set(regNum, entityId);

    // Queue entity_lobbying_firms detail row.
    // We store the FARA registration number in the lda_registrant_id column
    // because no separate FARA-specific detail table exists in the schema.
    // The external_ids JSONB on entities is the canonical unique handle for
    // FARA registrants.
    firmDetailBatch.push({
      entity_id: entityId,
      lda_registrant_id: regNum,
      client_count: 0,
    });

    if (firmDetailBatch.length >= BATCH_SIZE) {
      const result = await flushEntityLobbyingFirms(
        firmDetailBatch.splice(0, BATCH_SIZE),
      );
      console.log(
        `\n  Flushed entity_lobbying_firms batch (ok=${result.ok}, err=${result.err})`,
      );
      err += result.err;
    }

    ok++;
    process.stdout.write('.');
  }

  console.log(`\n  Registrants processed: ${ok}, errors: ${err}`);
  return { ok, err, firmDetailBatch };
}

// ---------------------------------------------------------------------------
// Pass 2: foreign principals
// ---------------------------------------------------------------------------

interface PrincipalPassResult {
  ok: number;
  err: number;
  principalDetailBatch: EntityForeignPrincipalInsert[];
  relationshipBatch: RelationshipInsert[];
}

async function processForeignPrincipals(): Promise<PrincipalPassResult> {
  console.log('\n--- Pass 2: Foreign Principals ---');

  const envelope = await fetchFaraEndpoint<FaraForeignPrincipal>(
    '/ForeignPrincipals/json',
  );
  const principals = envelope.FOREIGNPRINCIPALS ?? [];

  let ok = 0;
  let err = 0;
  const principalDetailBatch: EntityForeignPrincipalInsert[] = [];
  const relationshipBatch: RelationshipInsert[] = [];

  for (const fp of principals) {
    const fpId = fp.ForeignPrincipalId?.trim() || null;
    const regNum = fp.RegistrationNumber?.trim();

    if (!fp.Name?.trim()) {
      console.error('  SKIP foreign principal with missing Name');
      err++;
      continue;
    }

    // Build a stable external ID.  Use ForeignPrincipalId when present;
    // fall back to "regNum:name" as a synthetic key so we don't create
    // duplicate rows for the same principal across re-runs.
    const fpExternalKey = fpId ?? `${regNum}:${fp.Name.trim().toLowerCase()}`;

    const country = fp.Country?.trim() || fp.CountryOfAddress?.trim() || 'Unknown';

    const entityInsert: EntityInsert = {
      entity_type: 'foreign_principal',
      name: fp.Name.trim(),
      aliases: [],
      external_ids: {
        fara_foreign_principal_id: fpExternalKey,
        fara_registration_number: regNum ?? null,
      },
      metadata: {
        country,
        principal_type: fp.PrincipalType ?? null,
        address: buildAddress(
          fp.Address1,
          fp.Address2,
          fp.City,
          fp.State,
          fp.Zip,
          fp.CountryOfAddress,
        ),
        registration_date: faraDateToIso(fp.RegistrationDate),
        termination_date: faraDateToIso(fp.TerminationDate),
        source: 'fara',
      },
    };

    const principalEntityId = await upsertEntity(
      entityInsert,
      'fara_foreign_principal_id',
      fpExternalKey,
    );

    if (!principalEntityId) {
      err++;
      continue;
    }

    // Queue entity_foreign_principals detail row.
    // fara_reg_number and registration_date are present in the 007_entities
    // schema; they are silently ignored by Supabase if the column does not
    // exist in the active migration set.
    principalDetailBatch.push({
      entity_id: principalEntityId,
      country,
      principal_type: fp.PrincipalType?.trim() || null,
      fara_reg_number: regNum ?? null,
      registration_date: faraDateToIso(fp.RegistrationDate),
    });

    if (principalDetailBatch.length >= BATCH_SIZE) {
      const result = await flushEntityForeignPrincipals(
        principalDetailBatch.splice(0, BATCH_SIZE),
      );
      console.log(
        `\n  Flushed entity_foreign_principals batch (ok=${result.ok}, err=${result.err})`,
      );
      err += result.err;
    }

    // Resolve registrant entity for the relationship edge.
    // First check the in-process cache populated during Pass 1; if absent
    // (script re-run or schema pre-populated), fall back to a DB lookup.
    let registrantEntityId = regNum
      ? (registrantEntityCache.get(regNum) ?? null)
      : null;

    if (!registrantEntityId && regNum) {
      const { data: found } = await supabase
        .from('entities')
        .select('id')
        .eq('external_ids->>fara_registration_number', regNum)
        .maybeSingle();

      if (found) {
        registrantEntityId = (found as { id: string }).id;
        registrantEntityCache.set(regNum, registrantEntityId);
      }
    }

    if (registrantEntityId) {
      // registrant --[registered_for]--> foreign principal
      relationshipBatch.push({
        source_entity_id: registrantEntityId,
        target_entity_id: principalEntityId,
        relationship_type: 'registered_for',
        amount: null,
        date_start: faraDateToIso(fp.RegistrationDate),
        date_end: faraDateToIso(fp.TerminationDate),
        metadata: {
          fara_registration_number: regNum ?? null,
          fara_foreign_principal_id: fpId ?? null,
          principal_type: fp.PrincipalType ?? null,
          country,
        },
        confidence_score: 1.0,
      });

      if (relationshipBatch.length >= BATCH_SIZE) {
        const result = await flushRelationships(
          relationshipBatch.splice(0, BATCH_SIZE),
        );
        console.log(
          `\n  Flushed relationships batch (ok=${result.ok}, err=${result.err})`,
        );
        err += result.err;
      }
    } else if (regNum) {
      console.warn(
        `\n  WARN: no registrant entity found for RegistrationNumber=${regNum} (principal: ${fp.Name.trim()})`,
      );
    }

    ok++;
    process.stdout.write('.');
  }

  console.log(`\n  Foreign principals processed: ${ok}, errors: ${err}`);
  return { ok, err, principalDetailBatch, relationshipBatch };
}

// ---------------------------------------------------------------------------
// Pass 3: short-form filers
// ---------------------------------------------------------------------------

interface ShortFormPassResult {
  ok: number;
  err: number;
  shortFormFirmBatch: EntityLobbyingFirmInsert[];
}

async function processShortForms(): Promise<ShortFormPassResult> {
  console.log('\n--- Pass 3: Short-Form Filers ---');

  const envelope = await fetchFaraEndpoint<FaraShortForm>('/ShortForms/json');
  const shortForms = envelope.SHORTFORMS ?? [];

  let ok = 0;
  let err = 0;
  const shortFormFirmBatch: EntityLobbyingFirmInsert[] = [];

  // A single filer may have multiple short-form filings (one per period or
  // per principal).  Deduplicate by RegistrationNumber so we create at most
  // one entity per filer.
  const seenRegNums = new Set<string>();

  for (const sf of shortForms) {
    const regNum = sf.RegistrationNumber?.trim();
    if (!regNum) {
      err++;
      continue;
    }

    if (seenRegNums.has(regNum) || registrantEntityCache.has(regNum)) {
      ok++;
      process.stdout.write('.');
      continue;
    }
    seenRegNums.add(regNum);

    const entityType = inferRegistrantEntityType(sf.Name ?? '');

    const entityInsert: EntityInsert = {
      entity_type: entityType,
      name: (sf.Name ?? '').trim() || `FARA Short-Form Filer ${regNum}`,
      aliases: [],
      external_ids: {
        fara_registration_number: regNum,
      },
      metadata: {
        address: buildAddress(
          sf.Address1,
          sf.Address2,
          sf.City,
          sf.State,
          sf.Zip,
          sf.Country,
        ),
        foreign_principal_name: sf.ForeignPrincipalName ?? null,
        foreign_principal_country: sf.ForeignPrincipalCountry ?? null,
        foreign_principal_city: sf.ForeignPrincipalCity ?? null,
        filing_date: faraDateToIso(sf.FilingDate),
        filing_year: sf.Year ?? null,
        doc_type: sf.DocType ?? null,
        fara_short_form: true,
        source: 'fara',
      },
    };

    const entityId = await upsertEntity(
      entityInsert,
      'fara_registration_number',
      regNum,
    );

    if (!entityId) {
      err++;
      continue;
    }

    registrantEntityCache.set(regNum, entityId);

    shortFormFirmBatch.push({
      entity_id: entityId,
      lda_registrant_id: regNum,
      client_count: 0,
    });

    if (shortFormFirmBatch.length >= BATCH_SIZE) {
      const result = await flushEntityLobbyingFirms(
        shortFormFirmBatch.splice(0, BATCH_SIZE),
      );
      console.log(
        `\n  Flushed entity_lobbying_firms batch (short-forms) (ok=${result.ok}, err=${result.err})`,
      );
      err += result.err;
    }

    ok++;
    process.stdout.write('.');
  }

  console.log(`\n  Short-form filers processed: ${ok}, errors: ${err}`);
  return { ok, err, shortFormFirmBatch };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importFara(): Promise<void> {
  console.log('=== Import FARA Data (DOJ eFiling API) ===\n');
  console.log(`API base: ${FARA_API_BASE}`);
  console.log(`Batch size: ${BATCH_SIZE}\n`);

  // ---- Pass 1: active registrants ----------------------------------------
  const {
    ok: regOk,
    err: regErr,
    firmDetailBatch,
  } = await processRegistrants();

  // Flush any remaining entity_lobbying_firms rows from Pass 1.
  if (firmDetailBatch.length > 0) {
    const result = await flushEntityLobbyingFirms(firmDetailBatch);
    console.log(
      `  Flushed final entity_lobbying_firms batch (ok=${result.ok}, err=${result.err})`,
    );
  }

  // ---- Pass 2: foreign principals ----------------------------------------
  const {
    ok: fpOk,
    err: fpErr,
    principalDetailBatch,
    relationshipBatch,
  } = await processForeignPrincipals();

  // Flush remaining entity_foreign_principals rows.
  if (principalDetailBatch.length > 0) {
    const result = await flushEntityForeignPrincipals(principalDetailBatch);
    console.log(
      `  Flushed final entity_foreign_principals batch (ok=${result.ok}, err=${result.err})`,
    );
  }

  // Flush remaining relationships.
  if (relationshipBatch.length > 0) {
    const result = await flushRelationships(relationshipBatch);
    console.log(
      `  Flushed final relationships batch (ok=${result.ok}, err=${result.err})`,
    );
  }

  // ---- Pass 3: short-form filers ------------------------------------------
  const {
    ok: sfOk,
    err: sfErr,
    shortFormFirmBatch,
  } = await processShortForms();

  // Flush remaining short-form firm detail rows.
  if (shortFormFirmBatch.length > 0) {
    const result = await flushEntityLobbyingFirms(shortFormFirmBatch);
    console.log(
      `  Flushed final entity_lobbying_firms batch (short-forms) (ok=${result.ok}, err=${result.err})`,
    );
  }

  // ---- Summary ------------------------------------------------------------
  console.log('\n=== Completed ===');
  console.log(`Registrants (full):    processed=${regOk}, errors=${regErr}`);
  console.log(`Foreign principals:    processed=${fpOk}, errors=${fpErr}`);
  console.log(`Short-form filers:     processed=${sfOk}, errors=${sfErr}`);
  console.log(
    `Registrant entity cache size: ${registrantEntityCache.size}`,
  );
}

importFara().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
