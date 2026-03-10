/**
 * Import ticker metadata from SEC EDGAR for every ticker found in stock_trades
 * that does not already have a row in ticker_metadata.
 *
 * Data sources:
 *   Company tickers index:
 *     https://www.sec.gov/files/company_tickers.json
 *     Returns a flat object keyed by ordinal → { cik_str, ticker, title }.
 *     Downloaded once and cached in-memory for the duration of the run.
 *
 *   Per-company submission feed:
 *     https://data.sec.gov/submissions/CIK{10-digit-padded-cik}.json
 *     Contains sic, sicDescription, exchanges, and other company metadata.
 *
 * Required environment variables:
 *   PUBLIC_SUPABASE_URL       — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Service-role key (bypasses RLS)
 *
 * Optional environment variables:
 *   DRY_RUN — Set to "1" to skip DB writes and only log counts
 *
 * Run with:  npm run import:tickers
 *
 * SEC EDGAR fair-use policy:
 *   - Maximum 10 requests per second (we rate-limit to 100 ms between calls)
 *   - User-Agent header must identify the application and a contact e-mail
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EDGAR_USER_AGENT = 'GovGuide/1.0 (thegovguide@gmail.com)';
const COMPANY_TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SUBMISSIONS_URL_BASE = 'https://data.sec.gov/submissions';
const BATCH_SIZE = 100;
const RATE_LIMIT_MS = 100; // 10 req/s max per EDGAR policy
const DRY_RUN = process.env.DRY_RUN === '1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CompanyTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

/** Shape of the company_tickers.json response (keys are ordinal strings). */
type CompanyTickersJson = Record<string, CompanyTickerEntry>;

interface EdgarSubmission {
  cik: string;
  name: string;
  sic: string | null;
  sicDescription: string | null;
  exchanges: string[] | null;
  // There are many more fields; we only type what we use.
  [key: string]: unknown;
}

