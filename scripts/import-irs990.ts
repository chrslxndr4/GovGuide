/**
 * Import IRS Form 990 data for nonprofit / dark-money tracking.
 *
 * No additional npm packages are required — the script uses the built-in
 * fetch API and lightweight regex-based XML extraction for the specific
 * fields needed.
 *
 * DATA SOURCES
 *   Index JSON  https://apps.irs.gov/pub/epostcard/990/xml/index_{year}.json
 *   XML filings  https://s3.amazonaws.com/irs-form-990/{ObjectId}_public.xml
 *
 * POLITICALLY RELEVANT SUBSECTIONS IMPORTED
 *   501(c)(4)  Social-welfare orgs  — primary dark-money vehicles
 *   501(c)(5)  Labor unions          — political spending tracked on Sched C
 *   501(c)(6)  Trade associations    — industry lobbying groups
 *   527        Political orgs        — pure political activity
 *
 * DB TABLES WRITTEN
 *   entities            — one row per org (type: '501c4' | 'labor_union' |
 *                          'trade_association' | '527_org' | '501c3' | …)
 *   entity_nonprofits   — financial detail keyed on EIN
 *   dark_money_flows    — Schedule I grants to other orgs/PACs
 *   relationships       — granted_to edges between entity rows
 *
 * ENVIRONMENT VARIABLES
 *   IRS990_YEAR  (optional) — filing tax year, default = previous calendar year
 *   IRS990_LIMIT (optional) — max filings to process per run, default = 5000
 *                              (set to 0 to process all)
 *   IRS990_DRY_RUN (optional) — if "true", skip all DB writes
 *
 * RUN
 *   npm run import:irs990
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One entry from the IRS annual index JSON. */
interface IrsIndexEntry {
  EIN: string;
  TaxPeriod: string;          // e.g. "202312"
  DLN: string;
  FormType: string;           // "990", "990EZ", "990PF", "990T"
  URL: string;                // full S3 URL to the XML
  OrganizationName: string;
  SubmittedOn: string;        // ISO date
  ObjectId: string;           // unique filing identifier
  LastUpdated: string;
  IsElectronic: string;       // "1" | "0"
  IsAvailable: string;        // "1" | "0"
}

interface IrsIndexResponse {
  Filings: IrsIndexEntry[];
}

/** Parsed data extracted from a 990 XML filing. */
interface Filing990 {
  ein: string;
  orgName: string;
  subsection: string | null;   // "04" = 501(c)(4), "05" = 501(c)(5), etc.
  taxYear: number | null;
  taxPeriodEnd: string | null; // ISO date YYYY-MM-DD
  totalRevenue: number | null;
  totalExpenses: number | null;
  totalAssets: number | null;
  totalGrantsMade: number | null;
  politicalExpenditures: number | null;
  website: string | null;
  description: string | null;
  /** Top-3 highest-paid officers (name, title, compensation). */
  officers: Array<{ name: string; title: string; compensation: number }>;
  /** Schedule I grants to other orgs. */
  grants: Array<{ recipientName: string; recipientEin: string | null; amount: number }>;
  objectId: string;
}

type IrsEntityType =
  | '501c4'
  | '501c3'
  | '527_org'
  | 'trade_association'
  | 'labor_union';

interface EntityInsert {
  entity_type: IrsEntityType;
  name: string;
  aliases: string[];
  external_ids: Record<string, string>;
  description: string | null;
  website: string | null;
  metadata: Record<string, unknown>;
}

interface NonprofitInsert {
  entity_id: string;
  ein: string;
  irs_subsection: string | null;
  total_revenue: number | null;
  total_expenses: number | null;
  total_assets: number | null;
  total_grants_made: number | null;
  political_expenditures: number | null;
  fiscal_year_end: string | null;
}

interface DarkMoneyFlowInsert {
  source_entity_id: string;
  target_entity_id: string;
  amount: number;
  year: number | null;
  irs_filing: string;
  metadata: Record<string, unknown>;
}

