/**
 * Import prediction market contracts and trades from Kalshi and Polymarket.
 *
 * Kalshi (REST):
 *   Base URL: https://trading-api.kalshi.com/trade-api/v2
 *   GET /markets                  — paginated list of contracts
 *   GET /markets/{ticker}/trades  — individual trades per contract
 *
 *   Requires environment variable: KALSHI_API_KEY
 *   Obtain at: https://kalshi.com/account/api
 *
 * Polymarket (GraphQL):
 *   Endpoint: https://gamma-api.polymarket.com/query
 *   No auth required for public market data.
 *
 * Processing logic:
 *   1. Fetch all active Kalshi markets (paginated via cursor) and upsert them
 *      into prediction_contracts with platform='kalshi'.
 *   2. For each Kalshi contract, fetch recent trades and upsert into
 *      prediction_trades.
 *   3. Fetch Polymarket markets via GraphQL and upsert into
 *      prediction_contracts with platform='polymarket'.
 *   4. For each Polymarket market, fetch recent trades (which include
 *      wallet_address for on-chain anomaly detection) and upsert into
 *      prediction_trades.
 *   All upserts use external_id (platform + ticker/marketId) as the conflict
 *   key and are batched in groups of BATCH_SIZE.
 *
 * Run with:  npm run import:predictions
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types — shared DB shapes
// ---------------------------------------------------------------------------

interface PredictionContractInsert {
  platform: string;
  question: string;
  category: string | null;
  current_probability: number | null;
  volume_total: number | null;
  open_date: string | null;
  close_date: string | null;
  resolved: boolean;
  resolution: string | null;
  external_id: string;
  metadata: Record<string, unknown>;
}

interface PredictionTradeInsert {
  contract_id: string;
  trade_timestamp: string;
  price: number | null;
  size: number | null;
  side: 'buy' | 'sell';
  wallet_address: string | null;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Types — Kalshi API
// ---------------------------------------------------------------------------

interface KalshiMarket {
  ticker: string;
  title: string;
  category: string | null;
  yes_bid: number | null;    // current YES price in cents (0–100)
  yes_ask: number | null;
  volume: number | null;
  open_time: string | null;  // ISO timestamp
  close_time: string | null;
  status: string;            // 'open' | 'closed' | 'settled'
  result: string | null;     // 'yes' | 'no' | null
}

interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor: string | null;
}

interface KalshiTrade {
  trade_id: string;
  ticker: string;
  created_time: string;     // ISO timestamp
  yes_price: number;        // cents (0–100)
  count: number;            // number of contracts
  taker_side: string;       // 'yes' | 'no'
}

interface KalshiTradesResponse {
  trades: KalshiTrade[];
  cursor: string | null;
}

// ---------------------------------------------------------------------------
// Types — Polymarket GraphQL
// ---------------------------------------------------------------------------

interface PolymarketMarket {
  id: string;
  question: string;
  category: string | null;
  outcomePrices: string | null;  // JSON-encoded array, e.g. '["0.62","0.38"]'
  volume: string | null;
  startDate: string | null;
  endDate: string | null;
  closed: boolean;
  resolution: string | null;
}

interface PolymarketMarketsResponse {
  data: {
    markets: PolymarketMarket[];
  };
}

interface PolymarketTrade {
  id: string;
  timestamp: string;       // ISO timestamp
  price: string;           // decimal, e.g. "0.62"
  size: string;
  side: string;            // 'BUY' | 'SELL'
  transactionHash: string | null;
  trader: string | null;   // wallet address
}

interface PolymarketTradesResponse {
  data: {
    trades: PolymarketTrade[];
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KALSHI_API_BASE = 'https://trading-api.kalshi.com/trade-api/v2';
const POLYMARKET_GRAPHQL = 'https://gamma-api.polymarket.com/query';
const BATCH_SIZE = 500;
/** Maximum trades to fetch per contract (prevents runaway requests). */
const MAX_TRADES_PER_CONTRACT = 1000;
/** Kalshi API rate-limit: pause this many ms between trade-fetch calls. */
const KALSHI_TRADE_DELAY_MS = 200;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nullableDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Accept ISO timestamps and extract the date portion.
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1]! : null;
}

