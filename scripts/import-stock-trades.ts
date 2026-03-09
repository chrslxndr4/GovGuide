/**
 * Import congressional stock trades and annual financial holdings from
 * House and Senate STOCK Act disclosures.
 *
 * Data source: Capitol Trades public API (https://www.capitoltrades.com)
 * which aggregates the official House and Senate eFD / FD filing portals.
 * The script accepts the canonical JSON shape emitted by that style of API
 * (see CapitolTradesTrade / CapitolTradesHolding interfaces below).  If the
 * upstream URL or shape ever changes, swap out the fetch helpers — all
 * database logic remains valid.
 *
 * Required environment variables:
 *   PUBLIC_SUPABASE_URL          – Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY    – Service-role key (bypasses RLS)
 *
 * Optional environment variables:
 *   CAPITOL_TRADES_API_KEY       – Bearer token if the API requires auth
 *   IMPORT_YEAR                  – Calendar year to import (default: current year)
 *   IMPORT_CHAMBER               – "house" | "senate" | "both" (default: "both")
 *   DRY_RUN                      – Set to "1" to skip DB writes and only log
 *
 * Run with:  npm run import:stock-trades
 *
 * What this script does:
 *   1. Fetches paginated trade disclosures from the Capitol Trades API.
 *   2. Resolves each trade to an existing official via bioguide_id (primary)
 *      or normalised full-name fuzzy match (fallback).
 *   3. Calculates days_late = (disclosure_date − trade_date) − 45.
 *      The STOCK Act requires disclosure within 45 days of a trade.
 *   4. Upserts stock_trades rows in batches of 500.
 *   5. Fetches annual holdings from the API and upserts official_holdings rows
 *      in batches of 500.
 *   6. For each trade that can be linked to a corporation entity (via ticker
 *      lookup in entity_corporations), upserts a relationships row of type
 *      'traded' linking the official's entity_id to the corporation entity_id.
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types — Capitol Trades / Quiver Quantitative API shape
// ---------------------------------------------------------------------------

/**
 * A single trade disclosure record as returned by the Capitol Trades API.
 * Field names follow the well-known JSON schema published by Capitol Trades.
 */
interface CapitolTradesTrade {
  /** Unique identifier for the filing transaction (used as upsert key). */
  filing_id: string;
  /** Legislator's Bioguide ID — the most reliable cross-reference key. */
  bioguide_id: string | null;
  /** Full name of the reporting official, e.g. "Pelosi, Nancy". */
  legislator: string;
  /** Ticker symbol, e.g. "AAPL".  Null for non-equity assets. */
  ticker: string | null;
  /** Human-readable asset name. */
  asset_name: string;
  /** "purchase" | "sale" | "sale_partial" | "exchange" */
  transaction_type: string;
  /**
   * Amount range encoded as a string such as "$1,001 - $15,000"
   * or a pre-parsed object with low/high fields.  Both shapes are handled.
   */
  amount: string | { low: number; high: number };
  /** ISO 8601 date string, e.g. "2024-03-15". */
  transaction_date: string;
  /** ISO 8601 date string when the disclosure was filed. */
  disclosure_date: string;
  /** URL to the original PDF filing on the House/Senate disclosure portal. */
  filing_url: string | null;
  /** Additional metadata the API may return. */
  [key: string]: unknown;
}

interface CapitolTradesTradeResponse {
  data: CapitolTradesTrade[];
  meta: {
    page: number;
    per_page: number;
    total_pages: number;
    total_count: number;
  };
}

/**
 * A single annual-holdings line item from a financial disclosure report.
 */
interface CapitolTradesHolding {
  bioguide_id: string | null;
  legislator: string;
  ticker: string | null;
  asset_name: string;
  /** Value range: string like "$50,001 - $100,000" or parsed object. */
  value: string | { low: number; high: number };
  /** Calendar year of the disclosure (e.g. 2023). */
  disclosure_year: number;
  [key: string]: unknown;
}

interface CapitolTradesHoldingResponse {
  data: CapitolTradesHolding[];
  meta: {
    page: number;
    per_page: number;
    total_pages: number;
    total_count: number;
  };
}

// ---------------------------------------------------------------------------
// DB insert shapes
// ---------------------------------------------------------------------------

