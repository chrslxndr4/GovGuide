/**
 * Import judicial financial disclosures and investment positions from the
 * CourtListener REST API v4.
 *
 * API documentation: https://www.courtlistener.com/help/api/rest/
 * Endpoints used:
 *   GET /api/rest/v4/financial-disclosures/
 *   GET /api/rest/v4/investments/
 *
 * Requires environment variables:
 *   COURTLISTENER_API_TOKEN  — Bearer token for the CourtListener API
 *                              Obtain at: https://www.courtlistener.com/sign-in/
 *
 * Optional environment variables:
 *   COURTLISTENER_PAGE_SIZE  — Results per page (default: 100, max: 100)
 *   COURTLISTENER_MAX_PAGES  — Hard cap on pages fetched per endpoint (default: 0 = unlimited)
 *   COURTLISTENER_YEAR_FROM  — Only fetch disclosures on or after this year (default: none)
 *
 * For each disclosure this script:
 *   1. Matches to an existing judges row by name fuzzy-search.
 *   2. Upserts a judge_financial_disclosures record.
 *   3. Fetches investment positions for that disclosure.
 *   4. Upserts judge_investments records.
 *   5. For positions with a ticker, resolves (or creates) a 'corporation' entity
 *      and upserts a 'holds_stock' relationship linking the judge entity to it.
 *
 * Records are processed in batches of 100.
 *
 * Run with:  npx tsx --env-file=.env scripts/import-judge-financials.ts
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** CourtListener /financial-disclosures/ response item */
interface ClDisclosure {
  id: number;
  absolute_url: string;
  person: string;           // URL like "/api/rest/v4/people/12345/"
  person_id?: number;       // Numeric person ID (sometimes embedded)
  year: number;
  year_created: number;
  date_created: string;     // ISO timestamp
  date_modified: string;
  download_filepath?: string;
  has_been_extracted: boolean;
  is_amended: boolean;
  report_type: string;      // "Annual", "Nomination", etc.
  addendum_content_raw?: string;
  investments?: ClInvestment[];
}

/** CourtListener /investments/ response item */
interface ClInvestment {
  id: number;
  financial_disclosure: string;   // URL like "/api/rest/v4/financial-disclosures/42/"
  financial_disclosure_id?: number;
  description: string;            // Asset name
  page_count: number;
  income_during_reporting_period_code?: string;   // e.g. "J" = $1–$200
  income_during_reporting_period_type?: string;
  gross_value_code?: string;       // e.g. "M" = $250,001–$500,000
  gross_value_method?: string;
  transaction_type?: string;
  transaction_date?: string;
  transaction_value_code?: string;
  ticker?: string;
  redacted?: boolean;
}

/** Paginated list response from CourtListener */
interface ClPaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

/** CourtListener /people/ item (minimal fields we need) */
interface ClPerson {
  id: number;
  name_full: string;
  name_first: string;
  name_last: string;
  name_middle?: string;
  name_suffix?: string;
}

interface DisclosureInsert {
  judge_id: string;
  year: number;
  filing_url: string | null;
  parsed_data: Record<string, unknown>;
}

interface InvestmentInsert {
  judge_id: string;
  disclosure_id: string;
  asset_name: string;
  ticker: string | null;
  value_range_low: number | null;
  value_range_high: number | null;
}

interface EntityInsert {
  entity_type: 'judge' | 'corporation';
  name: string;
  aliases: string[];
  external_ids: Record<string, string>;
  metadata: Record<string, unknown>;
}