interface RelationshipInsert {
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: string;
  amount: number | null;
  date_start: string | null;
  cycle: string | null;
  metadata: Record<string, unknown>;
  confidence_score: number;
  source: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IRS_INDEX_BASE =
  'https://apps.irs.gov/pub/epostcard/990/xml/index_{year}.json';
const IRS_S3_BASE = 'https://s3.amazonaws.com/irs-form-990';

const BATCH_SIZE = 500;

/**
 * IRS subsection codes that indicate politically relevant activity.
 * The index JSON encodes these as the two-digit number within section 501(c).
 * "00" means section 527 political org (different code path).
 */
const RELEVANT_SUBSECTIONS = new Set(['04', '05', '06']);
const SUBSECTION_527_MARKER = '527';

// Limit per run (override via IRS990_LIMIT=0 for unlimited).
const DEFAULT_LIMIT = 5000;

// Milliseconds between XML fetch requests to be polite to the S3 endpoint.
const FETCH_DELAY_MS = 300;

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

/**
 * Extract the text content of the first matching XML element.
 * Uses a simple regex — sufficient for the flat fields we need from 990 XML.
 */
function xmlText(xml: string, tag: string): string | null {
  // Match <Tag> or <ns:Tag> (IRS XML uses irs: namespace prefix)
  const re = new RegExp(
    `<(?:[a-zA-Z0-9_]+:)?${tag}[^>]*>([^<]*)</(?:[a-zA-Z0-9_]+:)?${tag}>`,
    'i',
  );
  const m = xml.match(re);
  return m ? m[1].trim() || null : null;
}

/**
 * Extract all blocks of a repeated XML element as raw strings.
 */
function xmlBlocks(xml: string, tag: string): string[] {
  const blocks: string[] = [];
  // Match opening tags with optional namespace and attributes
  const re = new RegExp(
    `<(?:[a-zA-Z0-9_]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z0-9_]+:)?${tag}>`,
    'gi',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    blocks.push(m[1]);
  }
  return blocks;
}

function parseAmount(raw: string | null): number | null {
  if (!raw) return null;
  const n = parseFloat(raw.replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

/**
 * Convert an IRS TaxPeriod string (e.g. "202312") to a fiscal-year-end date.
 */
function taxPeriodToDate(period: string | null): string | null {
  if (!period || period.length < 6) return null;
  const year = period.slice(0, 4);
  const month = period.slice(4, 6);
  // Last day of the month as a rough fiscal-year-end date
  const lastDay = new Date(parseInt(year, 10), parseInt(month, 10), 0)
    .getDate()
    .toString()
    .padStart(2, '0');
  return `${year}-${month}-${lastDay}`;
}

// ---------------------------------------------------------------------------
// Entity-type mapping
// ---------------------------------------------------------------------------

function subsectionToEntityType(subsection: string | null, formType: string): IrsEntityType {
  if (formType === '990' || formType === '990EZ' || formType === '990PF') {
    switch (subsection) {
      case '04': return '501c4';
      case '03': return '501c3';
      case '05': return 'labor_union';
      case '06': return 'trade_association';
      default:   return '501c4'; // fallback for other 501(c) variants
    }
  }
  if (formType === '990T') return '501c3'; // exempt business income, usually 501(c)(3)
  return '501c4';
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// IRS index fetch
// ---------------------------------------------------------------------------

async function fetchIndex(year: number): Promise<IrsIndexEntry[]> {
  const url = IRS_INDEX_BASE.replace('{year}', String(year));
  console.log(`  Downloading index for ${year}: ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`IRS index fetch failed for year ${year}: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as IrsIndexResponse;
  return body.Filings ?? [];
}

// ---------------------------------------------------------------------------
// 990 XML fetch + extraction
// ---------------------------------------------------------------------------

async function fetchFiling(entry: IrsIndexEntry): Promise<Filing990 | null> {
  // Prefer the URL provided in the index; construct S3 fallback if absent.
  const xmlUrl =
    entry.URL && entry.URL.startsWith('http')
      ? entry.URL
      : `${IRS_S3_BASE}/${entry.ObjectId}_public.xml`;

  let xml: string;
  try {
    const res = await fetch(xmlUrl, {
      headers: { Accept: 'application/xml, text/xml, */*' },
    });
    if (!res.ok) {
      // 403/404 from S3 is common for redacted/not-yet-available filings
      if (res.status === 403 || res.status === 404) return null;
      throw new Error(`HTTP ${res.status}`);
    }
    xml = await res.text();
  } catch (err) {
    // Non-fatal: log and skip
    process.stdout.write('x');
    return null;
  }

  // --- Core financials ---
  const totalRevenue = parseAmount(
    xmlText(xml, 'TotalRevenueAmt') ??
    xmlText(xml, 'TotalRevenue') ??
    xmlText(xml, 'TotRevEtcAmt'),
  );
  const totalExpenses = parseAmount(
    xmlText(xml, 'TotalExpensesAmt') ??
    xmlText(xml, 'TotalExpenses') ??
    xmlText(xml, 'TotExpAmt'),
  );
  const totalAssets = parseAmount(
    xmlText(xml, 'TotalAssetsEOYAmt') ??
    xmlText(xml, 'TotalAssetsEOY') ??
    xmlText(xml, 'TotAssetsGrp'),
  );

  // Grants paid to other organizations (Form 990 Part IX line 1)
  const totalGrantsMade = parseAmount(
    xmlText(xml, 'GrantsAndOtherAssistanceAmt') ??
    xmlText(xml, 'TotalGrantsAmt') ??
    xmlText(xml, 'TotalGrantAndContriAmt'),
  );

  // Political expenditures (Form 990 Schedule C or Part IV)
  const politicalExpenditures = parseAmount(
    xmlText(xml, 'PoliticalExpendituresAmt') ??
    xmlText(xml, 'DirectExpendituresAmt') ??
    xmlText(xml, 'TotalExpendituresPoliticalAmt'),
  );

  // Org details
  const orgName =
    xmlText(xml, 'BusinessName') ??
    xmlText(xml, 'BusinessNameLine1Txt') ??
    xmlText(xml, 'BusinessNameLine1') ??
    entry.OrganizationName;

  const website =
    xmlText(xml, 'WebsiteAddressTxt') ??
    xmlText(xml, 'WebsiteAddress') ??
    null;

  const description =
    xmlText(xml, 'ActivityOrMissionDesc') ??
    xmlText(xml, 'MissionDesc') ??
    xmlText(xml, 'PrimaryExemptPurposeTxt') ??
    null;

  // IRS subsection within 501(c): the XML stores it as a number e.g. "4"
  const rawSubsection =
    xmlText(xml, 'Organization501c3Ind') !== null ? '03' :
    xmlText(xml, 'Organization501cInd') ??
    xmlText(xml, 'Org501cTypeDesc') ??
    null;

  // Normalise: pad to 2 digits, strip non-numeric
  let subsection: string | null = null;
  if (rawSubsection) {
    const digits = rawSubsection.replace(/\D/g, '');
    if (digits) subsection = digits.padStart(2, '0');
  }
  // If the form type in the index is "990" and no subsection found in XML,
  // fall back to the subsection derived from the IndexEntry EIN lookup (best-effort).

  // Tax year from TaxPeriod in index
  const taxPeriodEnd = taxPeriodToDate(entry.TaxPeriod);
  const taxYear = entry.TaxPeriod ? parseInt(entry.TaxPeriod.slice(0, 4), 10) : null;

  // --- Officer compensation (top 3) ---
  const officers: Filing990['officers'] = [];
  const officerBlocks = xmlBlocks(xml, 'OfficerDirectorTrusteeEmplGrp').slice(0, 3);
  for (const block of officerBlocks) {
    const name =
      xmlText(block, 'PersonNm') ??
      xmlText(block, 'PersonName') ??
      xmlText(block, 'BusinessNameLine1Txt') ??
      '';
    const title =
      xmlText(block, 'TitleTxt') ??
      xmlText(block, 'Title') ??
      '';
    const comp = parseAmount(
      xmlText(block, 'ReportableCompFromOrgAmt') ??
      xmlText(block, 'AverageHoursPerWeekRt'),
    );
    if (name) {
      officers.push({ name, title, compensation: comp ?? 0 });
    }
  }

  // --- Schedule I grants ---
  const grants: Filing990['grants'] = [];
  // Schedule I — recipients of grants/assistance
  const schedIBlocks = xmlBlocks(xml, 'RecipientTable').slice(0, 25);
  for (const block of schedIBlocks) {
    const recipientName =
      xmlText(block, 'BusinessNameLine1Txt') ??
      xmlText(block, 'RecipientBusinessName') ??
      xmlText(block, 'RecipientPersonNm') ??
      '';
    const recipientEin =
      xmlText(block, 'RecipientEIN') ??
      xmlText(block, 'EINOfRecipient') ??
      null;
    const amount = parseAmount(
      xmlText(block, 'CashGrantAmt') ??
      xmlText(block, 'AmountOfCashGrant'),
    );
    if (recipientName && amount !== null && amount > 0) {
      grants.push({ recipientName, recipientEin, amount });
    }
  }

  return {
    ein: entry.EIN,
    orgName: (orgName ?? entry.OrganizationName).trim(),
    subsection,
    taxYear,
    taxPeriodEnd,
    totalRevenue,
    totalExpenses,
    totalAssets,
    totalGrantsMade,
    politicalExpenditures,
    website,
    description,
    officers,
    grants,
    objectId: entry.ObjectId,
  };
}

// ---------------------------------------------------------------------------
// In-process caches
// ---------------------------------------------------------------------------

/** Maps EIN → entity UUID to avoid redundant DB lookups within a run. */
const einEntityCache = new Map<string, string>();

/** Maps normalised name → entity UUID for recipient resolution. */
const nameEntityCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// Entity resolution
// ---------------------------------------------------------------------------

async function resolveNonprofitEntity(
  filing: Filing990,
  entityType: IrsEntityType,
): Promise<string | null> {
  if (einEntityCache.has(filing.ein)) {
    return einEntityCache.get(filing.ein)!;
  }

  // 1. Try lookup by EIN in external_ids JSONB
  const { data: existing } = await supabase
    .from('entities')
    .select('id')
    .filter("external_ids->>'ein'", 'eq', filing.ein)
    .maybeSingle();

  if (existing) {
    const id = (existing as { id: string }).id;
    einEntityCache.set(filing.ein, id);
    nameEntityCache.set(filing.orgName.toLowerCase(), id);
    return id;
  }

  // 2. Upsert entity row
  const insert: EntityInsert = {
    entity_type: entityType,
    name: filing.orgName,
    aliases: [],
    external_ids: { ein: filing.ein },
    description: filing.description,
    website: filing.website,
    metadata: {
      source: 'irs_990',
      object_id: filing.objectId,
      tax_year: filing.taxYear,
      officers: filing.officers,
    },
  };

  const { data: created, error } = await supabase
    .from('entities')
    .upsert(insert, { onConflict: 'name', ignoreDuplicates: false })
    .select('id')
    .single();

  if (error || !created) {
    console.error(`\n  ERROR upserting entity "${filing.orgName}" (EIN ${filing.ein}): ${error?.message}`);
    return null;
  }

  const id = (created as { id: string }).id;
  einEntityCache.set(filing.ein, id);
  nameEntityCache.set(filing.orgName.toLowerCase(), id);
  return id;
}

/**
 * Resolve a grant recipient entity by EIN or name.
 * Creates a minimal placeholder entity if nothing is found — the full 990
 * for that org will fill in the details when its own filing is processed.
 */
async function resolveRecipientEntity(
  recipientName: string,
  recipientEin: string | null,
): Promise<string | null> {
  // Cache check
  const cacheKey = recipientEin ? `ein:${recipientEin}` : `name:${recipientName.toLowerCase()}`;
  if (einEntityCache.has(cacheKey)) return einEntityCache.get(cacheKey)!;
  if (nameEntityCache.has(recipientName.toLowerCase()))
    return nameEntityCache.get(recipientName.toLowerCase())!;

  // DB lookup by EIN
  if (recipientEin) {
    const { data: existing } = await supabase
      .from('entities')
      .select('id')
      .filter("external_ids->>'ein'", 'eq', recipientEin)
      .maybeSingle();

    if (existing) {
      const id = (existing as { id: string }).id;
      einEntityCache.set(cacheKey, id);
      return id;
    }
  }

  // DB lookup by name (trigram index will handle this efficiently)
  const { data: byName } = await supabase
    .from('entities')
    .select('id')
    .ilike('name', recipientName.trim())
    .maybeSingle();

  if (byName) {
    const id = (byName as { id: string }).id;
    einEntityCache.set(cacheKey, id);
    nameEntityCache.set(recipientName.toLowerCase(), id);
    return id;
  }

  // Create a minimal stub — entity type defaults to '501c4' since most IRS
  // grants go to social-welfare or other c4-style orgs; will be corrected
  // when that org's own filing is processed.
  const externalIds: Record<string, string> = {};
  if (recipientEin) externalIds['ein'] = recipientEin;

  const { data: stub, error } = await supabase
    .from('entities')
    .upsert(
      {
        entity_type: '501c4',
        name: recipientName.trim(),
        aliases: [],
        external_ids: externalIds,
        metadata: { source: 'irs_990_grant_recipient', stub: true },
        description: null,
        website: null,
      } as EntityInsert,
      { onConflict: 'name', ignoreDuplicates: false },
    )
    .select('id')
    .single();

  if (error || !stub) return null;

  const id = (stub as { id: string }).id;
  einEntityCache.set(cacheKey, id);
  nameEntityCache.set(recipientName.toLowerCase(), id);
  return id;
}

// ---------------------------------------------------------------------------
// Batch flush helpers
// ---------------------------------------------------------------------------

async function flushNonprofits(
  batch: NonprofitInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('entity_nonprofits')
    .upsert(batch, { onConflict: 'ein' });

  if (error) {
    console.error(`\n  BATCH entity_nonprofits UPSERT ERROR (${batch.length} rows): ${error.message}`);
    return { ok: 0, err: batch.length };
  }
  return { ok: batch.length, err: 0 };
}

async function flushDarkMoneyFlows(
  batch: DarkMoneyFlowInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('dark_money_flows')
    .upsert(batch, {
      onConflict: 'source_entity_id,target_entity_id,year,irs_filing',
    });

  if (error) {
    console.error(`\n  BATCH dark_money_flows UPSERT ERROR (${batch.length} rows): ${error.message}`);
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
      onConflict: 'source_entity_id,target_entity_id,relationship_type',
    });

  if (error) {
    console.error(`\n  BATCH relationships UPSERT ERROR (${batch.length} rows): ${error.message}`);
    return { ok: 0, err: batch.length };
  }
  return { ok: batch.length, err: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importIrs990(): Promise<void> {
  console.log('=== Import IRS Form 990 (Dark Money / Nonprofit Tracker) ===\n');

  const dryRun = process.env.IRS990_DRY_RUN === 'true';
  if (dryRun) {
    console.log('  DRY RUN enabled — no DB writes will be performed.\n');
  }

  // Determine tax year: default to last calendar year
  const defaultYear = new Date().getFullYear() - 1;
  const year = parseInt(process.env.IRS990_YEAR ?? String(defaultYear), 10);

  const rawLimit = parseInt(process.env.IRS990_LIMIT ?? String(DEFAULT_LIMIT), 10);
  const limit = rawLimit <= 0 ? Infinity : rawLimit;

  console.log(`  Tax year: ${year}`);
  console.log(`  Filing limit per run: ${isFinite(limit) ? limit : 'unlimited'}`);
  console.log(`  Relevant subsections: 501(c)(4), 501(c)(5), 501(c)(6), 527\n`);

  // --- Step 1: Download annual index ---
  let allEntries: IrsIndexEntry[];
  try {
    allEntries = await fetchIndex(year);
  } catch (err) {
    console.error(`\nFatal: could not fetch IRS index for ${year}:`, err);
    process.exit(1);
  }
  console.log(`  Total filings in ${year} index: ${allEntries.length.toLocaleString()}`);

  // --- Step 2: Filter to politically relevant filings ---
  // The IRS index JSON does not expose the subsection directly, so we first
  // filter on FormType (990 / 990EZ are the ones with financials we need;
  // 990PF is for private foundations; 990T is business income) and only
  // fetch XML for those.  Post-XML-parse we apply the subsection filter.
  // 990EZ filings are included because many smaller 501(c)(4)s file EZ.
  const relevantFormTypes = new Set(['990', '990EZ', '990PF']);
  const candidateEntries = allEntries.filter(
    (e) => relevantFormTypes.has(e.FormType) && e.IsAvailable === '1',
  );
  console.log(`  Candidate filings (990/990EZ/990PF, available): ${candidateEntries.length.toLocaleString()}`);

  // --- Counters ---
  let processed = 0;
  let relevantCount = 0;
  let skippedSubsection = 0;
  let skippedXmlError = 0;
  let entitiesOk = 0;
  let entitiesErr = 0;
  let nonprofitsOk = 0;
  let nonprofitsErr = 0;
  let grantsOk = 0;
  let grantsErr = 0;
  let relsOk = 0;
  let relsErr = 0;

  // Batch accumulators
  const nonprofitBatch: NonprofitInsert[] = [];
  const darkMoneyBatch: DarkMoneyFlowInsert[] = [];
  const relBatch: RelationshipInsert[] = [];

  async function maybeFlush(force = false): Promise<void> {
    if (
      !force &&
      nonprofitBatch.length < BATCH_SIZE &&
      darkMoneyBatch.length < BATCH_SIZE &&
      relBatch.length < BATCH_SIZE
    ) {
      return;
    }

    if (!dryRun) {
      if (nonprofitBatch.length > 0) {
        const { ok, err } = await flushNonprofits(nonprofitBatch.splice(0));
        nonprofitsOk += ok;
        nonprofitsErr += err;
      }
      if (darkMoneyBatch.length > 0) {
        const { ok, err } = await flushDarkMoneyFlows(darkMoneyBatch.splice(0));
        grantsOk += ok;
        grantsErr += err;
      }
      if (relBatch.length > 0) {
        const { ok, err } = await flushRelationships(relBatch.splice(0));
        relsOk += ok;
        relsErr += err;
      }
    } else {
      // In dry-run mode just drain the batches and count
      nonprofitsOk += nonprofitBatch.length;
      grantsOk += darkMoneyBatch.length;
      relsOk += relBatch.length;
      nonprofitBatch.length = 0;
      darkMoneyBatch.length = 0;
      relBatch.length = 0;
    }
  }

  // --- Step 3: Process each candidate filing ---
  for (const entry of candidateEntries) {
    if (processed >= limit) break;

    await sleep(FETCH_DELAY_MS);

    const filing = await fetchFiling(entry);
    processed++;

    if (!filing) {
      skippedXmlError++;
      continue;
    }

    // Determine entity type and check relevance by subsection
    const isExplicit527 =
      entry.OrganizationName.toLowerCase().includes('527') ||
      SUBSECTION_527_MARKER === filing.subsection;

    const entityType = isExplicit527
      ? ('527_org' as IrsEntityType)
      : subsectionToEntityType(filing.subsection, entry.FormType);

    // Filter: only keep subsections we care about
    const isRelevantSubsection =
      RELEVANT_SUBSECTIONS.has(filing.subsection ?? '') || isExplicit527;

    if (!isRelevantSubsection) {
      skippedSubsection++;
      process.stdout.write('·');
      continue;
    }

    relevantCount++;
    process.stdout.write('.');

    // --- Step 3a: Upsert entity ---
    let entityId: string | null = null;
    if (!dryRun) {
      entityId = await resolveNonprofitEntity(filing, entityType);
      if (!entityId) {
        entitiesErr++;
        continue;
      }
      entitiesOk++;
    } else {
      entityId = `dry-run-${filing.ein}`;
      entitiesOk++;
    }

    // --- Step 3b: Build nonprofit detail row ---
    nonprofitBatch.push({
      entity_id: entityId,
      ein: filing.ein,
      irs_subsection: filing.subsection,
      total_revenue: filing.totalRevenue,
      total_expenses: filing.totalExpenses,
      total_assets: filing.totalAssets,
      total_grants_made: filing.totalGrantsMade,
      political_expenditures: filing.politicalExpenditures,
      fiscal_year_end: filing.taxPeriodEnd,
    });

    // --- Step 3c: Process Schedule I grants ---
    for (const grant of filing.grants) {
      let recipientId: string | null = null;

      if (!dryRun) {
        recipientId = await resolveRecipientEntity(
          grant.recipientName,
          grant.recipientEin,
        );
      } else {
        recipientId = `dry-run-recipient-${grant.recipientEin ?? grant.recipientName}`;
      }

      if (!recipientId) continue;

      // dark_money_flows row
      darkMoneyBatch.push({
        source_entity_id: entityId,
        target_entity_id: recipientId,
        amount: grant.amount,
        year: filing.taxYear,
        irs_filing: filing.objectId,
        metadata: {
          recipient_name: grant.recipientName,
          recipient_ein: grant.recipientEin,
          source_org_name: filing.orgName,
          source_ein: filing.ein,
        },
      });

      // relationships row (granted_to edge for the graph)
      relBatch.push({
        source_entity_id: entityId,
        target_entity_id: recipientId,
        relationship_type: 'granted_to',
        amount: grant.amount,
        date_start: filing.taxPeriodEnd,
        cycle: filing.taxYear ? String(filing.taxYear) : null,
        metadata: {
          irs_filing: filing.objectId,
          recipient_ein: grant.recipientEin,
          form_type: entry.FormType,
        },
        confidence_score: 0.95,
        source: 'irs_990',
      });
    }

    await maybeFlush();
  }

  // Flush remaining batches
  await maybeFlush(true);

  // --- Summary ---
  console.log('\n\n=== Completed ===');
  console.log(`  Year:                   ${year}`);
  console.log(`  Index entries:          ${allEntries.length.toLocaleString()}`);
  console.log(`  Candidates fetched:     ${processed.toLocaleString()} / ${Math.min(candidateEntries.length, limit).toLocaleString()}`);
  console.log(`  Relevant (c4/c5/c6/527):${relevantCount.toLocaleString()}`);
  console.log(`  Skipped (other subsect):${skippedSubsection.toLocaleString()}`);
  console.log(`  Skipped (XML error):    ${skippedXmlError.toLocaleString()}`);
  console.log(`  Entities upserted:      ok=${entitiesOk}, err=${entitiesErr}`);
  console.log(`  Nonprofit rows:         ok=${nonprofitsOk}, err=${nonprofitsErr}`);
  console.log(`  Dark money flows:       ok=${grantsOk}, err=${grantsErr}`);
  console.log(`  Relationships:          ok=${relsOk}, err=${relsErr}`);
}

importIrs990().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