interface StockTradeInsert {
  official_id: string;
  ticker: string | null;
  asset_name: string;
  trade_type: 'purchase' | 'sale' | 'exchange';
  amount_range_low: number | null;
  amount_range_high: number | null;
  trade_date: string;
  disclosure_date: string;
  days_late: number | null;
  filing_url: string | null;
  metadata: Record<string, unknown>;
}

interface OfficialHoldingInsert {
  official_id: string;
  ticker: string | null;
  asset_name: string;
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
// Constants
// ---------------------------------------------------------------------------

const CAPITOL_TRADES_API_BASE = 'https://api.capitoltrades.com/v1';
const PAGE_SIZE = 100;
const BATCH_SIZE = 500;
/** STOCK Act statutory disclosure window in calendar days. */
const STOCK_ACT_DISCLOSURE_DAYS = 45;

// ---------------------------------------------------------------------------
// Helpers — parsing
// ---------------------------------------------------------------------------

/**
 * Normalise the Capitol Trades transaction_type field to the three values the
 * stock_trades CHECK constraint allows.
 */
function normaliseTradeType(
  raw: string,
): 'purchase' | 'sale' | 'exchange' | null {
  const lower = raw.toLowerCase().replace(/[_\s-]+/g, '_');
  if (lower.startsWith('purchase') || lower === 'buy') return 'purchase';
  if (lower.startsWith('sale') || lower === 'sell') return 'sale';
  if (lower === 'exchange') return 'exchange';
  return null;
}

/**
 * Parse an amount / value range into low and high numeric bounds.
 *
 * Handles two shapes:
 *   - Object: { low: 1001, high: 15000 }
 *   - String: "$1,001 - $15,000" | "Over $1,000,000" | "$1,000,000+"
 */
function parseAmountRange(
  amount: string | { low: number; high: number },
): { low: number | null; high: number | null } {
  if (typeof amount === 'object' && amount !== null) {
    return { low: amount.low ?? null, high: amount.high ?? null };
  }

  const raw = String(amount);
  // Strip currency symbols, commas, whitespace
  const clean = raw.replace(/[$,\s]/g, '');

  // "$1,001 - $15,000"  →  "1001-15000"
  const rangeMatch = clean.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    return { low: Number(rangeMatch[1]), high: Number(rangeMatch[2]) };
  }

  // "Over$1,000,000" or "$1,000,000+"
  const overMatch = clean.match(/^[Oo]ver(\d+)$|^(\d+)\+$/);
  if (overMatch) {
    const val = Number(overMatch[1] ?? overMatch[2]);
    return { low: val, high: null };
  }

  // Single value
  const single = Number(clean);
  if (!Number.isNaN(single)) return { low: single, high: single };

  return { low: null, high: null };
}

/**
 * Parse an ISO-8601 date string into a Date, returning null on failure.
 * Accepts "YYYY-MM-DD" and "YYYY-MM-DDTHH:mm:ssZ" formats.
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
 * 45-day window.  Returns null when either date is unavailable.
 * Negative values mean the filing was on-time (or early).
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
 * Normalise a legislator full-name string to a lower-cased comparison key.
 * Strips punctuation, titles (Sen./Rep./Dr.), and extra whitespace.
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

/** bioguide_id → officials.id */
const officialByBioguideCache = new Map<string, string>();
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
 * Pre-load all officials that have a bioguide_id into the in-process caches.
 * This dramatically reduces per-trade round-trips for the common case.
 */
async function warmOfficialCaches(): Promise<void> {
  console.log('  Warming official lookup caches …');

  let page = 0;
  const limit = 1000;
  let fetched = 0;

  while (true) {
    const { data, error } = await supabase
      .from('officials')
      .select('id, bioguide_id, full_name')
      .range(page * limit, (page + 1) * limit - 1);

    if (error) {
      throw new Error(`Failed to load officials for cache warm: ${error.message}`);
    }

    if (!data || data.length === 0) break;

    for (const row of data as { id: string; bioguide_id: string | null; full_name: string }[]) {
      if (row.bioguide_id) {
        officialByBioguideCache.set(row.bioguide_id, row.id);
      }
      officialByNameCache.set(normaliseName(row.full_name), row.id);
    }

    fetched += data.length;
    page++;

    // If the page was not full we have retrieved everything
    if (data.length < limit) break;
  }

  console.log(
    `  Cached ${officialByBioguideCache.size} bioguide IDs, ` +
      `${officialByNameCache.size} name variants across ${fetched} officials.`,
  );
}

