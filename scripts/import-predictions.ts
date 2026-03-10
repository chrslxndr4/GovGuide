/**
 * Import prediction market contracts and trades from Kalshi and Polymarket.
 *
 * Kalshi (REST + RSA-PSS auth):
 *   Base URL: https://api.elections.kalshi.com/trade-api/v2
 *   GET /markets                  — paginated list of contracts
 *   GET /markets/{ticker}/trades  — individual trades per contract
 *
 *   Requires environment variables:
 *     KALSHI_API_KEY           — API key ID from kalshi.com/account/api
 *     KALSHI_PRIVATE_KEY_PATH  — path to RSA private key PEM file
 *
 * Polymarket (REST — Gamma API):
 *   Base URL: https://gamma-api.polymarket.com
 *   GET /markets   — paginated market list
 *   GET /events    — paginated event list
 *   No auth required for public market data.
 *
 * Processing logic:
 *   1. Fetch Kalshi markets (paginated via cursor), upsert into
 *      prediction_contracts with platform='kalshi'.
 *   2. For each Kalshi contract, fetch recent trades and insert into
 *      prediction_trades.
 *   3. Fetch Polymarket markets via REST and upsert into
 *      prediction_contracts with platform='polymarket'.
 *   4. Polymarket trade data from CLOB API (wallet tracking for anomaly
 *      detection) is fetched per-market.
 *   All upserts use (platform, external_id) as the conflict key and are
 *   batched in groups of BATCH_SIZE.
 *
 * Run with:  npm run import:predictions
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
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
// Types — Polymarket REST (Gamma API)
// ---------------------------------------------------------------------------

interface PolymarketMarket {
  id: string;
  condition_id: string;
  question_id: string;
  question: string;
  slug: string;
  category: string | null;
  outcomePrices: string | null;  // JSON-encoded array, e.g. '["0.62","0.38"]'
  volume: string | null;
  volume_num: number | null;
  startDate: string | null;
  endDate: string | null;
  closed: boolean;
  active: boolean;
  archived: boolean;
  resolvedBy: string | null;
  resolution: string | null;
}

interface PolymarketClobTrade {
  id: string;
  timestamp: number;         // unix seconds
  price: string;             // decimal, e.g. "0.62"
  size: string;
  side: string;              // 'BUY' | 'SELL'
  asset_id: string;
  owner: string;             // wallet address
  transaction_hash: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KALSHI_API_BASE = process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2';
const POLYMARKET_GAMMA_BASE = 'https://gamma-api.polymarket.com';
const POLYMARKET_CLOB_BASE = process.env.POLYMARKET_CLOB_API || 'https://clob.polymarket.com';
const BATCH_SIZE = 500;
const MAX_TRADES_PER_CONTRACT = 1000;
const KALSHI_TRADE_DELAY_MS = 200;

// ---------------------------------------------------------------------------
// Kalshi RSA-PSS Authentication
// ---------------------------------------------------------------------------

let kalshiPrivateKey: crypto.KeyObject | null = null;

function loadKalshiPrivateKey(): crypto.KeyObject {
  if (kalshiPrivateKey) return kalshiPrivateKey;

  const keyPath = process.env.KALSHI_PRIVATE_KEY_PATH;
  if (!keyPath) {
    throw new Error(
      'Missing environment variable: KALSHI_PRIVATE_KEY_PATH\n' +
        'Set it to the path of your RSA private key PEM file.',
    );
  }

  const resolved = path.resolve(keyPath);
  const pem = fs.readFileSync(resolved, 'utf-8');
  kalshiPrivateKey = crypto.createPrivateKey(pem);
  return kalshiPrivateKey;
}

function signKalshiRequest(
  method: string,
  pathWithoutQuery: string,
  timestampMs: number,
): string {
  const privateKey = loadKalshiPrivateKey();
  const message = `${timestampMs}${method.toUpperCase()}${pathWithoutQuery}`;

  const signer = crypto.createSign('SHA256');
  signer.update(message);
  signer.end();

  const signature = signer.sign({
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  return signature.toString('base64');
}

function kalshiHeaders(method: string, urlPath: string): Record<string, string> {
  const apiKey = process.env.KALSHI_API_KEY!;
  const timestampMs = Date.now();
  // Strip query params for signing — sign only the path portion.
  const pathOnly = urlPath.split('?')[0]!;
  const signature = signKalshiRequest(method, pathOnly, timestampMs);

  return {
    'KALSHI-ACCESS-KEY': apiKey,
    'KALSHI-ACCESS-TIMESTAMP': String(timestampMs),
    'KALSHI-ACCESS-SIGNATURE': signature,
    'Content-Type': 'application/json',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nullableDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1]! : null;
}

function clamp5_4(value: number): number {
  return Math.min(9.9999, Math.max(0, Math.round(value * 10000) / 10000));
}

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

const contractIdCache = new Map<string, string>();

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

async function fetchKalshiMarketsPage(cursor: string | null): Promise<KalshiMarketsResponse> {
  const urlPath = '/trade-api/v2/markets';
  const url = new URL(`${KALSHI_API_BASE}/markets`);
  url.searchParams.set('limit', '200');
  if (cursor) url.searchParams.set('cursor', cursor);

  const res = await fetch(url.toString(), {
    headers: kalshiHeaders('GET', urlPath),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Kalshi /markets returned ${res.status}: ${res.statusText}\n${body}`,
    );
  }

  return (await res.json()) as KalshiMarketsResponse;
}

async function fetchKalshiTrades(ticker: string): Promise<KalshiTrade[]> {
  const trades: KalshiTrade[] = [];
  let cursor: string | null = null;
  let fetched = 0;

  do {
    const encodedTicker = encodeURIComponent(ticker);
    const urlPath = `/trade-api/v2/markets/${encodedTicker}/trades`;
    const url = new URL(`${KALSHI_API_BASE}/markets/${encodedTicker}/trades`);
    url.searchParams.set('limit', '100');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString(), {
      headers: kalshiHeaders('GET', urlPath),
    });

    if (!res.ok) {
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

function kalshiPriceToProbability(yesBid: number | null, yesAsk: number | null): number | null {
  const price = yesBid !== null && yesAsk !== null
    ? (yesBid + yesAsk) / 2
    : yesBid ?? yesAsk ?? null;
  if (price === null) return null;
  return clamp5_4(price / 100);
}

async function importKalshi(): Promise<void> {
  console.log('\n--- Kalshi ---');

  let cursor: string | null = null;
  let totalFetched = 0;
  let contractsInserted = 0;
  let contractsError = 0;
  let tradesInserted = 0;
  let tradesError = 0;

  do {
    console.log(`  Kalshi /markets cursor=${cursor ?? 'start'} …`);

    const page = await fetchKalshiMarketsPage(cursor);
    const markets = page.markets;
    if (markets.length === 0) break;
    totalFetched += markets.length;

    // Upsert contracts for this page.
    const contractBatch: PredictionContractInsert[] = markets.map((market) => {
      const probability = kalshiPriceToProbability(market.yes_bid, market.yes_ask);
      return {
        platform: 'kalshi',
        question: market.title,
        category: mapKalshiCategory(market.category),
        current_probability: probability,
        volume_total: market.volume ?? null,
        open_date: nullableDate(market.open_time),
        close_date: nullableDate(market.close_time),
        resolved: market.status === 'settled',
        resolution: market.result ?? null,
        external_id: market.ticker,
        metadata: {
          status: market.status,
          yes_bid: market.yes_bid,
          yes_ask: market.yes_ask,
        },
      };
    });

    for (let i = 0; i < contractBatch.length; i += BATCH_SIZE) {
      const slice = contractBatch.slice(i, i + BATCH_SIZE);
      const { ok, err } = await flushContracts(slice);
      contractsInserted += ok;
      contractsError += err;
    }

    process.stdout.write(`  Upserted ${markets.length} Kalshi contracts (total: ${totalFetched})\n`);

    // Fetch trades for each contract on this page.
    for (const market of markets) {
      const contractId = await resolveContractId('kalshi', market.ticker);
      if (!contractId) continue;

      await sleep(KALSHI_TRADE_DELAY_MS);
      const trades = await fetchKalshiTrades(market.ticker);

      const tradeBatch: PredictionTradeInsert[] = [];
      for (const trade of trades) {
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
      }

      if (tradeBatch.length > 0) {
        for (let i = 0; i < tradeBatch.length; i += BATCH_SIZE) {
          const slice = tradeBatch.slice(i, i + BATCH_SIZE);
          const { ok, err } = await flushTrades(slice);
          tradesInserted += ok;
          tradesError += err;
        }
        process.stdout.write('.');
      }
    }

    cursor = page.cursor ?? null;
  } while (cursor);

  console.log(`\n  Kalshi total markets fetched: ${totalFetched}`);
  console.log(`  Kalshi contracts: inserted/updated=${contractsInserted}, errors=${contractsError}`);
  console.log(`  Kalshi trades: inserted=${tradesInserted}, errors=${tradesError}`);
}

// ---------------------------------------------------------------------------
// Polymarket REST API (Gamma + CLOB)
// ---------------------------------------------------------------------------

async function fetchPolymarketMarketsPage(
  limit: number,
  offset: number,
): Promise<PolymarketMarket[]> {
  const url = new URL(`${POLYMARKET_GAMMA_BASE}/markets`);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('order', 'volume_24hr');
  url.searchParams.set('ascending', 'false');

  const res = await fetch(url.toString());

  if (!res.ok) {
    throw new Error(
      `Polymarket /markets returned ${res.status}: ${res.statusText}`,
    );
  }

  return (await res.json()) as PolymarketMarket[];
}

async function fetchPolymarketClobTrades(
  conditionId: string,
  limit: number,
): Promise<PolymarketClobTrade[]> {
  const url = new URL(`${POLYMARKET_CLOB_BASE}/trades`);
  url.searchParams.set('condition_id', conditionId);
  url.searchParams.set('limit', String(limit));

  const res = await fetch(url.toString());

  if (!res.ok) {
    if (res.status === 404) return [];
    console.warn(
      `  WARNING: Polymarket CLOB /trades for ${conditionId} returned ${res.status} — skipping`,
    );
    return [];
  }

  const body = await res.json();
  // CLOB API may return trades directly as array or nested.
  if (Array.isArray(body)) return body as PolymarketClobTrade[];
  if (body && Array.isArray(body.data)) return body.data as PolymarketClobTrade[];
  return [];
}

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

  const PAGE_SIZE = 100;
  let offset = 0;
  let totalFetched = 0;
  let contractsInserted = 0;
  let contractsError = 0;
  let tradesInserted = 0;
  let tradesError = 0;

  let pageMarkets: PolymarketMarket[];

  do {
    console.log(`  Polymarket /markets offset=${offset} …`);

    try {
      pageMarkets = await fetchPolymarketMarketsPage(PAGE_SIZE, offset);
    } catch (err) {
      console.error(
        `  ERROR fetching Polymarket markets at offset=${offset}: ${(err as Error).message}`,
      );
      break;
    }

    if (pageMarkets.length === 0) break;
    totalFetched += pageMarkets.length;

    // Upsert contract records for this page.
    const contractBatch: PredictionContractInsert[] = pageMarkets.map((market) => ({
      platform: 'polymarket',
      question: market.question,
      category: mapPolymarketCategory(market.category),
      current_probability: parsePolymarketProbability(market.outcomePrices),
      volume_total: market.volume_num ?? (market.volume !== null ? parseFloat(market.volume ?? '') || null : null),
      open_date: nullableDate(market.startDate),
      close_date: nullableDate(market.endDate),
      resolved: market.closed,
      resolution: market.resolution ?? null,
      external_id: market.id,
      metadata: {
        outcome_prices: market.outcomePrices,
        slug: market.slug,
        condition_id: market.condition_id,
        active: market.active,
      },
    }));

    for (let i = 0; i < contractBatch.length; i += BATCH_SIZE) {
      const slice = contractBatch.slice(i, i + BATCH_SIZE);
      const { ok, err } = await flushContracts(slice);
      contractsInserted += ok;
      contractsError += err;
    }

    process.stdout.write(`  Upserted ${pageMarkets.length} Polymarket contracts\n`);

    // Fetch trades for each contract using CLOB API (includes wallet addresses).
    for (const market of pageMarkets) {
      if (!market.condition_id) continue;

      const contractId = await resolveContractId('polymarket', market.id);
      if (!contractId) continue;

      let trades: PolymarketClobTrade[];
      try {
        trades = await fetchPolymarketClobTrades(
          market.condition_id,
          Math.min(100, MAX_TRADES_PER_CONTRACT),
        );
      } catch (err) {
        console.warn(
          `  WARNING: Could not fetch trades for Polymarket market ${market.id}: ${(err as Error).message}`,
        );
        continue;
      }

      if (trades.length === 0) continue;

      const tradeBatch: PredictionTradeInsert[] = [];

      for (const trade of trades) {
        const side: 'buy' | 'sell' =
          (trade.side ?? '').toUpperCase() === 'BUY' ? 'buy' : 'sell';

        tradeBatch.push({
          contract_id: contractId,
          trade_timestamp: new Date(trade.timestamp * 1000).toISOString(),
          price: clamp5_4(parseFloat(trade.price)),
          size: parseFloat(trade.size),
          side,
          wallet_address: trade.owner ?? null,
          metadata: {
            trade_id: trade.id,
            transaction_hash: trade.transaction_hash,
            asset_id: trade.asset_id,
          },
        });
      }

      if (tradeBatch.length > 0) {
        const { ok, err } = await flushTrades(tradeBatch);
        tradesInserted += ok;
        tradesError += err;
        process.stdout.write('.');
      }
    }

    offset += pageMarkets.length;
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

  // Validate private key is loadable before starting.
  loadKalshiPrivateKey();

  // --- Kalshi ---
  try {
    await importKalshi();
  } catch (err) {
    console.error(`\nERROR during Kalshi import: ${(err as Error).message}`);
  }

  // --- Polymarket ---
  try {
    await importPolymarket();
  } catch (err) {
    console.error(`\nERROR during Polymarket import: ${(err as Error).message}`);
  }

  console.log(
    `\n=== Completed. Total contracts resolved: ${contractIdCache.size}. ===`,
  );
}

importPredictions().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
