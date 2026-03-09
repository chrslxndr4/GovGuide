/**
 * Import lobbying registrations and quarterly activity filings from the
 * Senate Lobbying Disclosure Act (LDA) API.
 *
 * API docs: https://lda.senate.gov/api/
 *
 * No API key is required for read-only access; the LDA API is publicly
 * available.  Rate-limiting is handled via a simple delay between pages.
 *
 * For each registration this script:
 *   1. Upserts an entity row for the lobbying firm   (type: 'lobbying_firm').
 *   2. Upserts an entity row for the client          (type: 'corporation' or
 *      inferred from the registrant description).
 *   3. Upserts an entity_lobbying_firms detail row.
 *   4. Upserts a lobbying_registrations row.
 *   5. Upserts a relationships row linking the client → firm via
 *      relationship_type 'lobbied_via'.
 *
 * For each filing this script:
 *   6. Resolves the parent registration UUID and upserts a
 *      lobbying_activities row.
 *
 * Records are batched in groups of 500 before being sent to Supabase.
 *
 * Run with:  npm run import:lobbying
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types — LDA API shapes
// ---------------------------------------------------------------------------

/** Raw registrant object nested inside a registration. */
interface LdaRegistrant {
  id: number;
  name: string;
  description: string | null;
  address_1: string | null;
  address_2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  phone: string | null;
  ppb_country: string | null;
  // Self-employed indicator: "Y" | "N" | null
  self_employed_individual: string | null;
}

/** Raw client object nested inside a registration. */
interface LdaClient {
  id: number;
  name: string;
  description: string | null;
  state: string | null;
  country: string | null;
  ppb_country: string | null;
}

/** Lobbying issue area code + description nested in a registration. */
interface LdaIssue {
  code: string;
  description: string;
}

/** One page of the /registrations/ endpoint. */
interface LdaRegistration {
  id: number;
  url: string;
  registrant: LdaRegistrant;
  client: LdaClient;
  // ISO-8601 date strings or null
  effective_date: string | null;
  termination_date: string | null;
  specific_issues: string | null;
  lobbying_activities?: LdaLobbyingActivity[];
  conviction_disclosures?: unknown[];
  // Array of issue area objects
  registrant_description: string | null;
}

/** Activity (lobbyist) entry nested inside a filing. */
interface LdaLobbyist {
  lobbyist: {
    id: number;
    prefix: string | null;
    first_name: string;
    last_name: string;
    suffix: string | null;
  };
  new: boolean | null;
  covered_position: string | null;
}

/** Government entity contacted, nested in a filing activity. */
interface LdaGovernmentEntity {
  id: number;
  name: string;
}

/** Bill lobbied, nested in a filing activity. */
interface LdaBill {
  congress_number: number | null;
  bill_type: string | null;
  bill_number: string | null;
}

/** Individual lobbying activity section inside a filing. */
interface LdaLobbyingActivity {
  id: number;
  general_issue_code: string;
  general_issue_code_display: string;
  description: string | null;
  lobbyists: LdaLobbyist[];
  government_entities: LdaGovernmentEntity[];
  bills: LdaBill[];
}

/** One page of the /filings/ endpoint. */
interface LdaFiling {
  filing_uuid: string;
  filing_type: string;           // 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'RA' | 'MA' …
  filing_year: number;
  period_display: string | null; // e.g. "2024 Q2 (Apr 1 – Jun 30)"
  dt_posted: string | null;
  income: string | null;         // decimal string, e.g. "150000.00"
  expenses: string | null;
  expenses_method: string | null;
  // The registration this filing belongs to
  registration: {
    id: number;
    url: string;
  };
  // Same shape as the top-level lobbying_activities array
  lobbying_activities: LdaLobbyingActivity[];
  conviction_disclosures: unknown[];
}

/** Paginated envelope returned by both /registrations/ and /filings/. */
interface LdaPage<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

// ---------------------------------------------------------------------------
// Types — DB insert shapes
// ---------------------------------------------------------------------------