/**
 * Resolve an official's database UUID from a trade record.
 * Strategy:
 *   1. bioguide_id exact match (most reliable).
 *   2. Normalised full-name match against the officials table.
 *
 * Both lookups are served from the in-process cache after warmOfficialCaches().
 * Falls back to a DB query only on cache miss to handle officials added during
 * the same run.
 */
async function resolveOfficialId(
  bioguideId: string | null,
  legislatorName: string,
): Promise<string | null> {
  // 1. Bioguide exact match
  if (bioguideId) {
    const cached = officialByBioguideCache.get(bioguideId);
    if (cached) return cached;

    // DB fallback (official may have been inserted after cache warm)
    const { data } = await supabase
      .from('officials')
      .select('id')
      .eq('bioguide_id', bioguideId)
      .maybeSingle();

    if (data) {
      officialByBioguideCache.set(bioguideId, (data as { id: string }).id);
      return (data as { id: string }).id;
    }
  }

  // 2. Normalised name match
  const normName = normaliseName(legislatorName);
  const cachedByName = officialByNameCache.get(normName);
  if (cachedByName) return cachedByName;

  // DB fallback — use ilike for a case-insensitive partial match
  const { data } = await supabase
    .from('officials')
    .select('id, full_name')
    .ilike('full_name', `%${legislatorName.split(',')[0].trim()}%`)
    .limit(1)
    .maybeSingle();

  if (data) {
    const id = (data as { id: string }).id;
    officialByNameCache.set(normName, id);
    return id;
  }

  return null;
}

// ---------------------------------------------------------------------------
// DB helpers — entity resolution
// ---------------------------------------------------------------------------

/**
 * Look up the entities.id for an official (type='officeholder').
 * Officials may or may not have a corresponding entity row; we look for an
 * external_ids->>'officials_id' match first, then fall back to name search.
 *
 * Returns null when no entity row can be found (relationship is skipped).
 */
