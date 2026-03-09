/**
 * Stock Trades Pipeline
 *
 * Fetches congressional stock trade disclosures and loads them into the
 * `stock_trades`, `relationships`, and (read-only) `entities` / `officials`
 * tables.
 *
 * Data source: Quiver Quantitative API (https://api.quiverquant.com)
 *   - House trading: GET /beta/live/housetrading
 *   - Senate trading: GET /beta/live/senatetrading
 *
 * Requires environment variable: QUIVER_QUANT_API_KEY
 *
 * If the key is absent the pipeline exits early with an informational message
 * so that the run harness can still complete cleanly.
 *
 * Idempotency: trades are upserted on
 *   (official_id, ticker, trade_date, trade_type, amount_range_low)
 * to prevent duplicates across re-runs.
 *
 * Disclosure-lateness (days_late) is a GENERATED column on the table and must
 * NOT be supplied in INSERT / UPDATE payloads.
 */

import { BasePipeline } from '../base.js';

// ---------------------------------------------------------------------------
// Amount-range parsing
// ---------------------------------------------------------------------------

interface AmountRange {
  low: number;
  high: number | null;
}

/**
 * Map a human-readable STOCK Act amount string to a numeric range pair.
 * Returns null if the string is unrecognised so callers can decide how to
 * handle the gap rather than silently storing zeros.
 */