function clamp5_4(value: number): number {
  // NUMERIC(5,4) max is 9.9999 — probabilities should be in [0, 1].
  return Math.min(9.9999, Math.max(0, Math.round(value * 10000) / 10000));
}

/**
 * Map a Kalshi market category string to the prediction_contracts category
 * vocabulary.  Unmapped values are stored verbatim (the column is free-text).
 */
function mapKalshiCategory(raw: string | null): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes('election') || lower.includes('politics')) return 'election';
  if (lower.includes('legislat') || lower.includes('bill') || lower.includes('congress')) return 'legislation';
  if (lower.includes('policy') || lower.includes('regulat')) return 'policy';
  if (lower.includes('geo') || lower.includes('war') || lower.includes('conflict')) return 'geopolitical';
  return raw;
}

function mapPolymarketCategory(raw: string | null): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes('election') || lower.includes('politics')) return 'election';
  if (lower.includes('legislat') || lower.includes('bill')) return 'legislation';
  if (lower.includes('policy')) return 'policy';
  if (lower.includes('geo') || lower.includes('war')) return 'geopolitical';
  return raw;
}

/** Tiny delay to respect rate limits between paginated calls. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Batch upsert helpers
// ---------------------------------------------------------------------------

async function flushContracts(
  batch: PredictionContractInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  // external_id alone is not unique across platforms — use the composite
  // (platform, external_id) index defined in the migration for deduplication.
  // Supabase upsert requires a single column or named constraint.  We rely on
  // the migration's unique index idx_pred_external covering (platform, external_id);
  // if your Supabase version requires an explicit UNIQUE constraint, add one in
  // a follow-up migration.
  const { error } = await supabase
    .from('prediction_contracts')
    .upsert(batch, { onConflict: 'platform,external_id', ignoreDuplicates: false });

  if (error) {
    console.error(
      `  BATCH ERROR flushing ${batch.length} contracts: ${error.message}`,
    );
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

async function flushTrades(
  batch: PredictionTradeInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  // Trades have no natural unique key from the API so we insert without
  // a conflict target to avoid silent data loss.  Re-running the script on the
  // same time window will produce duplicates; callers should either truncate the
  // trades table or track a high-water-mark cursor.
  const { error } = await supabase.from('prediction_trades').insert(batch);

  if (error) {
    console.error(
      `  BATCH ERROR flushing ${batch.length} trades: ${error.message}`,
    );
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

// ---------------------------------------------------------------------------
// Contract ID resolution
// ---------------------------------------------------------------------------

/**
 * Fetch the internal UUID for a freshly upserted contract so we can link
 * trades to it.  Results are cached in-memory for the duration of the run.
 */
const contractIdCache = new Map<string, string>(); // "platform:external_id" → UUID

async function resolveContractId(
  platform: string,
  externalId: string,
): Promise<string | null> {
  const cacheKey = `${platform}:${externalId}`;
  if (contractIdCache.has(cacheKey)) return contractIdCache.get(cacheKey)!;

  const { data, error } = await supabase
    .from('prediction_contracts')
    .select('id')
    .eq('platform', platform)
    .eq('external_id', externalId)
    .maybeSingle();

  if (error || !data) {
    console.warn(
      `  WARNING: Could not resolve contract id for ${platform}/${externalId}: ${error?.message ?? 'not found'}`,
    );
    return null;
  }

  const id = (data as { id: string }).id;
  contractIdCache.set(cacheKey, id);
  return id;
}

// ---------------------------------------------------------------------------
// Kalshi API
// ---------------------------------------------------------------------------

async function fetchKalshiMarkets(apiKey: string): Promise<KalshiMarket[]> {
  const markets: KalshiMarket[] = [];
  let cursor: string | null = null;

  do {
    const url = new URL(`${KALSHI_API_BASE}/markets`);
    url.searchParams.set('limit', '200');
    if (cursor) url.searchParams.set('cursor', cursor);

    console.log(`  Kalshi /markets cursor=${cursor ?? 'start'} …`);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(
        `Kalshi /markets returned ${res.status}: ${res.statusText}`,
      );
    }

    const body = (await res.json()) as KalshiMarketsResponse;
    markets.push(...body.markets);
    cursor = body.cursor ?? null;
  } while (cursor);

  console.log(`  Total Kalshi markets fetched: ${markets.length}`);
  return markets;
}