async function resolveOfficialEntityId(officialId: string): Promise<string | null> {
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

/**
 * Look up entity_corporations.entity_id for a ticker symbol.
 * Tickers are stored upper-cased in the schema (INDEX on ticker column).
 */
async function resolveCorpEntityId(ticker: string | null): Promise<string | null> {
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

  // There is no natural unique key exposed by the API that is guaranteed
  // unique across re-runs other than (official_id, ticker, trade_date,
  // trade_type, amount_range_low).  We use that composite to deduplicate.
  const { error } = await supabase.from('stock_trades').upsert(batch, {
    onConflict: 'official_id,ticker,trade_date,trade_type,amount_range_low',
    ignoreDuplicates: false,
  });

  if (error) {
    console.error(`  BATCH ERROR flushing ${batch.length} trades: ${error.message}`);
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
    console.log(`  [DRY RUN] Would upsert ${batch.length} official_holdings rows`);
    return { ok: batch.length, err: 0 };
  }

  const { error } = await supabase.from('official_holdings').upsert(batch, {
    onConflict: 'official_id,ticker,disclosure_year',
    ignoreDuplicates: false,
  });

  if (error) {
    console.error(`  BATCH ERROR flushing ${batch.length} holdings: ${error.message}`);
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
    console.log(`  [DRY RUN] Would upsert ${batch.length} relationships rows`);
    return { ok: batch.length, err: 0 };
  }

  // Deduplicate on the directed pair + type + date, allowing the same official
  // to appear in multiple trades of the same ticker on different dates.
  const { error } = await supabase.from('relationships').upsert(batch, {
    onConflict: 'source_entity_id,target_entity_id,relationship_type,date_start',
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
// Capitol Trades API — trades
// ---------------------------------------------------------------------------

/**
 * Build the URL for a page of trade disclosures.
 *
 * Query parameters follow the Capitol Trades public REST API convention:
 *   - year           : calendar year filter
 *   - chamber        : "house" | "senate"
 *   - page / per_page: standard pagination
 */
function buildTradesUrl(
  year: number,
  chamber: 'house' | 'senate',
  page: number,
  apiKey: string | null,
): string {
  const params = new URLSearchParams({
    year: String(year),
    chamber,
    page: String(page),
    per_page: String(PAGE_SIZE),
  });
  const url = `${CAPITOL_TRADES_API_BASE}/trades?${params.toString()}`;
  return apiKey
    ? `${url}&api_key=${encodeURIComponent(apiKey)}`
    : url;
}

/**
 * Fetch all trade disclosures for a given year and chamber.
 * Handles pagination transparently.
 */
async function fetchAllTrades(
  year: number,
  chamber: 'house' | 'senate',
  apiKey: string | null,
): Promise<CapitolTradesTrade[]> {
  const trades: CapitolTradesTrade[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = buildTradesUrl(year, chamber, page, apiKey);
    console.log(`  [${chamber.toUpperCase()}] Fetching trades page ${page}/${totalPages} …`);

    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });

    if (!res.ok) {
      if (res.status === 404) {
        console.warn(`  [${chamber}] 404 — no trade data for year ${year}`);
        break;
      }
      throw new Error(
        `Capitol Trades API error ${res.status} for ${chamber} year=${year} page=${page}: ` +
          res.statusText,
      );
    }

    const body = (await res.json()) as CapitolTradesTradeResponse;
    trades.push(...body.data);
    totalPages = body.meta.total_pages;
    page++;
  } while (page <= totalPages);

  console.log(
    `  [${chamber.toUpperCase()}] Fetched ${trades.length} trade records for ${year}.`,
  );
  return trades;
}

// ---------------------------------------------------------------------------
// Capitol Trades API — annual holdings
// ---------------------------------------------------------------------------

function buildHoldingsUrl(
  year: number,
  chamber: 'house' | 'senate',
  page: number,
  apiKey: string | null,
): string {
  const params = new URLSearchParams({
    year: String(year),
    chamber,
    page: String(page),
    per_page: String(PAGE_SIZE),
  });
  const url = `${CAPITOL_TRADES_API_BASE}/holdings?${params.toString()}`;
  return apiKey
    ? `${url}&api_key=${encodeURIComponent(apiKey)}`
    : url;
}

async function fetchAllHoldings(
  year: number,
  chamber: 'house' | 'senate',
  apiKey: string | null,
): Promise<CapitolTradesHolding[]> {
  const holdings: CapitolTradesHolding[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = buildHoldingsUrl(year, chamber, page, apiKey);
    console.log(
      `  [${chamber.toUpperCase()}] Fetching holdings page ${page}/${totalPages} …`,
    );

    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
    });

    if (!res.ok) {
      if (res.status === 404) {
        console.warn(`  [${chamber}] 404 — no holdings data for year ${year}`);
        break;
      }
      throw new Error(
        `Capitol Trades API error ${res.status} for ${chamber} holdings year=${year} page=${page}: ` +
          res.statusText,
      );
    }

    const body = (await res.json()) as CapitolTradesHoldingResponse;
    holdings.push(...body.data);
    totalPages = body.meta.total_pages;
    page++;
  } while (page <= totalPages);

  console.log(
    `  [${chamber.toUpperCase()}] Fetched ${holdings.length} holding records for ${year}.`,
  );
  return holdings;
}

// ---------------------------------------------------------------------------
// Processing — trades
// ---------------------------------------------------------------------------

