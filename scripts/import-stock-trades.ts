/**
 * Import congressional stock trades and annual financial holdings from
 * House and Senate STOCK Act disclosures.
 *
 * Data source: Quiver Quantitative API (https://api.quiverquant.com)
 *   - House trades:   GET /beta/live/housetrading
 *   - Senate trades:  GET /beta/live/senatetrading
 *   - Holdings:       GET /beta/bulk/congressholdings
 *
 * The official source filings live at:
 *   House:   https://disclosures-clerk.house.gov/
 *   Senate:  https://efdsearch.senate.gov/
 *
 * Quiver aggregates those filings into a clean JSON API that is freely
 * accessible without authentication (rate limits apply).  Supplying
 * QUIVER_QUANT_API_KEY in the environment adds an Authorization header
 * that grants higher rate limits on a paid plan.
 *
 * Required environment variables:
 *   PUBLIC_SUPABASE_URL          – Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY    – Service-role key (bypasses RLS)
 *
 * Optional environment variables:
 *   QUIVER_QUANT_API_KEY         – Bearer token for higher rate limits
 *   IMPORT_YEAR                  – Calendar year filter applied in-process
 *                                  (Quiver returns all available records;
 *                                   we filter client-side). Default: current year.
 *   IMPORT_CHAMBER               – "house" | "senate" | "both" (default: "both")
 *   DRY_RUN                      – Set to "1" to skip DB writes and only log
 *
 * Run with:  npm run import:stock-trades
 *
 * What this script does:
 *   1. Fetches trade disclosures from the Quiver Quantitative API.
 *   2. Optionally filters to IMPORT_YEAR.
 *   3. Resolves each trade to an existing official via normalised name match.
 *   4. Calculates days_late = (disclosure_date − trade_date) − 45.
 *      The STOCK Act requires disclosure within 45 days of a trade.
 *   5. Upserts stock_trades rows in batches of 500.
 *   6. Fetches annual holdings and upserts official_holdings rows in batches of 500.
 *   7. For each trade that can be linked to a corporation entity (via ticker
 *      lookup in entity_corporations), upserts a relationships row of type
 *      'traded' linking the official's entity_id to the corporation entity_id.
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base URL for the Quiver Quantitative REST API. */
const QUIVER_API_BASE = 'https://api.quiverquant.com';

/** How many rows to accumulate before a batch upsert. */
const BATCH_SIZE = 500;

/** STOCK Act statutory disclosure window in calendar days. */
const STOCK_ACT_DISCLOSURE_DAYS = 45;

// ---------------------------------------------------------------------------
// Quiver API response shapes
// ---------------------------------------------------------------------------

/**
 * A single trade record as returned by Quiver Quantitative.
 * Field names follow the Quiver /beta/live/housetrading and
 * /beta/live/senatetrading response schema.
 */
interface QuiverTrade {
  /** Member name — House endpoint: "Representative"; Senate: "Senator". */
  Representative?: string;
  Senator?: string;
  /** Ticker symbol, e.g. "AAPL". */
  Ticker?: string;
  /** Human-readable asset name. */
  AssetName?: string;
  AssetDescription?: string;
  AssetType?: string;
  /** "Purchase", "Sale", "Sale (Full)", "Sale (Partial)", "Exchange" */
  Transaction?: string;
  /** Amount range, e.g. "$15,001 - $50,000". */
  Amount?: string;
  /** ISO date of the transaction. */
  TransactionDate?: string;
  Date?: string;
  /** ISO date the form was filed / disclosed. */
  FilingDate?: string;
  ReportDate?: string;
  /** Owner class: "Self", "Spouse", "Dependent", "Joint". */
  Owner?: string;
  Comment?: string;
  /** URL to the original PDF filing on the official portal. */
  Link?: string;
  [key: string]: unknown;
}

/**
 * A single annual-holdings record as returned by Quiver Quantitative.
 * Field names follow the /beta/bulk/congressholdings response schema.
 */