async function fetchKalshiTrades(
  ticker: string,
  apiKey: string,
): Promise<KalshiTrade[]> {
  const trades: KalshiTrade[] = [];
  let cursor: string | null = null;
  let fetched = 0;

  do {
    const url = new URL(`${KALSHI_API_BASE}/markets/${encodeURIComponent(ticker)}/trades`);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      // 404 is expected for tickers that have been delisted.
      if (res.status === 404) break;
      console.warn(
        `  WARNING: Kalshi /markets/${ticker}/trades returned ${res.status} — skipping`,
      );
      break;
    }

    const body = (await res.json()) as KalshiTradesResponse;
    trades.push(...body.trades);
    fetched += body.trades.length;
    cursor = body.cursor ?? null;

    if (fetched >= MAX_TRADES_PER_CONTRACT) break;
    if (body.trades.length === 0) break;
  } while (cursor);

  return trades;
}

/**
 * Map a Kalshi yes_price (0–100 integer representing cents) to a probability
 * in the NUMERIC(5,4) range [0, 1].
 */
function kalshiPriceToProbability(yesBid: number | null, yesAsk: number | null): number | null {
  const price = yesBid !== null && yesAsk !== null
    ? (yesBid + yesAsk) / 2
    : yesBid ?? yesAsk ?? null;
  if (price === null) return null;
  return clamp5_4(price / 100);
}

async function importKalshi(apiKey: string): Promise<void> {
  console.log('\n--- Kalshi ---');

  const markets = await fetchKalshiMarkets(apiKey);
  if (markets.length === 0) {
    console.log('  No Kalshi markets found.');
    return;
  }

  // -------------------------------------------------------------------------
  // Upsert contracts.
  // -------------------------------------------------------------------------

  let contractsInserted = 0;
  let contractsError = 0;
  let contractBatch: PredictionContractInsert[] = [];

  for (const market of markets) {
    const probability = kalshiPriceToProbability(market.yes_bid, market.yes_ask);
    const isSettled = market.status === 'settled';

    contractBatch.push({
      platform: 'kalshi',
      question: market.title,
      category: mapKalshiCategory(market.category),
      current_probability: probability,
      volume_total: market.volume ?? null,
      open_date: nullableDate(market.open_time),
      close_date: nullableDate(market.close_time),
      resolved: isSettled,
      resolution: market.result ?? null,
      external_id: market.ticker,
      metadata: {
        status: market.status,
        yes_bid: market.yes_bid,
        yes_ask: market.yes_ask,
      },
    });

    if (contractBatch.length >= BATCH_SIZE) {
      const { ok, err } = await flushContracts(contractBatch.splice(0, BATCH_SIZE));
      contractsInserted += ok;
      contractsError += err;
      process.stdout.write(`  Flushed Kalshi contract batch (ok=${ok}, err=${err})\n`);
    }
  }

  if (contractBatch.length > 0) {
    const { ok, err } = await flushContracts(contractBatch);
    contractsInserted += ok;
    contractsError += err;
    process.stdout.write(`  Flushed final Kalshi contract batch (ok=${ok}, err=${err})\n`);
  }

  console.log(`  Kalshi contracts: inserted/updated=${contractsInserted}, errors=${contractsError}`);

  // -------------------------------------------------------------------------
  // Fetch and upsert trades for each contract.
  // -------------------------------------------------------------------------

  let tradesInserted = 0;
  let tradesError = 0;
  let tradeBatch: PredictionTradeInsert[] = [];

  for (const market of markets) {
    const contractId = await resolveContractId('kalshi', market.ticker);
    if (!contractId) continue;

    await sleep(KALSHI_TRADE_DELAY_MS);
    const trades = await fetchKalshiTrades(market.ticker, apiKey);

    for (const trade of trades) {
      // Kalshi taker_side is 'yes' (bet on YES) or 'no' (bet on NO).
      // Map to 'buy'/'sell' relative to the YES outcome.
      const side: 'buy' | 'sell' =
        trade.taker_side.toLowerCase() === 'yes' ? 'buy' : 'sell';

      tradeBatch.push({
        contract_id: contractId,
        trade_timestamp: trade.created_time,
        price: clamp5_4(trade.yes_price / 100),
        size: trade.count,
        side,
        wallet_address: null,
        metadata: { trade_id: trade.trade_id, ticker: trade.ticker },
      });

      if (tradeBatch.length >= BATCH_SIZE) {
        const { ok, err } = await flushTrades(tradeBatch.splice(0, BATCH_SIZE));
        tradesInserted += ok;
        tradesError += err;
      }
    }

    if (trades.length > 0) {
      process.stdout.write('.');
    }
  }

  if (tradeBatch.length > 0) {
    const { ok, err } = await flushTrades(tradeBatch);
    tradesInserted += ok;
    tradesError += err;
  }

  console.log(
    `\n  Kalshi trades: inserted=${tradesInserted}, errors=${tradesError}`,
  );
}