async function processTrades(
  trades: CapitolTradesTrade[],
  dryRun: boolean,
): Promise<{ tradesOk: number; tradesErr: number; relsOk: number; relsErr: number }> {
  let tradesOk = 0;
  let tradesErr = 0;
  let relsOk = 0;
  let relsErr = 0;

  const tradeBatch: StockTradeInsert[] = [];
  const relBatch: RelationshipInsert[] = [];

  let skippedNoOfficial = 0;
  let skippedBadType = 0;

  for (const trade of trades) {
    // --- 1. Resolve official ---
    const officialId = await resolveOfficialId(
      trade.bioguide_id,
      trade.legislator,
    );

    if (!officialId) {
      skippedNoOfficial++;
      if (skippedNoOfficial <= 5) {
        console.warn(
          `  WARN: No official found for "${trade.legislator}" ` +
            `(bioguide=${trade.bioguide_id ?? 'n/a'}) — skipping trade`,
        );
      }
      continue;
    }

    // --- 2. Normalise trade type ---
    const tradeType = normaliseTradeType(trade.transaction_type);
    if (!tradeType) {
      skippedBadType++;
      if (skippedBadType <= 5) {
        console.warn(
          `  WARN: Unrecognised transaction_type "${trade.transaction_type}" — skipping`,
        );
      }
      continue;
    }

    // --- 3. Parse amount ---
    const { low: amountLow, high: amountHigh } = parseAmountRange(trade.amount);

    // --- 4. Calculate days_late ---
    const daysLate = calcDaysLate(trade.transaction_date, trade.disclosure_date);

    // --- 5. Build stock_trades insert ---
    // Preserve the raw API fields in metadata for auditability.
    const { bioguide_id: _b, legislator: _l, ...restMeta } = trade;
    const tradeInsert: StockTradeInsert = {
      official_id: officialId,
      ticker: trade.ticker ?? null,
      asset_name: trade.asset_name,
      trade_type: tradeType,
      amount_range_low: amountLow,
      amount_range_high: amountHigh,
      trade_date: trade.transaction_date,
      disclosure_date: trade.disclosure_date,
      days_late: daysLate,
      filing_url: trade.filing_url ?? null,
      metadata: restMeta as Record<string, unknown>,
    };

    tradeBatch.push(tradeInsert);

    // --- 6. Build relationship insert (official entity → corp entity) ---
    if (trade.ticker) {
      const corpEntityId = await resolveCorpEntityId(trade.ticker);
      const officialEntityId = await resolveOfficialEntityId(officialId);

      if (corpEntityId && officialEntityId) {
        // Use the midpoint of the range as the relationship amount, or low.
        const relAmount =
          amountLow !== null && amountHigh !== null
            ? Math.round((amountLow + amountHigh) / 2)
            : (amountLow ?? null);

        relBatch.push({
          source_entity_id: officialEntityId,
          target_entity_id: corpEntityId,
          relationship_type: 'traded',
          amount: relAmount,
          date_start: trade.transaction_date,
          metadata: {
            trade_type: tradeType,
            ticker: trade.ticker,
            days_late: daysLate,
            filing_id: trade.filing_id,
          },
          confidence_score: 1.0,
        });
      }
    }

    // --- Flush trades batch ---
    if (tradeBatch.length >= BATCH_SIZE) {
      const { ok, err } = await flushTrades(tradeBatch.splice(0, BATCH_SIZE), dryRun);
      tradesOk += ok;
      tradesErr += err;
      process.stdout.write(`  Flushed trade batch (ok=${ok}, err=${err})\n`);
    }

    // --- Flush relationships batch ---
    if (relBatch.length >= BATCH_SIZE) {
      const { ok, err } = await flushRelationships(relBatch.splice(0, BATCH_SIZE), dryRun);
      relsOk += ok;
      relsErr += err;
      process.stdout.write(`  Flushed relationship batch (ok=${ok}, err=${err})\n`);
    }
  }

  // Flush final partial batches
  if (tradeBatch.length > 0) {
    const { ok, err } = await flushTrades(tradeBatch, dryRun);
    tradesOk += ok;
    tradesErr += err;
    process.stdout.write(`  Flushed final trade batch (ok=${ok}, err=${err})\n`);
  }

  if (relBatch.length > 0) {
    const { ok, err } = await flushRelationships(relBatch, dryRun);
    relsOk += ok;
    relsErr += err;
    process.stdout.write(`  Flushed final relationship batch (ok=${ok}, err=${err})\n`);
  }

  if (skippedNoOfficial > 0) {
    console.warn(
      `  WARN: ${skippedNoOfficial} trades skipped — no matching official found.`,
    );
  }
  if (skippedBadType > 0) {
    console.warn(
      `  WARN: ${skippedBadType} trades skipped — unrecognised transaction_type.`,
    );
  }

  return { tradesOk, tradesErr, relsOk, relsErr };
}

// ---------------------------------------------------------------------------
// Processing — holdings
// ---------------------------------------------------------------------------