interface RelationshipInsert {
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: 'holds_stock';
  amount: number | null;
  date_start: string | null;
  metadata: Record<string, unknown>;
  confidence_score: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE = 'https://www.courtlistener.com/api/rest/v4';
const BATCH_SIZE = 100;
const DEFAULT_PAGE_SIZE = 100;
const REQUEST_DELAY_MS = 500; // Courtesy delay between paginated requests

/**
 * CourtListener gross value code → [low, high] dollar ranges (USD).
 * Source: https://www.courtlistener.com/help/api/rest/financial-disclosures/
 */
const GROSS_VALUE_RANGES: Record<string, [number, number]> = {
  A: [1, 1_000],
  B: [1_001, 2_500],
  C: [2_501, 5_000],
  D: [5_001, 15_000],
  E: [15_001, 50_000],
  F: [50_001, 100_000],
  G: [100_001, 250_000],
  H: [250_001, 500_000],
  I: [500_001, 1_000_000],
  J: [1_000_001, 5_000_000],
  K: [5_000_001, 25_000_000],
  L: [25_000_001, 50_000_000],
  M: [50_000_001, Number.MAX_SAFE_INTEGER],
};

/**
 * Income code → [low, high] dollar ranges (USD).
 */
const INCOME_RANGES: Record<string, [number, number]> = {
  A: [1, 200],
  B: [201, 1_000],
  C: [1_001, 2_500],
  D: [2_501, 5_000],
  E: [5_001, 15_000],
  F: [15_001, 50_000],
  G: [50_001, 100_000],
  H: [100_001, 1_000_000],
  I: [1_000_001, 5_000_000],
  J: [5_000_001, Number.MAX_SAFE_INTEGER],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decode a CourtListener value/income code into a [low, high] tuple.
 * Returns [null, null] if the code is absent or unknown.
 */
function decodeValueCode(
  code: string | undefined,
  table: Record<string, [number, number]>,
): [number | null, number | null] {
  if (!code) return [null, null];
  const range = table[code.toUpperCase()];
  if (!range) return [null, null];
  const [low, high] = range;
  return [low, high === Number.MAX_SAFE_INTEGER ? null : high];
}

/**
 * Extract the numeric ID from a CourtListener resource URL.
 * e.g. "/api/rest/v4/people/12345/" → 12345
 */
function extractIdFromUrl(url: string): number | null {
  const match = url.match(/\/(\d+)\/?$/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Normalise a judge's full name for fuzzy matching: lowercase, collapse
 * whitespace, strip punctuation.
 */
function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Very simple name similarity check.  Returns true if the two normalised
 * names share the same last-word token (last name) and at least one
 * other token (first or middle name initial).
 */
function namesMatch(a: string, b: string): boolean {
  const tokensA = a.split(' ');
  const tokensB = b.split(' ');
  const lastA = tokensA.at(-1) ?? '';
  const lastB = tokensB.at(-1) ?? '';
  if (lastA !== lastB) return false;
  // Check for at least one matching non-last token.
  const firstA = tokensA.slice(0, -1);
  const firstB = tokensB.slice(0, -1);
  return firstA.some(
    (t) => t.length > 0 && firstB.some((s) => s.startsWith(t[0])),
  );
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

const judgeNameCache = new Map<string, { judgeId: string; entityId: string } | null>();
// normalisedName → { judgeId, entityId } | null (null = not found)

const corporationEntityCache = new Map<string, string>(); // ticker → entity UUID
const disclosureCache = new Map<string, string>(); // `${judgeId}:${year}` → disclosure UUID

// ---------------------------------------------------------------------------
// CourtListener API
// ---------------------------------------------------------------------------

async function clFetch<T>(
  path: string,
  token: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Token ${token}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(
      `CourtListener API error ${res.status} for ${path}: ${res.statusText}`,
    );
  }

  return res.json() as Promise<T>;
}

/**
 * Paginate through all results for a CourtListener list endpoint.
 * Yields one page of results at a time.
 */
async function* paginateClEndpoint<T>(
  path: string,
  token: string,
  extraParams: Record<string, string> = {},
  maxPages = 0,
): AsyncGenerator<T[]> {
  const pageSize = parseInt(
    process.env['COURTLISTENER_PAGE_SIZE'] ?? String(DEFAULT_PAGE_SIZE),
    10,
  );
  const cap = maxPages || parseInt(process.env['COURTLISTENER_MAX_PAGES'] ?? '0', 10);

  let nextUrl: string | null = null;
  let page = 0;

  do {
    let results: T[];
    let nextFromApi: string | null;

    if (nextUrl) {
      // Follow the `next` cursor directly.
      const res = await fetch(nextUrl, {
        headers: {
          Authorization: `Token ${token}`,
          Accept: 'application/json',
        },
      });
      if (!res.ok) {
        throw new Error(
          `CourtListener pagination error ${res.status}: ${res.statusText}`,
        );
      }
      const body = (await res.json()) as ClPaginatedResponse<T>;
      results = body.results;
      nextFromApi = body.next;
    } else {
      const body = await clFetch<ClPaginatedResponse<T>>(path, token, {
        ...extraParams,
        page_size: String(pageSize),
      });
      results = body.results;
      nextFromApi = body.next;
    }

    yield results;
    page++;
    nextUrl = nextFromApi;

    if (nextUrl && (cap === 0 || page < cap)) {
      await sleep(REQUEST_DELAY_MS);
    }
  } while (nextUrl && (cap === 0 || page < cap));
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * Look up a judge (and their entity_id) by matching the CourtListener person
 * name against judges in the database.
 *
 * Strategy:
 *  1. Attempt a direct ilike search on judges.full_name.
 *  2. If multiple hits, apply the namesMatch tiebreak.
 *  3. Cache the result (including null for not-found) to avoid repeated queries.
 */
async function findJudgeByName(
  fullName: string,
): Promise<{ judgeId: string; entityId: string } | null> {
  const normalised = normaliseName(fullName);
  if (judgeNameCache.has(normalised)) return judgeNameCache.get(normalised)!;

  // Extract last name for the DB filter.
  const tokens = normalised.split(' ');
  const lastName = tokens.at(-1) ?? '';

  const { data, error } = await supabase
    .from('judges')
    .select('id, entity_id, full_name')
    .ilike('full_name', `%${lastName}%`)
    .limit(20);

  if (error) {
    console.error(`  ERROR searching judges for "${fullName}": ${error.message}`);
    judgeNameCache.set(normalised, null);
    return null;
  }

  if (!data || data.length === 0) {
    judgeNameCache.set(normalised, null);
    return null;
  }

  // Tiebreak with the stricter namesMatch heuristic.
  const rows = data as Array<{ id: string; entity_id: string | null; full_name: string }>;
  const match = rows.find((r) => namesMatch(normalised, normaliseName(r.full_name)));

  if (!match) {
    judgeNameCache.set(normalised, null);
    return null;
  }

  if (!match.entity_id) {
    // Judge exists but has no linked entity yet — this is unusual but handle gracefully.
    judgeNameCache.set(normalised, null);
    return null;
  }

  const result = { judgeId: match.id, entityId: match.entity_id };
  judgeNameCache.set(normalised, result);
  return result;
}

/**
 * Upsert a corporation entity by ticker.  Returns the entity UUID.
 * Uses the ticker as the de-duplication key in external_ids.
 */
async function getOrCreateCorporationEntity(
  ticker: string,
  assetName: string,
): Promise<string | null> {
  const upperTicker = ticker.toUpperCase();
  if (corporationEntityCache.has(upperTicker)) {
    return corporationEntityCache.get(upperTicker)!;
  }

  // Look up by ticker in external_ids.
  const { data: existing } = await supabase
    .from('entities')
    .select('id')
    .eq('entity_type', 'corporation')
    .contains('external_ids', { ticker: upperTicker })
    .maybeSingle();

  if (existing) {
    const id = (existing as { id: string }).id;
    corporationEntityCache.set(upperTicker, id);
    return id;
  }

  // Also check entity_corporations table for a ticker match.
  const { data: corpRow } = await supabase
    .from('entity_corporations')
    .select('entity_id')
    .eq('ticker', upperTicker)
    .maybeSingle();

  if (corpRow) {
    const id = (corpRow as { entity_id: string }).entity_id;
    corporationEntityCache.set(upperTicker, id);
    return id;
  }

  // Create a new entity.
  const insert: EntityInsert = {
    entity_type: 'corporation',
    name: assetName || upperTicker,
    aliases: upperTicker !== assetName ? [upperTicker] : [],
    external_ids: { ticker: upperTicker },
    metadata: { source: 'courtlistener_financial_disclosure' },
  };

  const { data: created, error } = await supabase
    .from('entities')
    .insert(insert)
    .select('id')
    .single();

  if (error || !created) {
    console.error(`  ERROR creating corporation entity for ticker "${upperTicker}": ${error?.message}`);
    return null;
  }

  const id = (created as { id: string }).id;
  corporationEntityCache.set(upperTicker, id);
  return id;
}

// ---------------------------------------------------------------------------
// Batch flush helpers
// ---------------------------------------------------------------------------

async function flushDisclosures(
  batch: DisclosureInsert[],
): Promise<Map<string, string>> {
  // Returns map of `${judge_id}:${year}` → disclosure UUID
  const result = new Map<string, string>();
  if (batch.length === 0) return result;

  const { data, error } = await supabase
    .from('judge_financial_disclosures')
    .upsert(batch, { onConflict: 'judge_id,year' })
    .select('id, judge_id, year');

  if (error || !data) {
    console.error(`  DISCLOSURE BATCH ERROR (${batch.length} records): ${error?.message}`);
    return result;
  }

  for (const row of data as Array<{ id: string; judge_id: string; year: number }>) {
    result.set(`${row.judge_id}:${row.year}`, row.id);
  }
  return result;
}

async function flushInvestments(
  batch: InvestmentInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  // judge_investments has no unique constraint in the schema; insert rather than
  // upsert to avoid orphan duplicates on repeated runs.  We rely on the
  // disclosure-level de-duplication above to avoid re-processing known years.
  const { error } = await supabase.from('judge_investments').insert(batch);

  if (error) {
    console.error(`  INVESTMENT BATCH ERROR (${batch.length} records): ${error.message}`);
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

async function flushRelationships(
  batch: RelationshipInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  // Upsert on (source, target, type) to avoid duplicate edges.
  const { error } = await supabase
    .from('relationships')
    .upsert(batch, {
      onConflict: 'source_entity_id,target_entity_id,relationship_type',
    });

  if (error) {
    console.error(`  RELATIONSHIP BATCH ERROR (${batch.length} records): ${error.message}`);
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

// ---------------------------------------------------------------------------
// CourtListener person → judge resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a CourtListener person URL to a GovGuide judge.
 *
 * We first try fetching the person record from CourtListener to get the
 * canonical full name, then match against the judges table.
 */
async function resolvePersonToJudge(
  personUrl: string,
  token: string,
): Promise<{ judgeId: string; entityId: string } | null> {
  let fullName: string | null = null;

  try {
    const personId = extractIdFromUrl(personUrl);
    if (personId !== null) {
      const person = await clFetch<ClPerson>(`/people/${personId}/`, token);
      const parts = [person.name_first, person.name_middle, person.name_last, person.name_suffix]
        .map((p) => (p ?? '').trim())
        .filter(Boolean);
      fullName = parts.join(' ') || person.name_full;
    }
  } catch {
    // Person endpoint may not be accessible; fall through to null.
  }

  if (!fullName) return null;
  return findJudgeByName(fullName);
}

// ---------------------------------------------------------------------------
// Investments processing
// ---------------------------------------------------------------------------

/**
 * Fetch all investment positions for a single disclosure ID from CourtListener.
 */
async function fetchInvestmentsForDisclosure(
  disclosureId: number,
  token: string,
): Promise<ClInvestment[]> {
  const investments: ClInvestment[] = [];

  for await (const page of paginateClEndpoint<ClInvestment>(
    '/investments/',
    token,
    { financial_disclosure: String(disclosureId) },
  )) {
    investments.push(...page);
  }

  return investments;
}

/**
 * Process a page of investments for a single disclosure and accumulate into
 * the provided batch arrays.
 */
async function processInvestments(
  clInvestments: ClInvestment[],
  judgeId: string,
  judgeEntityId: string,
  disclosureDbId: string,
  disclosureYear: number,
  invBatch: InvestmentInsert[],
  relBatch: RelationshipInsert[],
): Promise<void> {
  for (const inv of clInvestments) {
    if (inv.redacted) continue;

    const assetName = inv.description?.trim() || 'Unknown Asset';
    const ticker = inv.ticker?.trim().toUpperCase() || null;

    const [valueLow, valueHigh] = decodeValueCode(inv.gross_value_code, GROSS_VALUE_RANGES);

    invBatch.push({
      judge_id: judgeId,
      disclosure_id: disclosureDbId,
      asset_name: assetName,
      ticker,
      value_range_low: valueLow,
      value_range_high: valueHigh,
    });

    // Create a 'holds_stock' relationship if there is a ticker.
    if (ticker) {
      const corpEntityId = await getOrCreateCorporationEntity(ticker, assetName);
      if (corpEntityId) {
        relBatch.push({
          source_entity_id: judgeEntityId,
          target_entity_id: corpEntityId,
          relationship_type: 'holds_stock',
          amount: valueLow,
          date_start: disclosureYear ? `${disclosureYear}-01-01` : null,
          metadata: {
            asset_name: assetName,
            gross_value_code: inv.gross_value_code ?? null,
            income_code: inv.income_during_reporting_period_code ?? null,
            transaction_type: inv.transaction_type ?? null,
            disclosure_year: disclosureYear,
            source: 'courtlistener',
          },
          confidence_score: 0.9,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importJudgeFinancials(): Promise<void> {
  console.log('=== Import Judge Financial Disclosures ===\n');

  const tokenEnv = process.env['COURTLISTENER_API_TOKEN'];
  if (!tokenEnv) {
    throw new Error(
      'Missing environment variable: COURTLISTENER_API_TOKEN\n' +
        'Obtain one at: https://www.courtlistener.com/sign-in/',
    );
  }
  const token: string = tokenEnv;

  const yearFrom = process.env['COURTLISTENER_YEAR_FROM']
    ? parseInt(process.env['COURTLISTENER_YEAR_FROM'], 10)
    : null;

  let totalDisclosures = 0;
  let totalInvestments = 0;
  let totalRelationships = 0;
  let totalSkipped = 0;

  const disclosureBatch: DisclosureInsert[] = [];
  const pendingDisclosures: Array<{
    judgeId: string;
    judgeEntityId: string;
    clDisclosureId: number;
    year: number;
  }> = [];

  // Flush disclosure batch, then fetch investments for each flushed disclosure.
  async function flushAndProcessDisclosures(): Promise<void> {
    if (disclosureBatch.length === 0) return;

    const disclosureIdMap = await flushDisclosures(disclosureBatch);
    totalDisclosures += disclosureIdMap.size;

    process.stdout.write(
      `  Flushed ${disclosureBatch.length} disclosures (upserted: ${disclosureIdMap.size})\n`,
    );

    const invBatch: InvestmentInsert[] = [];
    const relBatch: RelationshipInsert[] = [];

    for (const pending of pendingDisclosures) {
      const disclosureDbId = disclosureIdMap.get(
        `${pending.judgeId}:${pending.year}`,
      );

      if (!disclosureDbId) {
        // Already existed; look it up from the cache or re-query.
        const cacheKey = `${pending.judgeId}:${pending.year}`;
        let resolvedId = disclosureCache.get(cacheKey);
        if (!resolvedId) {
          const { data } = await supabase
            .from('judge_financial_disclosures')
            .select('id')
            .eq('judge_id', pending.judgeId)
            .eq('year', pending.year)
            .maybeSingle();
          resolvedId = data ? (data as { id: string }).id : undefined;
        }
        if (!resolvedId) {
          totalSkipped++;
          continue;
        }
        disclosureCache.set(cacheKey, resolvedId);
        // Fetch and process investments even for pre-existing disclosures so
        // that a partial previous run is always completed.
        const clInvestments = await fetchInvestmentsForDisclosure(
          pending.clDisclosureId,
          token,
        );
        await processInvestments(
          clInvestments,
          pending.judgeId,
          pending.judgeEntityId,
          resolvedId,
          pending.year,
          invBatch,
          relBatch,
        );
      } else {
        disclosureCache.set(`${pending.judgeId}:${pending.year}`, disclosureDbId);
        const clInvestments = await fetchInvestmentsForDisclosure(
          pending.clDisclosureId,
          token,
        );
        await processInvestments(
          clInvestments,
          pending.judgeId,
          pending.judgeEntityId,
          disclosureDbId,
          pending.year,
          invBatch,
          relBatch,
        );
      }

      // Flush investment and relationship batches when they fill up.
      if (invBatch.length >= BATCH_SIZE) {
        const { ok, err } = await flushInvestments(invBatch.splice(0, BATCH_SIZE));
        totalInvestments += ok;
        totalSkipped += err;
      }

      if (relBatch.length >= BATCH_SIZE) {
        const { ok, err } = await flushRelationships(relBatch.splice(0, BATCH_SIZE));
        totalRelationships += ok;
        totalSkipped += err;
      }
    }

    // Final flush for any remaining investments/relationships in this batch.
    if (invBatch.length > 0) {
      const { ok, err } = await flushInvestments(invBatch);
      totalInvestments += ok;
      totalSkipped += err;
    }

    if (relBatch.length > 0) {
      const { ok, err } = await flushRelationships(relBatch);
      totalRelationships += ok;
      totalSkipped += err;
    }

    disclosureBatch.length = 0;
    pendingDisclosures.length = 0;
  }

  // Build query params for the disclosures endpoint.
  const disclosureParams: Record<string, string> = {};
  if (yearFrom !== null) {
    disclosureParams['year__gte'] = String(yearFrom);
  }

  console.log('Fetching financial disclosures from CourtListener…');

  let pageCount = 0;

  for await (const page of paginateClEndpoint<ClDisclosure>(
    '/financial-disclosures/',
    token,
    disclosureParams,
  )) {
    pageCount++;
    process.stdout.write(`  Page ${pageCount}: ${page.length} disclosures\n`);

    for (const disclosure of page) {
      // Resolve CourtListener person → GovGuide judge.
      const judgeMatch = await resolvePersonToJudge(disclosure.person, token);

      if (!judgeMatch) {
        totalSkipped++;
        continue;
      }

      const { judgeId, entityId: judgeEntityId } = judgeMatch;

      // Skip years we've already fully processed in this run.
      if (disclosureCache.has(`${judgeId}:${disclosure.year}`)) {
        continue;
      }

      // Build the filing URL.  CourtListener provides an absolute_url
      // (HTML page) and a download_filepath (the actual PDF/document path).
      const filingUrl =
        disclosure.download_filepath
          ? `https://storage.courtlistener.com/${disclosure.download_filepath}`
          : disclosure.absolute_url
            ? `https://www.courtlistener.com${disclosure.absolute_url}`
            : null;

      disclosureBatch.push({
        judge_id: judgeId,
        year: disclosure.year,
        filing_url: filingUrl,
        parsed_data: {
          courtlistener_id: disclosure.id,
          report_type: disclosure.report_type,
          is_amended: disclosure.is_amended,
          has_been_extracted: disclosure.has_been_extracted,
          date_created: disclosure.date_created,
        },
      });

      pendingDisclosures.push({
        judgeId,
        judgeEntityId,
        clDisclosureId: disclosure.id,
        year: disclosure.year,
      });

      if (disclosureBatch.length >= BATCH_SIZE) {
        await flushAndProcessDisclosures();
      }
    }
  }

  // Flush any remaining disclosures.
  await flushAndProcessDisclosures();

  console.log(`\n  Pages fetched: ${pageCount}`);
  console.log(`  Disclosures upserted: ${totalDisclosures}`);
  console.log(`  Investments inserted: ${totalInvestments}`);
  console.log(`  Relationships upserted: ${totalRelationships}`);
  console.log(
    `\n=== Completed. skipped: ${totalSkipped} ===`,
  );
}

importJudgeFinancials().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