interface QuiverHolding {
  Representative?: string;
  Senator?: string;
  Ticker?: string;
  AssetName?: string;
  AssetDescription?: string;
  /** Value range, e.g. "$50,001 - $100,000". */
  Amount?: string;
  /** Four-digit year, e.g. 2024. */
  Year?: number | string;
  ReportYear?: number | string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// DB insert shapes
// ---------------------------------------------------------------------------

interface StockTradeInsert {
  official_id: string;
  ticker: string | null;
  asset_name: string | null;
  trade_type: 'purchase' | 'sale' | 'exchange';
  amount_range_low: number | null;
  amount_range_high: number | null;
  trade_date: string | null;
  disclosure_date: string | null;
  days_late: number | null;
  filing_url: string | null;
  metadata: Record<string, unknown>;
}

interface OfficialHoldingInsert {
  official_id: string;
  ticker: string | null;
  asset_name: string | null;
  value_range_low: number | null;
  value_range_high: number | null;
  disclosure_year: number;
  metadata: Record<string, unknown>;
}

interface RelationshipInsert {
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: 'traded';
  amount: number | null;
  date_start: string | null;
  metadata: Record<string, unknown>;
  confidence_score: number;
}

// ---------------------------------------------------------------------------
// Helpers — parsing
// ---------------------------------------------------------------------------

/**
 * Normalise a Quiver Transaction field to the three values the stock_trades
 * CHECK constraint allows: 'purchase', 'sale', 'exchange'.
 * Returns null for unrecognised values (trade is skipped).
 */
function normaliseTradeType(
  raw: string | null | undefined,
): 'purchase' | 'sale' | 'exchange' | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  if (lower === 'purchase' || lower === 'buy') return 'purchase';
  if (
    lower === 'sale' ||
    lower === 'sell' ||
    lower.startsWith('sale (')
  )
    return 'sale';
  if (lower === 'exchange') return 'exchange';
  return null;
}

/**
 * The STOCK Act mandates these specific dollar-range buckets.
 * We map them to numeric low/high pairs.  The Quiver API preserves the
 * original strings from the official filing forms.
 */
const AMOUNT_RANGE_MAP: Record<string, { low: number; high: number | null }> = {
  '$1,001 - $15,000':        { low: 1_001,    high: 15_000 },
  '$15,001 - $50,000':       { low: 15_001,   high: 50_000 },
  '$50,001 - $100,000':      { low: 50_001,   high: 100_000 },
  '$100,001 - $250,000':     { low: 100_001,  high: 250_000 },
  '$250,001 - $500,000':     { low: 250_001,  high: 500_000 },
  '$500,001 - $1,000,000':   { low: 500_001,  high: 1_000_000 },
  'Over $1,000,000':         { low: 1_000_001, high: null },
  // Variants without spaces around commas sometimes appear in the feed
  '$1001 - $15000':          { low: 1_001,    high: 15_000 },
  '$15001 - $50000':         { low: 15_001,   high: 50_000 },
  '$50001 - $100000':        { low: 50_001,   high: 100_000 },
  '$100001 - $250000':       { low: 100_001,  high: 250_000 },
  '$250001 - $500000':       { low: 250_001,  high: 500_000 },
  '$500001 - $1000000':      { low: 500_001,  high: 1_000_000 },
  'Over $1000000':           { low: 1_000_001, high: null },
};

/**
 * Parse an amount / value range string into low and high numeric bounds.
 * Returns { low: null, high: null } when the string is unrecognised.
 */
function parseAmountRange(
  raw: string | null | undefined,
): { low: number | null; high: number | null } {
  if (!raw) return { low: null, high: null };

  const trimmed = raw.trim();

  // Direct map lookup (covers ~99 % of real STOCK Act filings).
  const mapped = AMOUNT_RANGE_MAP[trimmed];
  if (mapped) return mapped;

  // Fallback: try to parse "X - Y" with numeric values after stripping $,.
  const clean = trimmed.replace(/[$,]/g, '');
  const rangeMatch = clean.match(/^(\d+)\s*-\s*(\d+)$/);
  if (rangeMatch) {
    return { low: Number(rangeMatch[1]), high: Number(rangeMatch[2]) };
  }

  const overMatch = clean.match(/^[Oo]ver\s+(\d+)$/);
  if (overMatch) {
    return { low: Number(overMatch[1]) + 1, high: null };
  }

  const single = Number(clean);
  if (!Number.isNaN(single) && single > 0) return { low: single, high: single };

  return { low: null, high: null };
}