// ---------------------------------------------------------------------------
// Polymarket GraphQL API
// ---------------------------------------------------------------------------

/**
 * GraphQL fragment reused across market and trade queries.
 */
const POLYMARKET_MARKET_FRAGMENT = `
  id
  question
  category: eventType
  outcomePrices
  volume
  startDate
  endDate
  closed
  resolution: resolvedOutcome
`;

async function graphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const res = await fetch(POLYMARKET_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(
      `Polymarket GraphQL HTTP ${res.status}: ${res.statusText}`,
    );
  }

  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };

  if (json.errors?.length) {
    throw new Error(
      `Polymarket GraphQL errors: ${json.errors.map((e) => e.message).join('; ')}`,
    );
  }

  if (!json.data) {
    throw new Error('Polymarket GraphQL: empty response data');
  }

  return json.data;
}

async function fetchPolymarketMarkets(
  first: number,
  skip: number,
): Promise<PolymarketMarket[]> {
  const query = `
    query GetMarkets($first: Int!, $skip: Int!) {
      markets(first: $first, skip: $skip, orderBy: createdAt, orderDirection: desc) {
        ${POLYMARKET_MARKET_FRAGMENT}
      }
    }
  `;

  const data = await graphql<PolymarketMarketsResponse['data']>(query, {
    first,
    skip,
  });

  return data.markets ?? [];
}

async function fetchPolymarketTrades(
  marketId: string,
  first: number,
  skip: number,
): Promise<PolymarketTrade[]> {
  const query = `
    query GetTrades($marketId: String!, $first: Int!, $skip: Int!) {
      trades(
        where: { market: $marketId }
        first: $first
        skip: $skip
        orderBy: timestamp
        orderDirection: desc
      ) {
        id
        timestamp
        price
        size
        side
        transactionHash
        trader
      }
    }
  `;

  type TradesData = { trades: PolymarketTrade[] };
  const data = await graphql<TradesData>(query, { marketId, first, skip });
  return data.trades ?? [];
}

/**
 * Parse the outcomePrices field from Polymarket.
 * It is a JSON-encoded array of decimal strings, e.g. '["0.62","0.38"]'.
 * We treat the first element as the YES/primary outcome probability.
 */
function parsePolymarketProbability(outcomePrices: string | null): number | null {
  if (!outcomePrices) return null;
  try {
    const prices = JSON.parse(outcomePrices) as string[];
    const first = parseFloat(prices[0] ?? '');
    return Number.isFinite(first) ? clamp5_4(first) : null;
  } catch {
    return null;
  }
}