async function processHoldings(
  holdings: CapitolTradesHolding[],
  dryRun: boolean,
): Promise<{ ok: number; err: number }> {
  let totalOk = 0;
  let totalErr = 0;
  let skippedNoOfficial = 0;

  const holdingBatch: OfficialHoldingInsert[] = [];

  for (const holding of holdings) {
    const officialId = await resolveOfficialId(
      holding.bioguide_id,
      holding.legislator,
    );

    if (!officialId) {
      skippedNoOfficial++;
      if (skippedNoOfficial <= 5) {
        console.warn(
          `  WARN: No official found for "${holding.legislator}" — skipping holding`,
        );
      }
      continue;
    }

    const { low: valueLow, high: valueHigh } = parseAmountRange(holding.value);
    const { bioguide_id: _b, legislator: _l, ...restMeta } = holding;

    holdingBatch.push({
      official_id: officialId,
      ticker: holding.ticker ?? null,
      asset_name: holding.asset_name,
      value_range_low: valueLow,
      value_range_high: valueHigh,
      disclosure_year: holding.disclosure_year,
      metadata: restMeta as Record<string, unknown>,
    });

    if (holdingBatch.length >= BATCH_SIZE) {
      const { ok, err } = await flushHoldings(holdingBatch.splice(0, BATCH_SIZE), dryRun);
      totalOk += ok;
      totalErr += err;
      process.stdout.write(`  Flushed holding batch (ok=${ok}, err=${err})\n`);
    }
  }

  if (holdingBatch.length > 0) {
    const { ok, err } = await flushHoldings(holdingBatch, dryRun);
    totalOk += ok;
    totalErr += err;
    process.stdout.write(`  Flushed final holding batch (ok=${ok}, err=${err})\n`);
  }

  if (skippedNoOfficial > 0) {
    console.warn(
      `  WARN: ${skippedNoOfficial} holdings skipped — no matching official found.`,
    );
  }

  return { ok: totalOk, err: totalErr };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importStockTrades(): Promise<void> {
  console.log('=== Import Congressional Stock Trades ===\n');

  // --- Environment configuration ---
  const dryRun = process.env['DRY_RUN'] === '1';
  const apiKey = process.env['CAPITOL_TRADES_API_KEY'] ?? null;
  const importYear =
    Number(process.env['IMPORT_YEAR']) || new Date().getFullYear();
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
    console.log('*** DRY RUN MODE — no database writes will be performed ***\n');
  }

  console.log(`Import year  : ${importYear}`);
  console.log(`Chamber(s)   : ${chambers.join(', ')}`);
  console.log(`API key      : ${apiKey ? 'set' : 'not set (public endpoints only)'}\n`);

  // --- Warm caches ---
  await warmOfficialCaches();

  // --- Accumulate totals ---
  let totalTradesOk = 0;
  let totalTradesErr = 0;
  let totalRelsOk = 0;
  let totalRelsErr = 0;
  let totalHoldingsOk = 0;
  let totalHoldingsErr = 0;

  // --- Process each chamber ---
  for (const chamber of chambers) {
    console.log(`\n--- ${chamber.toUpperCase()} (${importYear}) ---`);

    // Trades
    let trades: CapitolTradesTrade[] = [];
    try {
      trades = await fetchAllTrades(importYear, chamber, apiKey);
    } catch (err) {
      console.error(
        `  ERROR fetching ${chamber} trades: ${(err as Error).message}`,
      );
    }

    if (trades.length > 0) {
      console.log(`  Processing ${trades.length} trades …`);
      const { tradesOk, tradesErr, relsOk, relsErr } = await processTrades(
        trades,
        dryRun,
      );
      totalTradesOk += tradesOk;
      totalTradesErr += tradesErr;
      totalRelsOk += relsOk;
      totalRelsErr += relsErr;
    }

    // Annual holdings
    let holdings: CapitolTradesHolding[] = [];
    try {
      holdings = await fetchAllHoldings(importYear, chamber, apiKey);
    } catch (err) {
      console.error(
        `  ERROR fetching ${chamber} holdings: ${(err as Error).message}`,
      );
    }

    if (holdings.length > 0) {
      console.log(`  Processing ${holdings.length} holdings …`);
      const { ok, err } = await processHoldings(holdings, dryRun);
      totalHoldingsOk += ok;
      totalHoldingsErr += err;
    }
  }

  // --- Summary ---
  console.log('\n=== Import Complete ===');
  console.log(
    `  stock_trades    : inserted/updated ${totalTradesOk}, errors ${totalTradesErr}`,
  );
  console.log(
    `  official_holdings: inserted/updated ${totalHoldingsOk}, errors ${totalHoldingsErr}`,
  );
  console.log(
    `  relationships   : inserted/updated ${totalRelsOk}, errors ${totalRelsErr}`,
  );
}

importStockTrades().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