interface TickerMetadataInsert {
  ticker: string;
  company_name: string | null;
  sic_code: string | null;
  sic_description: string | null;
  sector: string | null;
  exchange: string | null;
  cik: string | null;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// SIC → Sector lookup
// ---------------------------------------------------------------------------

function sicToSector(sic: string | null | undefined): string | null {
  if (!sic) return null;
  const code = parseInt(sic, 10);
  if (isNaN(code)) return null;

  if (code >= 100 && code <= 999) return 'Agriculture';
  if (code >= 1000 && code <= 1499) return 'Mining';
  if (code >= 1500 && code <= 1799) return 'Construction';
  if (code >= 2000 && code <= 3999) return 'Manufacturing';
  if (code >= 4000 && code <= 4999) return 'Transportation & Utilities';
  if (code >= 5000 && code <= 5199) return 'Wholesale Trade';
  if (code >= 5200 && code <= 5999) return 'Retail Trade';
  if (code >= 6000 && code <= 6799) return 'Finance, Insurance & Real Estate';
  if (code >= 7000 && code <= 8999) return 'Services';
  if (code >= 9100 && code <= 9999) return 'Public Administration';
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pause for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch with the SEC EDGAR required User-Agent header. */
async function edgarFetch(url: string): Promise<Response> {
  return fetch(url, {
    headers: {
      'User-Agent': EDGAR_USER_AGENT,
      Accept: 'application/json',
    },
  });
}

/** Pad a CIK integer to 10 digits with leading zeros. */
function padCik(cik: number | string): string {
  return String(cik).padStart(10, '0');
}

// ---------------------------------------------------------------------------
// EDGAR data fetchers
// ---------------------------------------------------------------------------

/** Download and return the full company-tickers index (cached in-memory). */
async function fetchCompanyTickersIndex(): Promise<Map<string, CompanyTickerEntry>> {
  console.log('  Downloading SEC EDGAR company tickers index …');
  const res = await edgarFetch(COMPANY_TICKERS_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch company_tickers.json: ${res.status} ${res.statusText}`,
    );
  }

  const raw = (await res.json()) as CompanyTickersJson;
  const index = new Map<string, CompanyTickerEntry>();

  for (const entry of Object.values(raw)) {
    // Normalize ticker to upper-case so lookups are case-insensitive.
    index.set(entry.ticker.toUpperCase(), entry);
  }

  console.log(`  Loaded ${index.size.toLocaleString()} tickers from EDGAR index.`);
  return index;
}

/**
 * Fetch per-company submission data for a given CIK.
 * Returns null if the request fails (e.g. CIK not found).
 */
async function fetchSubmission(cik: number | string): Promise<EdgarSubmission | null> {
  const padded = padCik(cik);
  const url = `${SUBMISSIONS_URL_BASE}/CIK${padded}.json`;

  const res = await edgarFetch(url);
  if (!res.ok) {
    console.warn(`    WARN: ${url} returned ${res.status} — skipping`);
    return null;
  }

  return res.json() as Promise<EdgarSubmission>;
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/** Return the list of tickers in stock_trades that are absent from ticker_metadata. */
async function fetchMissingTickers(): Promise<string[]> {
  // We use a raw SQL query via rpc to do an efficient NOT IN / LEFT JOIN approach.
  // However the Supabase JS client doesn't expose arbitrary SQL directly on the
  // client, so we fall back to fetching both sets and diffing in JS — which is
  // fine for the typical cardinality here (hundreds of distinct tickers).

  const [tradesResult, metaResult] = await Promise.all([
    supabase.from('stock_trades').select('ticker').throwOnError(),
    supabase.from('ticker_metadata').select('ticker').throwOnError(),
  ]);

  const existingTickers = new Set(
    (metaResult.data ?? []).map((row: { ticker: string }) => row.ticker.toUpperCase()),
  );

  const allTickers = new Set(
    (tradesResult.data ?? []).map((row: { ticker: string }) => row.ticker.toUpperCase()),
  );

  const missing = [...allTickers].filter((t) => !existingTickers.has(t));
  return missing;
}

/**
 * Upsert a batch of ticker metadata rows.
 * Conflicts on `ticker` are resolved by updating all other columns.
 */
async function upsertBatch(batch: TickerMetadataInsert[]): Promise<void> {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would upsert ${batch.length} rows`);
    return;
  }

  const { error } = await supabase
    .from('ticker_metadata')
    .upsert(batch, { onConflict: 'ticker' });

  if (error) {
    throw new Error(`Batch upsert failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importTickerMetadata(): Promise<void> {
  console.log('=== Import Ticker Metadata (SEC EDGAR) ===\n');

  if (DRY_RUN) {
    console.log('  [DRY RUN] Mode active — no DB writes will occur.\n');
  }

  // 1. Find tickers that need enrichment.
  console.log('Step 1/3: Querying stock_trades for missing tickers …');
  const missingTickers = await fetchMissingTickers();

  if (missingTickers.length === 0) {
    console.log('  All tickers already have metadata. Nothing to do.');
    return;
  }

  console.log(`  Found ${missingTickers.length} tickers to enrich.\n`);

  // 2. Download the EDGAR company tickers index once.
  console.log('Step 2/3: Fetching EDGAR company tickers index …');
  const tickerIndex = await fetchCompanyTickersIndex();
  console.log();

  // 3. For each missing ticker, resolve CIK → fetch submission → build row.
  console.log('Step 3/3: Enriching tickers via EDGAR submissions API …');

  const batch: TickerMetadataInsert[] = [];
  let processed = 0;
  let notFound = 0;
  let errors = 0;
  let upserted = 0;

  for (const ticker of missingTickers) {
    const entry = tickerIndex.get(ticker.toUpperCase());

    if (!entry) {
      console.log(`  [NOT FOUND] ${ticker} — not in EDGAR index`);
      notFound++;

      // Still insert a minimal row so we don't re-query it on subsequent runs.
      batch.push({
        ticker,
        company_name: null,
        sic_code: null,
        sic_description: null,
        sector: null,
        exchange: null,
        cik: null,
        metadata: { source: 'edgar', not_found_in_index: true },
      });
    } else {
      // Fetch the per-company submission JSON for SIC + exchange data.
      try {
        await sleep(RATE_LIMIT_MS);

        const submission = await fetchSubmission(entry.cik_str);

        const sic = submission?.sic ?? null;
        const sicDescription = submission?.sicDescription ?? null;
        const exchange =
          Array.isArray(submission?.exchanges) && submission!.exchanges!.length > 0
            ? submission!.exchanges![0]
            : null;

        batch.push({
          ticker,
          company_name: entry.title,
          sic_code: sic,
          sic_description: sicDescription,
          sector: sicToSector(sic),
          exchange,
          cik: String(entry.cik_str),
          metadata: {
            source: 'edgar',
            cik_padded: padCik(entry.cik_str),
            all_exchanges: submission?.exchanges ?? [],
          },
        });

        process.stdout.write('.');
      } catch (err) {
        console.error(`\n  ERROR enriching ${ticker}: ${(err as Error).message}`);
        errors++;

        // Push a minimal row so we don't retry indefinitely on future runs.
        batch.push({
          ticker,
          company_name: entry.title,
          sic_code: null,
          sic_description: null,
          sector: null,
          exchange: null,
          cik: String(entry.cik_str),
          metadata: {
            source: 'edgar',
            cik_padded: padCik(entry.cik_str),
            fetch_error: (err as Error).message,
          },
        });
      }
    }

    processed++;

    // Flush batch when full.
    if (batch.length >= BATCH_SIZE) {
      await upsertBatch(batch);
      upserted += batch.length;
      batch.length = 0;
    }
  }

  // Flush remaining rows.
  if (batch.length > 0) {
    await upsertBatch(batch);
    upserted += batch.length;
  }

  console.log('\n');
  console.log('=== Completed ===');
  console.log(`  Total tickers processed : ${processed}`);
  console.log(`  Upserted to DB          : ${upserted}`);
  console.log(`  Not found in EDGAR index: ${notFound}`);
  console.log(`  Fetch errors            : ${errors}`);
}

importTickerMetadata().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