/**
 * Parse an ISO-8601 date string into a Date, returning null on failure.
 */
function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Return the number of whole calendar days between two Date objects.
 * Positive when b is after a.
 */
function daysBetween(a: Date, b: Date): number {
  const MS_PER_DAY = 86_400_000;
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/**
 * Calculate how many days late a disclosure is relative to the STOCK Act
 * 45-day window.  Negative = on-time or early.  Null = dates unavailable.
 */
function calcDaysLate(
  tradeDate: string | null | undefined,
  disclosureDate: string | null | undefined,
): number | null {
  const trade = parseDate(tradeDate);
  const disclosure = parseDate(disclosureDate);
  if (!trade || !disclosure) return null;
  return daysBetween(trade, disclosure) - STOCK_ACT_DISCLOSURE_DAYS;
}

/**
 * Normalise a legislator name string to a lower-cased comparison key.
 * Strips titles, punctuation, and extra whitespace.
 */
function normaliseName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b(sen|rep|dr|mr|mrs|ms|jr|sr|ii|iii|iv)\.?\b/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// In-process caches
// ---------------------------------------------------------------------------

/** normalised full_name → officials.id */
const officialByNameCache = new Map<string, string>();
/** ticker (upper) → entity_id from entity_corporations */
const corpEntityByTickerCache = new Map<string, string>();
/** officials.id → entity_id from entities (officeholder entity) */
const officialEntityCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// DB helpers — official resolution
// ---------------------------------------------------------------------------

/**
 * Pre-load all officials into the in-process name cache.
 */
async function warmOfficialCaches(): Promise<void> {
  console.log('  Warming official lookup caches ...');

  let page = 0;
  const limit = 1000;
  let fetched = 0;

  while (true) {
    const { data, error } = await supabase
      .from('officials')
      .select('id, first_name, last_name, full_name')
      .range(page * limit, (page + 1) * limit - 1);

    if (error) {
      throw new Error(
        `Failed to load officials for cache warm: ${error.message}`,
      );
    }

    if (!data || data.length === 0) break;

    for (const row of data as {
      id: string;
      first_name: string | null;
      last_name: string | null;
      full_name: string | null;
    }[]) {
      if (row.full_name) {
        officialByNameCache.set(normaliseName(row.full_name), row.id);
      }
      // Also index "last, first" form since Quiver sometimes uses that.
      if (row.last_name && row.first_name) {
        const key = normaliseName(`${row.last_name} ${row.first_name}`);
        if (!officialByNameCache.has(key)) {
          officialByNameCache.set(key, row.id);
        }
      }
    }

    fetched += data.length;
    page++;
    if (data.length < limit) break;
  }

  console.log(
    `  Cached ${officialByNameCache.size} name variants across ${fetched} officials.`,
  );
}

/**
 * Resolve an official's database UUID from a raw Quiver name string.
 * Strategy:
 *   1. Cache hit on normalised name.
 *   2. DB ILIKE fallback on last name.
 *
 * Quiver names arrive as "Last, First" or "First Last"; we try both.
 */
async function resolveOfficialId(rawName: string): Promise<string | null> {
  const norm = normaliseName(rawName);

  const cached = officialByNameCache.get(norm);
  if (cached) return cached;

  // Decompose "Last, First" → try last_name + first_name match.
  const commaIdx = rawName.indexOf(',');
  if (commaIdx !== -1) {
    const lastName = rawName.slice(0, commaIdx).trim();
    const firstName = rawName
      .slice(commaIdx + 1)
      .trim()
      .split(/\s+/)[0];

    const { data } = await supabase
      .from('officials')
      .select('id')
      .ilike('last_name', lastName)
      .ilike('first_name', `${firstName}%`)
      .maybeSingle();

    if (data) {
      officialByNameCache.set(norm, (data as { id: string }).id);
      return (data as { id: string }).id;
    }
  }

  // Decompose "First Last" (last token = surname).
  const parts = rawName.trim().split(/\s+/);
  if (parts.length >= 2) {
    const firstName = parts[0];
    const lastName = parts[parts.length - 1];

    const { data } = await supabase
      .from('officials')
      .select('id')
      .ilike('last_name', lastName)
      .ilike('first_name', `${firstName}%`)
      .maybeSingle();

    if (data) {
      officialByNameCache.set(norm, (data as { id: string }).id);
      return (data as { id: string }).id;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// DB helpers — entity resolution
// ---------------------------------------------------------------------------

async function resolveOfficialEntityId(
  officialId: string,
): Promise<string | null> {
  const cached = officialEntityCache.get(officialId);
  if (cached) return cached;

  const { data } = await supabase
    .from('entities')
    .select('id')
    .contains('external_ids', { officials_id: officialId })
    .maybeSingle();

  if (data) {
    officialEntityCache.set(officialId, (data as { id: string }).id);
    return (data as { id: string }).id;
  }

  return null;
}

async function resolveCorpEntityId(
  ticker: string | null,
): Promise<string | null> {
  if (!ticker) return null;

  const upper = ticker.toUpperCase();
  const cached = corpEntityByTickerCache.get(upper);
  if (cached) return cached;

  const { data } = await supabase
    .from('entity_corporations')
    .select('entity_id')
    .eq('ticker', upper)
    .maybeSingle();

  if (data) {
    const id = (data as { entity_id: string }).entity_id;
    corpEntityByTickerCache.set(upper, id);
    return id;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Batch upsert helpers
// ---------------------------------------------------------------------------

async function flushTrades(
  batch: StockTradeInsert[],
  dryRun: boolean,
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  if (dryRun) {
    console.log(`  [DRY RUN] Would upsert ${batch.length} stock_trades rows`);
    return { ok: batch.length, err: 0 };
  }

  const { error } = await supabase.from('stock_trades').upsert(batch, {
    onConflict: 'official_id,ticker,trade_date,trade_type,amount_range_low',
    ignoreDuplicates: false,
  });

  if (error) {
    console.error(
      `  BATCH ERROR flushing ${batch.length} trades: ${error.message}`,
    );
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

async function flushHoldings(
  batch: OfficialHoldingInsert[],
  dryRun: boolean,
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  if (dryRun) {
    console.log(
      `  [DRY RUN] Would upsert ${batch.length} official_holdings rows`,
    );
    return { ok: batch.length, err: 0 };
  }

  const { error } = await supabase.from('official_holdings').upsert(batch, {
    onConflict: 'official_id,ticker,disclosure_year',
    ignoreDuplicates: false,
  });

  if (error) {
    console.error(
      `  BATCH ERROR flushing ${batch.length} holdings: ${error.message}`,
    );
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

async function flushRelationships(
  batch: RelationshipInsert[],
  dryRun: boolean,
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  if (dryRun) {
    console.log(
      `  [DRY RUN] Would upsert ${batch.length} relationships rows`,
    );
    return { ok: batch.length, err: 0 };
  }

  const { error } = await supabase.from('relationships').upsert(batch, {
    onConflict:
      'source_entity_id,target_entity_id,relationship_type,date_start',
    ignoreDuplicates: false,
  });

  if (error) {
    console.error(
      `  BATCH ERROR flushing ${batch.length} relationships: ${error.message}`,
    );
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

// ---------------------------------------------------------------------------
// Quiver Quantitative API — fetch helpers
// ---------------------------------------------------------------------------

/**
 * Build request headers for the Quiver API.
 * Without a key, requests are still accepted at a lower rate limit.
 */
function quiverHeaders(apiKey: string | null): HeadersInit {
  const headers: HeadersInit = { Accept: 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Token ${apiKey}`;
  }
  return headers;
}

/**
 * Fetch all trade disclosures for one chamber from the Quiver API.
 *
 * Endpoints:
 *   House:   GET https://api.quiverquant.com/beta/live/housetrading
 *   Senate:  GET https://api.quiverquant.com/beta/live/senatetrading
 *
 * Both return a flat JSON array (no pagination wrapper).
 */
async function fetchQuiverTrades(
  chamber: 'house' | 'senate',
  apiKey: string | null,
): Promise<QuiverTrade[]> {
  const endpoint =
    chamber === 'house' ? 'housetrading' : 'senatetrading';
  const url = `${QUIVER_API_BASE}/beta/live/${endpoint}`;

  console.log(`  [${chamber.toUpperCase()}] Fetching trades from ${url} ...`);

  const res = await fetch(url, { headers: quiverHeaders(apiKey) });

  if (!res.ok) {
    throw new Error(
      `Quiver API error ${res.status} ${res.statusText} fetching ${chamber} trades`,
    );
  }

  const data = (await res.json()) as unknown;

  if (!Array.isArray(data)) {
    throw new Error(
      `Unexpected response shape from ${url}: expected array, got ${typeof data}`,
    );
  }

  return data as QuiverTrade[];
}

/**
 * Fetch annual holdings disclosures from the Quiver API.
 *
 * Endpoint: GET https://api.quiverquant.com/beta/bulk/congressholdings
 *
 * Returns a flat JSON array covering both chambers; the caller filters by
 * year client-side since the endpoint does not support year parameters.
 */
async function fetchQuiverHoldings(
  apiKey: string | null,
): Promise<QuiverHolding[]> {
  const url = `${QUIVER_API_BASE}/beta/bulk/congressholdings`;

  console.log(`  Fetching holdings from ${url} ...`);

  const res = await fetch(url, { headers: quiverHeaders(apiKey) });

  if (!res.ok) {
    throw new Error(
      `Quiver API error ${res.status} ${res.statusText} fetching holdings`,
    );
  }

  const data = (await res.json()) as unknown;

  if (!Array.isArray(data)) {
    throw new Error(
      `Unexpected response shape from ${url}: expected array, got ${typeof data}`,
    );
  }

  return data as QuiverHolding[];
}

// ---------------------------------------------------------------------------
// Processing — trades
// ---------------------------------------------------------------------------

/**
 * Derive the member name from a QuiverTrade record.
 * House endpoint stores the name under "Representative"; Senate under "Senator".
 */
function getMemberName(
  trade: QuiverTrade,
  chamber: 'house' | 'senate',
): string {
  const name =
    chamber === 'house'
      ? trade.Representative ?? trade.Senator ?? ''
      : trade.Senator ?? trade.Representative ?? '';
  return name.trim();
}

/**
 * Return the ISO trade date from whichever Quiver field is populated.
 */
function getTradeDate(trade: QuiverTrade): string | null {
  return trade.TransactionDate ?? trade.Date ?? null;
}

/**
 * Return the ISO disclosure/filing date from whichever Quiver field is populated.
 */
function getFilingDate(trade: QuiverTrade): string | null {
  return trade.FilingDate ?? trade.ReportDate ?? null;
}

async function processTrades(
  trades: QuiverTrade[],
  chamber: 'house' | 'senate',
  filterYear: number | null,
  dryRun: boolean,
): Promise<{
  tradesOk: number;
  tradesErr: number;
  relsOk: number;
  relsErr: number;
}> {
  let tradesOk = 0;
  let tradesErr = 0;
  let relsOk = 0;
  let relsErr = 0;

  const tradeBatch: StockTradeInsert[] = [];
  const relBatch: RelationshipInsert[] = [];

  let skippedNoOfficial = 0;
  let skippedBadType = 0;
  let skippedNoTicker = 0;
  let skippedWrongYear = 0;

  for (const trade of trades) {
    // --- Year filter (client-side) ---
    if (filterYear !== null) {
      const tradeDate = getTradeDate(trade);
      if (!tradeDate || !tradeDate.startsWith(String(filterYear))) {
        skippedWrongYear++;
        continue;
      }
    }

    // --- Member name ---
    const rawName = getMemberName(trade, chamber);
    if (!rawName) {
      skippedNoOfficial++;
      continue;
    }

    // --- Resolve official ---
    const officialId = await resolveOfficialId(rawName);
    if (!officialId) {
      skippedNoOfficial++;
      if (skippedNoOfficial <= 5) {
        console.warn(
          `  WARN: No official found for "${rawName}" — skipping trade`,
        );
      }
      continue;
    }

    // --- Ticker ---
    const ticker = trade.Ticker ? trade.Ticker.trim().toUpperCase() : null;
    if (!ticker) {
      skippedNoTicker++;
      continue;
    }

    // --- Trade type ---
    const tradeType = normaliseTradeType(trade.Transaction);
    if (!tradeType) {
      skippedBadType++;
      if (skippedBadType <= 5) {
        console.warn(
          `  WARN: Unrecognised Transaction "${trade.Transaction ?? ''}" — skipping`,
        );
      }
      continue;
    }

    // --- Amount ---
    const { low: amountLow, high: amountHigh } = parseAmountRange(
      trade.Amount,
    );

    // --- Dates ---
    const tradeDate = getTradeDate(trade);
    const filingDate = getFilingDate(trade);
    const daysLate = calcDaysLate(tradeDate, filingDate);

    // --- Build stock_trades insert ---
    const { Representative: _r, Senator: _s, ...restMeta } = trade;
    const tradeInsert: StockTradeInsert = {
      official_id: officialId,
      ticker,
      asset_name:
        (trade.AssetName ?? trade.AssetDescription ?? null) || null,
      trade_type: tradeType,
      amount_range_low: amountLow,
      amount_range_high: amountHigh,
      trade_date: tradeDate,
      disclosure_date: filingDate,
      days_late: daysLate,
      filing_url: trade.Link ?? null,
      metadata: {
        ...restMeta,
        chamber,
        raw_name: rawName,
      } as Record<string, unknown>,
    };

    tradeBatch.push(tradeInsert);

    // --- Build relationship insert (official entity → corp entity) ---
    const corpEntityId = await resolveCorpEntityId(ticker);
    const officialEntityId = await resolveOfficialEntityId(officialId);

    if (corpEntityId && officialEntityId) {
      const relAmount =
        amountLow !== null && amountHigh !== null
          ? Math.round((amountLow + amountHigh) / 2)
          : (amountLow ?? null);

      relBatch.push({
        source_entity_id: officialEntityId,
        target_entity_id: corpEntityId,
        relationship_type: 'traded',
        amount: relAmount,
        date_start: tradeDate,
        metadata: {
          trade_type: tradeType,
          ticker,
          days_late: daysLate,
          chamber,
        },
        confidence_score: 1.0,
      });
    }

    // --- Flush trades batch ---
    if (tradeBatch.length >= BATCH_SIZE) {
      const { ok, err } = await flushTrades(
        tradeBatch.splice(0, BATCH_SIZE),
        dryRun,
      );
      tradesOk += ok;
      tradesErr += err;
      process.stdout.write(`  Flushed trade batch (ok=${ok}, err=${err})\n`);
    }

    // --- Flush relationships batch ---
    if (relBatch.length >= BATCH_SIZE) {
      const { ok, err } = await flushRelationships(
        relBatch.splice(0, BATCH_SIZE),
        dryRun,
      );
      relsOk += ok;
      relsErr += err;
      process.stdout.write(
        `  Flushed relationship batch (ok=${ok}, err=${err})\n`,
      );
    }
  }

  // Flush final partial batches
  if (tradeBatch.length > 0) {
    const { ok, err } = await flushTrades(tradeBatch, dryRun);
    tradesOk += ok;
    tradesErr += err;
    process.stdout.write(
      `  Flushed final trade batch (ok=${ok}, err=${err})\n`,
    );
  }

  if (relBatch.length > 0) {
    const { ok, err } = await flushRelationships(relBatch, dryRun);
    relsOk += ok;
    relsErr += err;
    process.stdout.write(
      `  Flushed final relationship batch (ok=${ok}, err=${err})\n`,
    );
  }

  if (skippedWrongYear > 0)
    console.log(`  Skipped ${skippedWrongYear} trades outside target year.`);
  if (skippedNoOfficial > 0)
    console.warn(
      `  WARN: ${skippedNoOfficial} trades skipped — no matching official found.`,
    );
  if (skippedBadType > 0)
    console.warn(
      `  WARN: ${skippedBadType} trades skipped — unrecognised transaction type.`,
    );
  if (skippedNoTicker > 0)
    console.log(`  Skipped ${skippedNoTicker} trades with no ticker.`);

  return { tradesOk, tradesErr, relsOk, relsErr };
}

// ---------------------------------------------------------------------------
// Processing — holdings
// ---------------------------------------------------------------------------

async function processHoldings(
  holdings: QuiverHolding[],
  chamber: 'house' | 'senate',
  filterYear: number | null,
  dryRun: boolean,
): Promise<{ ok: number; err: number }> {
  let totalOk = 0;
  let totalErr = 0;
  let skippedNoOfficial = 0;
  let skippedWrongYear = 0;

  const holdingBatch: OfficialHoldingInsert[] = [];

  for (const holding of holdings) {
    // --- Derive year ---
    const rawYear = holding.Year ?? holding.ReportYear ?? null;
    const disclosureYear = rawYear ? Number(rawYear) : null;

    if (filterYear !== null) {
      if (disclosureYear !== filterYear) {
        skippedWrongYear++;
        continue;
      }
    }

    if (!disclosureYear || Number.isNaN(disclosureYear)) continue;

    // --- Member name ---
    const rawName = (
      chamber === 'house'
        ? holding.Representative ?? holding.Senator ?? ''
        : holding.Senator ?? holding.Representative ?? ''
    ).trim();

    if (!rawName) {
      skippedNoOfficial++;
      continue;
    }

    const officialId = await resolveOfficialId(rawName);
    if (!officialId) {
      skippedNoOfficial++;
      if (skippedNoOfficial <= 5) {
        console.warn(
          `  WARN: No official found for "${rawName}" — skipping holding`,
        );
      }
      continue;
    }

    const { low: valueLow, high: valueHigh } = parseAmountRange(
      holding.Amount,
    );

    const { Representative: _r, Senator: _s, ...restMeta } = holding;

    holdingBatch.push({
      official_id: officialId,
      ticker: holding.Ticker ? holding.Ticker.trim().toUpperCase() : null,
      asset_name:
        (holding.AssetName ?? holding.AssetDescription ?? null) || null,
      value_range_low: valueLow,
      value_range_high: valueHigh,
      disclosure_year: disclosureYear,
      metadata: {
        ...restMeta,
        chamber,
        raw_name: rawName,
      } as Record<string, unknown>,
    });

    if (holdingBatch.length >= BATCH_SIZE) {
      const { ok, err } = await flushHoldings(
        holdingBatch.splice(0, BATCH_SIZE),
        dryRun,
      );
      totalOk += ok;
      totalErr += err;
      process.stdout.write(
        `  Flushed holding batch (ok=${ok}, err=${err})\n`,
      );
    }
  }

  if (holdingBatch.length > 0) {
    const { ok, err } = await flushHoldings(holdingBatch, dryRun);
    totalOk += ok;
    totalErr += err;
    process.stdout.write(
      `  Flushed final holding batch (ok=${ok}, err=${err})\n`,
    );
  }

  if (skippedWrongYear > 0)
    console.log(`  Skipped ${skippedWrongYear} holdings outside target year.`);
  if (skippedNoOfficial > 0)
    console.warn(
      `  WARN: ${skippedNoOfficial} holdings skipped — no matching official found.`,
    );

  return { ok: totalOk, err: totalErr };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importStockTrades(): Promise<void> {
  console.log('=== Import Congressional Stock Trades ===\n');

  const dryRun = process.env['DRY_RUN'] === '1';
  // QUIVER_QUANT_API_KEY is optional — requests work without it at a lower rate.
  const apiKey = process.env['QUIVER_QUANT_API_KEY'] ?? null;
  const importYearRaw = process.env['IMPORT_YEAR'];
  const filterYear = importYearRaw ? Number(importYearRaw) : new Date().getFullYear();
  const chamberEnv = (process.env['IMPORT_CHAMBER'] ?? 'both').toLowerCase();

  if (!['house', 'senate', 'both'].includes(chamberEnv)) {
    throw new Error(
      `Invalid IMPORT_CHAMBER value "${chamberEnv}". Must be "house", "senate", or "both".`,
    );
  }

  const chambers: Array<'house' | 'senate'> =
    chamberEnv === 'both'
      ? ['house', 'senate']
      : [chamberEnv as 'house' | 'senate'];

  if (dryRun) {
    console.log(
      '*** DRY RUN MODE — no database writes will be performed ***\n',
    );
  }

  console.log(`Import year  : ${filterYear}`);
  console.log(`Chamber(s)   : ${chambers.join(', ')}`);
  console.log(
    `API key      : ${apiKey ? 'set (higher rate limit)' : 'not set (unauthenticated, lower rate limit)'}\n`,
  );

  // --- Warm name caches ---
  await warmOfficialCaches();

  // --- Totals ---
  let totalTradesOk = 0;
  let totalTradesErr = 0;
  let totalRelsOk = 0;
  let totalRelsErr = 0;
  let totalHoldingsOk = 0;
  let totalHoldingsErr = 0;

  // --- Fetch holdings once (covers both chambers) ---
  let allHoldings: QuiverHolding[] = [];
  try {
    allHoldings = await fetchQuiverHoldings(apiKey);
    console.log(`  Fetched ${allHoldings.length} total holding records.\n`);
  } catch (err) {
    console.error(
      `  ERROR fetching holdings: ${(err as Error).message}`,
    );
  }

  // --- Process each chamber ---
  for (const chamber of chambers) {
    console.log(`\n--- ${chamber.toUpperCase()} (${filterYear}) ---`);

    // Trades
    let trades: QuiverTrade[] = [];
    try {
      trades = await fetchQuiverTrades(chamber, apiKey);
      console.log(
        `  Fetched ${trades.length} raw ${chamber} trade records.`,
      );
    } catch (err) {
      console.error(
        `  ERROR fetching ${chamber} trades: ${(err as Error).message}`,
      );
    }

    if (trades.length > 0) {
      console.log(`  Processing ${chamber} trades ...`);
      const { tradesOk, tradesErr, relsOk, relsErr } = await processTrades(
        trades,
        chamber,
        filterYear,
        dryRun,
      );
      totalTradesOk += tradesOk;
      totalTradesErr += tradesErr;
      totalRelsOk += relsOk;
      totalRelsErr += relsErr;
    }

    // Holdings (filter by chamber using Representative/Senator key presence)
    if (allHoldings.length > 0) {
      const chamberHoldings = allHoldings.filter((h) =>
        chamber === 'house'
          ? h.Representative !== undefined
          : h.Senator !== undefined,
      );
      console.log(
        `  Processing ${chamberHoldings.length} ${chamber} holding records ...`,
      );
      const { ok, err } = await processHoldings(
        chamberHoldings,
        chamber,
        filterYear,
        dryRun,
      );
      totalHoldingsOk += ok;
      totalHoldingsErr += err;
    }
  }

  // --- Summary ---
  console.log('\n=== Import Complete ===');
  console.log(
    `  stock_trades     : inserted/updated ${totalTradesOk}, errors ${totalTradesErr}`,
  );
  console.log(
    `  official_holdings: inserted/updated ${totalHoldingsOk}, errors ${totalHoldingsErr}`,
  );
  console.log(
    `  relationships    : inserted/updated ${totalRelsOk}, errors ${totalRelsErr}`,
  );
}

importStockTrades().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