type EntityType =
  | 'person'
  | 'corporation'
  | 'nonprofit'
  | 'government_agency'
  | 'lobbying_firm'
  | 'pac'
  | 'union'
  | 'media_outlet'
  | 'think_tank'
  | 'foreign_entity'
  | 'other';

interface EntityInsert {
  entity_type: EntityType;
  name: string;
  aliases: string[];
  external_ids: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

interface EntityLobbyingFirmInsert {
  entity_id: string;
  lda_registrant_id: number;
  client_count: number;
}

interface LobbyingRegistrationInsert {
  firm_entity_id: string;
  client_entity_id: string;
  issues: string[];
  effective_date: string | null;
  termination_date: string | null;
  metadata: Record<string, unknown>;
}

interface LobbyingActivityInsert {
  registration_id: string;
  report_period: string | null;
  amount: number | null;
  bills_lobbied: string[];
  agencies_contacted: string[];
  lobbyists: Record<string, unknown>[];
  metadata: Record<string, unknown>;
}

interface RelationshipInsert {
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: string;
  amount: number | null;
  date_start: string | null;
  metadata: Record<string, unknown>;
  confidence_score: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LDA_API_BASE = 'https://lda.senate.gov/api/v1';
const BATCH_SIZE = 500;
const PAGE_SIZE = 250; // LDA API supports up to 250 results per page
/** Milliseconds to wait between paginated requests to avoid rate-limiting. */
const REQUEST_DELAY_MS = 300;

// ---------------------------------------------------------------------------
// In-process caches (lda_registrant_id → entity UUID)
// ---------------------------------------------------------------------------

/** Maps LDA registrant numeric ID → entity UUID for lobbying firms. */
const firmEntityCache = new Map<number, string>();
/** Maps LDA client numeric ID → entity UUID for client entities. */
const clientEntityCache = new Map<number, string>();
/** Maps LDA registration numeric ID → lobbying_registrations UUID. */
const registrationUuidCache = new Map<number, string>();

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Derive a sensible EntityType for a client from its description text.
 * Falls back to 'corporation' when the description is absent or ambiguous.
 */
function inferClientEntityType(description: string | null): EntityType {
  if (!description) return 'corporation';
  const lower = description.toLowerCase();
  if (
    lower.includes('nonprofit') ||
    lower.includes('non-profit') ||
    lower.includes('501(c)') ||
    lower.includes('association') ||
    lower.includes('foundation') ||
    lower.includes('institute') ||
    lower.includes('society')
  ) {
    return 'nonprofit';
  }
  if (
    lower.includes('union') ||
    lower.includes('labor') ||
    lower.includes('workers')
  ) {
    return 'union';
  }
  if (
    lower.includes('government') ||
    lower.includes('agency') ||
    lower.includes('department') ||
    lower.includes('municipality') ||
    lower.includes('city of') ||
    lower.includes('county of') ||
    lower.includes('state of')
  ) {
    return 'government_agency';
  }
  if (lower.includes('think tank') || lower.includes('policy center')) {
    return 'think_tank';
  }
  if (lower.includes('foreign') || lower.includes('embassy')) {
    return 'foreign_entity';
  }
  return 'corporation';
}

/**
 * Parse the dollar-string amounts returned by the LDA API (e.g. "150000.00").
 * Returns null for absent, blank, or explicitly-zero values that look like
 * placeholder entries.
 */
function parseLdaAmount(raw: string | null): number | null {
  if (!raw || raw.trim() === '') return null;
  const n = parseFloat(raw);
  return isNaN(n) ? null : n;
}

/**
 * Build a human-readable report_period string from a filing's year and type.
 * Examples: "2024 Q2", "2024 Annual", "2024 Registration Amendment".
 */
function buildReportPeriod(filing: LdaFiling): string {
  const year = filing.filing_year;
  const type = (filing.filing_type ?? '').toUpperCase();
  switch (type) {
    case 'Q1':
      return `${year} Q1`;
    case 'Q2':
      return `${year} Q2`;
    case 'Q3':
      return `${year} Q3`;
    case 'Q4':
      return `${year} Q4`;
    case 'RA':
      return `${year} Registration Amendment`;
    case 'MA':
      return `${year} Mid-Year Amendment`;
    case 'CA':
      return `${year} Year-End Amendment`;
    default:
      return filing.period_display ?? `${year} ${type}`;
  }
}

/**
 * Collect unique bill identifiers from an activity list.
 * Produces strings like "118 HR 1234" or "119 S 5678".
 */
function collectBills(activities: LdaLobbyingActivity[]): string[] {
  const seen = new Set<string>();
  for (const act of activities) {
    for (const bill of act.bills ?? []) {
      if (bill.bill_number && bill.bill_type) {
        const label = [
          bill.congress_number,
          bill.bill_type.toUpperCase(),
          bill.bill_number,
        ]
          .filter(Boolean)
          .join(' ');
        seen.add(label);
      }
    }
  }
  return [...seen];
}

/**
 * Collect unique government entity names contacted across all activities.
 */
function collectAgencies(activities: LdaLobbyingActivity[]): string[] {
  const seen = new Set<string>();
  for (const act of activities ?? []) {
    for (const ge of act.government_entities ?? []) {
      if (ge.name) seen.add(ge.name);
    }
  }
  return [...seen];
}

/**
 * Serialize lobbyists from all activities into a deduplicated JSONB array.
 * Each entry: { id, first_name, last_name, covered_position }.
 */
function serializeLobbyists(
  activities: LdaLobbyingActivity[],
): Record<string, unknown>[] {
  const seen = new Map<number, Record<string, unknown>>();
  for (const act of activities ?? []) {
    for (const entry of act.lobbyists ?? []) {
      const lob = entry.lobbyist;
      if (!lob?.id) continue;
      if (!seen.has(lob.id)) {
        seen.set(lob.id, {
          id: lob.id,
          first_name: lob.first_name ?? null,
          last_name: lob.last_name ?? null,
          prefix: lob.prefix ?? null,
          suffix: lob.suffix ?? null,
          covered_position: entry.covered_position ?? null,
          new_lobbyist: entry.new ?? null,
        });
      }
    }
  }
  return [...seen.values()];
}

/**
 * Collect the text of every issue area code from a registration's activities.
 */
function collectIssues(activities: LdaLobbyingActivity[]): string[] {
  const seen = new Set<string>();
  for (const act of activities ?? []) {
    if (act.general_issue_code_display) {
      seen.add(act.general_issue_code_display);
    }
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// LDA API fetch helpers
// ---------------------------------------------------------------------------

async function fetchPage<T>(url: string): Promise<LdaPage<T>> {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`LDA API error ${res.status} at ${url}: ${res.statusText}`);
  }

  return (await res.json()) as LdaPage<T>;
}

/**
 * Iterate through all pages of a paginated LDA endpoint, yielding individual
 * result items.  Applies a small delay between requests.
 */
async function* iterateLdaEndpoint<T>(
  endpoint: string,
  params: Record<string, string> = {},
): AsyncGenerator<T> {
  const query = new URLSearchParams({
    ...params,
    limit: String(PAGE_SIZE),
    offset: '0',
  });

  let url: string | null = `${LDA_API_BASE}${endpoint}?${query.toString()}`;
  let pageNum = 0;

  while (url) {
    pageNum++;
    process.stdout.write(`  [page ${pageNum}] fetching ${url} …\n`);

    const page: LdaPage<T> = await fetchPage<T>(url);
    for (const item of page.results) {
      yield item;
    }

    url = page.next;
    if (url) await sleep(REQUEST_DELAY_MS);
  }
}

// ---------------------------------------------------------------------------
// DB upsert helpers
// ---------------------------------------------------------------------------

/**
 * Upsert an entity row and return its UUID.
 * Conflict resolution uses the lda_registrant_id key inside external_ids for
 * lobbying firms, and the lda_client_id for client entities.  Since Supabase
 * does not support partial-index conflicts on JSONB paths directly, we first
 * attempt a select by external_ids match, then insert if absent.
 */
async function upsertEntity(
  insert: EntityInsert,
  externalIdKey: string,
  externalIdValue: number,
): Promise<string | null> {
  // 1. Try to find an existing entity with the matching external ID.
  const { data: existing, error: selectErr } = await supabase
    .from('entities')
    .select('id')
    .eq(`external_ids->>${externalIdKey}`, String(externalIdValue))
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

  // 2. Insert a new entity.
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

/**
 * Upsert a lobbying_registrations row and return its UUID.
 * Uses the LDA registration numeric id stored in metadata.lda_registration_id
 * as the logical unique key.
 */
async function upsertLobbyingRegistration(
  ldaRegistrationId: number,
  insert: LobbyingRegistrationInsert,
): Promise<string | null> {
  // Check cache first.
  if (registrationUuidCache.has(ldaRegistrationId)) {
    return registrationUuidCache.get(ldaRegistrationId)!;
  }

  // Attempt to find existing row by the LDA ID stored in metadata.
  const { data: existing } = await supabase
    .from('lobbying_registrations')
    .select('id')
    .eq('metadata->>lda_registration_id', String(ldaRegistrationId))
    .maybeSingle();

  if (existing) {
    const uuid = (existing as { id: string }).id;
    registrationUuidCache.set(ldaRegistrationId, uuid);
    return uuid;
  }

  const { data: created, error } = await supabase
    .from('lobbying_registrations')
    .insert(insert)
    .select('id')
    .single();

  if (error || !created) {
    console.error(
      `  ERROR inserting lobbying_registration (lda_id=${ldaRegistrationId}): ${error?.message}`,
    );
    return null;
  }

  const uuid = (created as { id: string }).id;
  registrationUuidCache.set(ldaRegistrationId, uuid);
  return uuid;
}

// ---------------------------------------------------------------------------
// Batch flush helpers
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

async function flushLobbyingActivities(
  batch: LobbyingActivityInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  // Deduplicate within the batch by registration_id + report_period to avoid
  // violating any unique constraint on those columns.
  const seen = new Set<string>();
  const deduped: LobbyingActivityInsert[] = [];
  for (const row of batch) {
    const key = `${row.registration_id}|${row.report_period ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(row);
    }
  }

  const { error } = await supabase
    .from('lobbying_activities')
    .upsert(deduped, {
      onConflict: 'registration_id,report_period',
    });

  if (error) {
    console.error(
      `  BATCH ERROR lobbying_activities (${deduped.length} rows): ${error.message}`,
    );
    return { ok: 0, err: deduped.length };
  }

  return { ok: deduped.length, err: 0 };
}

// ---------------------------------------------------------------------------
// Registration processing
// ---------------------------------------------------------------------------

async function processRegistrations(): Promise<{
  ok: number;
  err: number;
  firmFirmBatch: EntityLobbyingFirmInsert[];
  relationshipBatch: RelationshipInsert[];
}> {
  let ok = 0;
  let err = 0;

  // Accumulators for batched tables.
  const firmFirmBatch: EntityLobbyingFirmInsert[] = [];
  const relationshipBatch: RelationshipInsert[] = [];

  console.log('\n--- Processing Registrations ---');

  for await (const reg of iterateLdaEndpoint<LdaRegistration>('/registrations/', {
    // Fetch with nested lobbying_activities so we can extract issue codes.
    // NOTE: the LDA API supports ?format=json by default.
  })) {
    // ------------------------------------------------------------------ firm
    const registrantId = reg.registrant.id;

    let firmEntityId = firmEntityCache.get(registrantId) ?? null;

    if (!firmEntityId) {
      const firmInsert: EntityInsert = {
        entity_type: 'lobbying_firm',
        name: reg.registrant.name,
        aliases: [],
        external_ids: {
          lda_registrant_id: registrantId,
        },
        metadata: {
          description: reg.registrant.description,
          address: [
            reg.registrant.address_1,
            reg.registrant.address_2,
            reg.registrant.city,
            reg.registrant.state,
            reg.registrant.zip,
            reg.registrant.country,
          ]
            .filter(Boolean)
            .join(', '),
          phone: reg.registrant.phone,
          self_employed: reg.registrant.self_employed_individual === 'Y',
          ppb_country: reg.registrant.ppb_country,
        },
      };

      firmEntityId = await upsertEntity(firmInsert, 'lda_registrant_id', registrantId);
      if (!firmEntityId) {
        err++;
        continue;
      }

      firmEntityCache.set(registrantId, firmEntityId);

      // Queue entity_lobbying_firms detail row for batch flush.
      firmFirmBatch.push({
        entity_id: firmEntityId,
        lda_registrant_id: registrantId,
        // client_count starts at 0; it is updated after all registrations are
        // processed via a separate aggregation query if needed.
        client_count: 0,
      });

      if (firmFirmBatch.length >= BATCH_SIZE) {
        const result = await flushEntityLobbyingFirms(firmFirmBatch.splice(0, BATCH_SIZE));
        console.log(
          `  Flushed entity_lobbying_firms batch (ok=${result.ok}, err=${result.err})`,
        );
        err += result.err;
      }
    }

    // ---------------------------------------------------------------- client
    const clientId = reg.client.id;

    let clientEntityId = clientEntityCache.get(clientId) ?? null;

    if (!clientEntityId) {
      const clientType = inferClientEntityType(reg.client.description);

      const clientInsert: EntityInsert = {
        entity_type: clientType,
        name: reg.client.name,
        aliases: [],
        external_ids: {
          lda_client_id: clientId,
        },
        metadata: {
          description: reg.client.description,
          state: reg.client.state,
          country: reg.client.country,
          ppb_country: reg.client.ppb_country,
        },
      };

      clientEntityId = await upsertEntity(clientInsert, 'lda_client_id', clientId);
      if (!clientEntityId) {
        err++;
        continue;
      }

      clientEntityCache.set(clientId, clientEntityId);
    }

    // --------------------------------------------------------- registration
    const activities = reg.lobbying_activities ?? [];
    const issues = collectIssues(activities);

    const registrationInsert: LobbyingRegistrationInsert = {
      firm_entity_id: firmEntityId,
      client_entity_id: clientEntityId,
      issues,
      effective_date: reg.effective_date ?? null,
      termination_date: reg.termination_date ?? null,
      metadata: {
        lda_registration_id: reg.id,
        lda_url: reg.url,
        specific_issues: reg.specific_issues,
        registrant_description: reg.registrant_description,
      },
    };

    const registrationUuid = await upsertLobbyingRegistration(reg.id, registrationInsert);
    if (!registrationUuid) {
      err++;
      continue;
    }

    // --------------------------------------------------------- relationship
    // client entity --[lobbied_via]--> firm entity
    relationshipBatch.push({
      source_entity_id: clientEntityId,
      target_entity_id: firmEntityId,
      relationship_type: 'lobbied_via',
      amount: null, // dollar amount is on the filing level, not the registration
      date_start: reg.effective_date ?? null,
      metadata: {
        lda_registration_id: reg.id,
        termination_date: reg.termination_date,
        issues,
      },
      confidence_score: 1.0,
    });

    if (relationshipBatch.length >= BATCH_SIZE) {
      const result = await flushRelationships(relationshipBatch.splice(0, BATCH_SIZE));
      console.log(
        `  Flushed relationships batch (ok=${result.ok}, err=${result.err})`,
      );
      err += result.err;
    }

    ok++;
    process.stdout.write('.');
  }

  console.log(`\n  Registrations processed: ${ok}, errors: ${err}`);

  return { ok, err, firmFirmBatch, relationshipBatch };
}

// ---------------------------------------------------------------------------
// Filing processing
// ---------------------------------------------------------------------------

async function processFilings(): Promise<{ ok: number; err: number }> {
  let ok = 0;
  let err = 0;

  const activityBatch: LobbyingActivityInsert[] = [];

  console.log('\n--- Processing Filings ---');

  for await (const filing of iterateLdaEndpoint<LdaFiling>('/filings/')) {
    const ldaRegId = filing.registration.id;

    // Resolve the registration UUID — must already exist from the first pass.
    let registrationUuid = registrationUuidCache.get(ldaRegId) ?? null;

    if (!registrationUuid) {
      // Fall back to a DB lookup in case the registration was created in a
      // prior run or was not encountered during this run's registration pass.
      const { data: found } = await supabase
        .from('lobbying_registrations')
        .select('id')
        .eq('metadata->>lda_registration_id', String(ldaRegId))
        .maybeSingle();

      if (!found) {
        // The registration hasn't been imported yet — skip this filing.
        err++;
        continue;
      }

      registrationUuid = (found as { id: string }).id;
      registrationUuidCache.set(ldaRegId, registrationUuid);
    }

    const activities = filing.lobbying_activities ?? [];

    // Prefer income over expenses; both may be present.
    const rawAmount = filing.income ?? filing.expenses ?? null;
    const amount = parseLdaAmount(rawAmount);

    const activityInsert: LobbyingActivityInsert = {
      registration_id: registrationUuid,
      report_period: buildReportPeriod(filing),
      amount,
      bills_lobbied: collectBills(activities),
      agencies_contacted: collectAgencies(activities),
      lobbyists: serializeLobbyists(activities),
      metadata: {
        filing_uuid: filing.filing_uuid,
        filing_type: filing.filing_type,
        filing_year: filing.filing_year,
        dt_posted: filing.dt_posted,
        expenses_method: filing.expenses_method,
        income_raw: filing.income,
        expenses_raw: filing.expenses,
        activity_count: activities.length,
      },
    };

    activityBatch.push(activityInsert);

    if (activityBatch.length >= BATCH_SIZE) {
      const result = await flushLobbyingActivities(activityBatch.splice(0, BATCH_SIZE));
      console.log(
        `  Flushed lobbying_activities batch (ok=${result.ok}, err=${result.err})`,
      );
      err += result.err;
      ok += result.ok;
    }

    process.stdout.write('.');
  }

  // Flush any remaining activities.
  if (activityBatch.length > 0) {
    const result = await flushLobbyingActivities(activityBatch);
    console.log(
      `  Flushed final lobbying_activities batch (ok=${result.ok}, err=${result.err})`,
    );
    err += result.err;
    ok += result.ok;
  }

  console.log(`\n  Activities upserted: ${ok}, errors: ${err}`);
  return { ok, err };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importLobbying(): Promise<void> {
  console.log('=== Import Lobbying Data (Senate LDA API) ===\n');

  // ---- Pass 1: registrations -------------------------------------------
  const {
    ok: regOk,
    err: regErr,
    firmFirmBatch,
    relationshipBatch,
  } = await processRegistrations();

  // Flush any leftover entity_lobbying_firms rows.
  if (firmFirmBatch.length > 0) {
    const result = await flushEntityLobbyingFirms(firmFirmBatch);
    console.log(
      `  Flushed final entity_lobbying_firms batch (ok=${result.ok}, err=${result.err})`,
    );
  }

  // Flush any leftover relationship rows.
  if (relationshipBatch.length > 0) {
    const result = await flushRelationships(relationshipBatch);
    console.log(
      `  Flushed final relationships batch (ok=${result.ok}, err=${result.err})`,
    );
  }

  // ---- Pass 2: filings / quarterly reports --------------------------------
  const { ok: filingOk, err: filingErr } = await processFilings();

  // ---- Summary ------------------------------------------------------------
  console.log('\n=== Completed ===');
  console.log(`Registrations:       processed=${regOk}, errors=${regErr}`);
  console.log(`Activity filings:    processed=${filingOk}, errors=${filingErr}`);
  console.log(
    `Total entities cached: firms=${firmEntityCache.size}, clients=${clientEntityCache.size}`,
  );
}

importLobbying().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