async function importPolymarket(): Promise<void> {
  console.log('\n--- Polymarket ---');

  const PAGE_SIZE = 200;
  let skip = 0;
  let totalFetched = 0;
  let contractsInserted = 0;
  let contractsError = 0;
  let tradesInserted = 0;
  let tradesError = 0;

  let pageMarkets: PolymarketMarket[];

  do {
    console.log(`  Polymarket markets skip=${skip} …`);

    try {
      pageMarkets = await fetchPolymarketMarkets(PAGE_SIZE, skip);
    } catch (err) {
      console.error(
        `  ERROR fetching Polymarket markets at skip=${skip}: ${(err as Error).message}`,
      );
      break;
    }

    if (pageMarkets.length === 0) break;
    totalFetched += pageMarkets.length;

    // -----------------------------------------------------------------------
    // Upsert contract records for this page.
    // -----------------------------------------------------------------------

    const contractBatch: PredictionContractInsert[] = pageMarkets.map((market) => ({
      platform: 'polymarket',
      question: market.question,
      category: mapPolymarketCategory(market.category),
      current_probability: parsePolymarketProbability(market.outcomePrices),
      volume_total: market.volume !== null ? parseFloat(market.volume ?? '') || null : null,
      open_date: nullableDate(market.startDate),
      close_date: nullableDate(market.endDate),
      resolved: market.closed,
      resolution: market.resolution ?? null,
      external_id: market.id,
      metadata: { outcome_prices: market.outcomePrices },
    }));

    // Batch in groups of BATCH_SIZE (page is already ≤ 200 but be defensive).
    for (let i = 0; i < contractBatch.length; i += BATCH_SIZE) {
      const slice = contractBatch.slice(i, i + BATCH_SIZE);
      const { ok, err } = await flushContracts(slice);
      contractsInserted += ok;
      contractsError += err;
    }

    process.stdout.write(`  Upserted ${pageMarkets.length} Polymarket contracts\n`);

    // -----------------------------------------------------------------------
    // Fetch trades for each contract on this page.
    // -----------------------------------------------------------------------

    for (const market of pageMarkets) {
      const contractId = await resolveContractId('polymarket', market.id);
      if (!contractId) continue;

      let tradeSkip = 0;
      let tradeBatch: PredictionTradeInsert[] = [];
      let totalTradesForMarket = 0;

      do {
        let pageTrades: PolymarketTrade[];
        try {
          pageTrades = await fetchPolymarketTrades(market.id, 100, tradeSkip);
        } catch (err) {
          console.warn(
            `  WARNING: Could not fetch trades for Polymarket market ${market.id}: ${(err as Error).message}`,
          );
          break;
        }

        if (pageTrades.length === 0) break;

        for (const trade of pageTrades) {
          const side: 'buy' | 'sell' =
            trade.side.toUpperCase() === 'BUY' ? 'buy' : 'sell';

          tradeBatch.push({
            contract_id: contractId,
            trade_timestamp: trade.timestamp,
            price: clamp5_4(parseFloat(trade.price)),
            size: parseFloat(trade.size),
            side,
            wallet_address: trade.trader ?? null,
            metadata: {
              trade_id: trade.id,
              transaction_hash: trade.transactionHash,
            },
          });

          if (tradeBatch.length >= BATCH_SIZE) {
            const { ok, err } = await flushTrades(tradeBatch.splice(0, BATCH_SIZE));
            tradesInserted += ok;
            tradesError += err;
          }
        }

        totalTradesForMarket += pageTrades.length;
        tradeSkip += pageTrades.length;

        if (totalTradesForMarket >= MAX_TRADES_PER_CONTRACT) break;
      } while (true);

      // Flush remaining trades for this market.
      if (tradeBatch.length > 0) {
        const { ok, err } = await flushTrades(tradeBatch);
        tradesInserted += ok;
        tradesError += err;
        tradeBatch = [];
      }

      if (totalTradesForMarket > 0) process.stdout.write('.');
    }

    skip += pageMarkets.length;
  } while (pageMarkets.length === PAGE_SIZE);

  console.log(`\n  Polymarket total markets fetched: ${totalFetched}`);
  console.log(
    `  Polymarket contracts: inserted/updated=${contractsInserted}, errors=${contractsError}`,
  );
  console.log(
    `  Polymarket trades: inserted=${tradesInserted}, errors=${tradesError}`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importPredictions(): Promise<void> {
  console.log('=== Import Prediction Markets ===\n');

  const kalshiApiKey = process.env.KALSHI_API_KEY;
  if (!kalshiApiKey) {
    throw new Error(
      'Missing environment variable: KALSHI_API_KEY\n' +
        'Obtain an API key at https://kalshi.com/account/api',
    );
  }

  // --- Kalshi ---
  try {
    await importKalshi(kalshiApiKey);
  } catch (err) {
    console.error(`\nERROR during Kalshi import: ${(err as Error).message}`);
    // Continue to Polymarket even if Kalshi fails.
  }

  // --- Polymarket ---
  // Polymarket does not require an API key for public data.
  try {
    await importPolymarket();
  } catch (err) {
    console.error(`\nERROR during Polymarket import: ${(err as Error).message}`);
  }

  // Each platform sub-function prints its own per-source summary.
  // The cache size gives a rough cross-platform contract count.
  console.log(
    `\n=== Completed. Total contracts resolved: ${contractIdCache.size}. ===`,
  );
}

importPredictions().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