function parseAmountRange(raw: string | null | undefined): AmountRange | null {
  if (!raw) return null;

  const normalised = raw.trim();

  const RANGES: Record<string, AmountRange> = {
    '$1,001 - $15,000':       { low: 1001,    high: 15000 },
    '$15,001 - $50,000':      { low: 15001,   high: 50000 },
    '$50,001 - $100,000':     { low: 50001,   high: 100000 },
    '$100,001 - $250,000':    { low: 100001,  high: 250000 },
    '$250,001 - $500,000':    { low: 250001,  high: 500000 },
    '$500,001 - $1,000,000':  { low: 500001,  high: 1000000 },
    'Over $1,000,000':        { low: 1000001, high: null },
    // Common Quiver API variants (no spaces around dash, dollar sign omitted)
    '$1001 - $15000':         { low: 1001,    high: 15000 },
    '$15001 - $50000':        { low: 15001,   high: 50000 },
    '$50001 - $100000':       { low: 50001,   high: 100000 },
    '$100001 - $250000':      { low: 100001,  high: 250000 },
    '$250001 - $500000':      { low: 250001,  high: 500000 },
    '$500001 - $1000000':     { low: 500001,  high: 1000000 },
    'Over $1000000':          { low: 1000001, high: null },
  };

  if (RANGES[normalised]) return RANGES[normalised];

  // Fallback: attempt to parse a "X - Y" pattern with numeric values.
  const rangeMatch = normalised.replace(/[$,]/g, '').match(/^(\d+)\s*-\s*(\d+)$/);
  if (rangeMatch) {
    return { low: Number(rangeMatch[1]), high: Number(rangeMatch[2]) };
  }

  const overMatch = normalised.replace(/[$,]/g, '').match(/^[Oo]ver\s+(\d+)$/);
  if (overMatch) {
    return { low: Number(overMatch[1]) + 1, high: null };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Trade-type normalisation
// ---------------------------------------------------------------------------

type TradeType = 'buy' | 'sell' | 'exchange' | 'receive';

function normaliseTradeType(raw: string | null | undefined): TradeType {
  if (!raw) return 'buy';
  const lower = raw.toLowerCase().trim();
  if (lower === 'sale' || lower === 'sell' || lower.startsWith('sale')) return 'sell';
  if (lower === 'exchange') return 'exchange';
  if (lower === 'receive') return 'receive';
  return 'buy';
}

// ---------------------------------------------------------------------------
// Quiver API response shapes
// ---------------------------------------------------------------------------

interface QuiverTrade {
  /** Member name — format varies; often "Last, First" or "First Last". */
  Name?: string;
  Representative?: string;   // House endpoint uses this key
  Senator?: string;          // Senate endpoint uses this key
  Ticker?: string;
  AssetName?: string;
  AssetDescription?: string;
  AssetType?: string;
  Transaction?: string;      // "Purchase", "Sale", "Sale (Full)", etc.
  Amount?: string;           // "$15,001 - $50,000"
  Date?: string;             // ISO date of trade
  TransactionDate?: string;
  ReportDate?: string;       // ISO date of disclosure filing
  FilingDate?: string;
  Owner?: string;            // "Self", "Spouse", "Dependent", "Joint"
  Comment?: string;
  Link?: string;             // URL to the original filing
}

// ---------------------------------------------------------------------------
// Official name matching
// ---------------------------------------------------------------------------

/**
 * Attempt a best-effort name match against the officials table.
 * Quiver supplies names in several formats:
 *   - "Smith, John"
 *   - "John Smith"
 *   - "John A. Smith"
 *
 * We try both "Last, First" decomposition and a full-text ILIKE on the
 * concatenation of first_name + last_name.
 *
 * Returns the official UUID on success, null when no match is found.
 */
async function findOfficialByName(
  supabase: ReturnType<typeof import('@supabase/supabase-js').createClient>,
  rawName: string,
): Promise<string | null> {
  const name = rawName.trim();

  // Try "Last, First" format first.
  const commaIdx = name.indexOf(',');
  if (commaIdx !== -1) {
    const lastName  = name.slice(0, commaIdx).trim();
    const firstName = name.slice(commaIdx + 1).trim().split(/\s+/)[0]; // first word only

    const { data } = await supabase
      .from('officials')
      .select('id')
      .ilike('last_name', lastName)
      .ilike('first_name', `${firstName}%`)
      .maybeSingle();

    if (data) return (data as { id: string }).id;
  }

  // Try "First Last" format (last token = last name).
  const parts = name.split(/\s+/);
  if (parts.length >= 2) {
    const firstName = parts[0];
    const lastName  = parts[parts.length - 1];

    const { data } = await supabase
      .from('officials')
      .select('id')
      .ilike('last_name', lastName)
      .ilike('first_name', `${firstName}%`)
      .maybeSingle();

    if (data) return (data as { id: string }).id;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class StockTradesPipeline extends BasePipeline {
  private readonly apiKey: string | null;

  // Per-run in-memory caches to reduce redundant DB round trips.
  private officialCache  = new Map<string, string | null>();  // rawName → official_id
  private entityCache    = new Map<string, string | null>();  // ticker   → entity_id

  constructor() {
    super();
    this.apiKey = process.env.QUIVER_QUANT_API_KEY ?? null;
  }

  getName(): string {
    return 'stock-trades';
  }

  // ---------------------------------------------------------------------------
  // run
  // ---------------------------------------------------------------------------

  async run(): Promise<void> {
    if (!this.apiKey) {
      console.log(
        `[${this.getName()}] QUIVER_QUANT_API_KEY is not set. ` +
        'Automatic import is unavailable. ' +
        'To load stock-trade disclosures manually, download STOCK Act XML ' +
        'exports from https://disclosures.house.gov and ' +
        'https://efts.senate.gov/LATEST/search-index?report_types=RFDA ' +
        'and run the manual import script.',
      );
      return;
    }

    const chambers: Array<{ label: string; endpoint: string; nameKey: keyof QuiverTrade }> = [
      { label: 'House',  endpoint: 'housetrading',  nameKey: 'Representative' },
      { label: 'Senate', endpoint: 'senatetrading',  nameKey: 'Senator' },
    ];

    for (const { label, endpoint, nameKey } of chambers) {
      console.log(`[${this.getName()}] Fetching ${label} trades...`);

      let trades: QuiverTrade[];
      try {
        trades = await this.fetchQuiverTrades(endpoint);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[${this.getName()}] Failed to fetch ${label} trades: ${msg}`);
        this.results.errors.push(`${label} fetch: ${msg}`);
        continue;
      }

      console.log(`[${this.getName()}] Received ${trades.length} ${label} trade records.`);
      this.results.records_fetched += trades.length;

      for (const trade of trades) {
        try {
          await this.processTrade(trade, nameKey);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          const tradeId = `${trade[nameKey] ?? 'unknown'}/${trade.Ticker ?? '?'}/${trade.Date ?? trade.TransactionDate ?? '?'}`;
          console.error(`[${this.getName()}] Error processing trade ${tradeId}: ${msg}`);
          this.results.errors.push(`Trade ${tradeId}: ${msg}`);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Quiver API fetch
  // ---------------------------------------------------------------------------

  private async fetchQuiverTrades(endpoint: string): Promise<QuiverTrade[]> {
    const url = `https://api.quiverquant.com/beta/live/${endpoint}`;
    const response = await this.rateLimitedFetch(url, 250);

    // rateLimitedFetch already throws on non-OK status.
    const data = await response.json() as unknown;

    if (!Array.isArray(data)) {
      throw new Error(`Unexpected response shape from ${url}: expected array`);
    }

    return data as QuiverTrade[];
  }

  // ---------------------------------------------------------------------------
  // Per-trade processing
  // ---------------------------------------------------------------------------

  private async processTrade(trade: QuiverTrade, nameKey: keyof QuiverTrade): Promise<void> {
    const rawName = (
      (trade[nameKey] as string | undefined) ??
      trade.Name ??
      ''
    ).trim();

    if (!rawName) {
      this.results.records_skipped++;
      return;
    }

    const ticker = (trade.Ticker ?? '').trim().toUpperCase();
    if (!ticker) {
      this.results.records_skipped++;
      return;
    }

    const tradeDate       = trade.TransactionDate ?? trade.Date ?? null;
    const disclosureDate  = trade.FilingDate ?? trade.ReportDate ?? null;
    const tradeType       = normaliseTradeType(trade.Transaction);
    const amountRange     = parseAmountRange(trade.Amount);
    const owner           = normaliseOwner(trade.Owner);

    // Resolve the official by name (cached).
    const officialId = await this.resolveOfficial(rawName);
    if (!officialId) {
      console.warn(
        `[${this.getName()}] Could not match official "${rawName}" — skipping trade.`,
      );
      this.results.records_skipped++;
      return;
    }

    // Try to resolve a corporation entity by ticker (cached, non-fatal).
    const entityId = await this.resolveEntityByTicker(ticker);

    // Build the row — omit days_late (GENERATED column).
    const row = {
      official_id:       officialId,
      ticker,
      asset_name:        (trade.AssetName ?? trade.AssetDescription ?? null) || null,
      asset_type:        trade.AssetType ?? null,
      trade_type:        tradeType,
      amount_range_low:  amountRange?.low  ?? null,
      amount_range_high: amountRange?.high ?? null,
      trade_date:        tradeDate,
      disclosure_date:   disclosureDate,
      filing_url:        trade.Link ?? null,
      owner,
      comment:           trade.Comment ?? null,
      entity_id:         entityId,
      metadata: {
        raw_name:   rawName,
        raw_amount: trade.Amount ?? null,
        raw_type:   trade.Transaction ?? null,
      },
    };

    // Upsert on the natural key: same member + ticker + date + direction + low.
    const { data: existing, error: lookupError } = await this.supabase
      .from('stock_trades')
      .select('id')
      .eq('official_id',      officialId)
      .eq('ticker',           ticker)
      .eq('trade_type',       tradeType)
      .eq('amount_range_low', amountRange?.low ?? 0)
      .eq('trade_date',       tradeDate ?? '')
      .maybeSingle();

    if (lookupError) {
      throw new Error(`stock_trades lookup failed: ${lookupError.message}`);
    }

    if (existing) {
      // Update in place so filing_url / comment / entity_id stay current.
      const { error: updateError } = await this.supabase
        .from('stock_trades')
        .update(row)
        .eq('id', (existing as { id: string }).id);

      if (updateError) {
        throw new Error(`stock_trades update failed: ${updateError.message}`);
      }

      this.results.records_updated++;
    } else {
      const { error: insertError } = await this.supabase
        .from('stock_trades')
        .insert(row);

      if (insertError) {
        // 23505 = unique_violation; treat as a skip rather than a hard error.
        if (insertError.code === '23505') {
          this.results.records_skipped++;
          return;
        }
        throw new Error(`stock_trades insert failed: ${insertError.message}`);
      }

      this.results.records_inserted++;
    }

    // Create 'traded_stock' relationship if we resolved a corporation entity.
    if (entityId) {
      await this.upsertTradedStockRelationship(officialId, entityId, tradeDate);
    }
  }

  // ---------------------------------------------------------------------------
  // Official resolution (cached)
  // ---------------------------------------------------------------------------

  private async resolveOfficial(rawName: string): Promise<string | null> {
    if (this.officialCache.has(rawName)) {
      return this.officialCache.get(rawName)!;
    }

    const id = await findOfficialByName(this.supabase, rawName);
    this.officialCache.set(rawName, id);
    return id;
  }

  // ---------------------------------------------------------------------------
  // Corporation entity resolution by ticker (cached, non-fatal)
  // ---------------------------------------------------------------------------

  private async resolveEntityByTicker(ticker: string): Promise<string | null> {
    if (this.entityCache.has(ticker)) {
      return this.entityCache.get(ticker)!;
    }

    // Look for a corporation entity whose external_ids contains the ticker.
    const { data, error } = await this.supabase
      .from('entities')
      .select('id')
      .eq('entity_type', 'corporation')
      .eq('external_ids->>ticker', ticker)
      .maybeSingle();

    if (error) {
      // Non-fatal: log and continue without an entity link.
      console.warn(
        `[${this.getName()}] Entity lookup by ticker "${ticker}" failed: ${error.message}`,
      );
      this.entityCache.set(ticker, null);
      return null;
    }

    const id = data ? (data as { id: string }).id : null;
    this.entityCache.set(ticker, id);
    return id;
  }

  // ---------------------------------------------------------------------------
  // Relationship upsert
  // ---------------------------------------------------------------------------

  private async upsertTradedStockRelationship(
    officialEntityId: string,
    corporationEntityId: string,
    tradeDate: string | null,
  ): Promise<void> {
    // We need the entity_id for the official (officials.id ≠ entities.id).
    // Try to find an entity whose external_ids.official_id equals officialEntityId.
    const { data: officialEntity, error: officialEntityError } = await this.supabase
      .from('entities')
      .select('id')
      .eq('external_ids->>official_id', officialEntityId)
      .maybeSingle();

    if (officialEntityError || !officialEntity) {
      // Cannot create a relationship without both entity IDs — skip silently.
      return;
    }

    const sourceEntityId = (officialEntity as { id: string }).id;
    const year = tradeDate ? tradeDate.slice(0, 4) : String(new Date().getFullYear());

    const { error } = await this.supabase
      .from('relationships')
      .upsert(
        {
          source_entity_id:  sourceEntityId,
          target_entity_id:  corporationEntityId,
          relationship_type: 'traded_stock',
          cycle:             year,
          source:            'quiver_quant',
        },
        {
          onConflict:       'source_entity_id,target_entity_id,relationship_type,cycle',
          ignoreDuplicates: false,
        },
      );

    if (error && error.code !== '23505') {
      // Non-fatal: log but don't halt the trade insert.
      console.warn(
        `[${this.getName()}] Relationship upsert failed ` +
        `(${sourceEntityId} → ${corporationEntityId}): ${error.message}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Owner normalisation
// ---------------------------------------------------------------------------

function normaliseOwner(raw: string | null | undefined): string {
  if (!raw) return 'self';
  const lower = raw.toLowerCase().trim();
  if (lower === 'spouse')    return 'spouse';
  if (lower === 'dependent') return 'dependent';
  if (lower === 'joint')     return 'joint';
  return 'self';
}
