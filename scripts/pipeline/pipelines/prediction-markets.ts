import { BasePipeline } from '../base.js';
import { PolymarketClient, type PolymarketMarket } from '../clients/polymarket.js';
import { KalshiClient, type KalshiMarket, type KalshiSnapshot } from '../clients/kalshi.js';

// Volume spike threshold: flag if latest volume exceeds 3x rolling average.
const VOLUME_SPIKE_MULTIPLIER = 3;

// Rapid price move threshold: flag if yes_price moves more than 20% within 1 hour.
const RAPID_PRICE_MOVE_THRESHOLD = 0.2;

// Lookback window in milliseconds for rapid price move detection (1 hour).
const RAPID_PRICE_MOVE_WINDOW_MS = 60 * 60 * 1000;

interface ContractCounts {
  polymarketFetched: number;
  polymarketUpserted: number;
  kalshiFetched: number;
  kalshiUpserted: number;
  snapshotsInserted: number;
  anomaliesInserted: number;
}

export class PredictionMarketsPipeline extends BasePipeline {
  private polymarket: PolymarketClient;
  private kalshi: KalshiClient;
  private counts: ContractCounts;

  constructor() {
    super();
    this.polymarket = new PolymarketClient();
    this.kalshi = new KalshiClient();
    this.counts = {
      polymarketFetched: 0,
      polymarketUpserted: 0,
      kalshiFetched: 0,
      kalshiUpserted: 0,
      snapshotsInserted: 0,
      anomaliesInserted: 0,
    };
  }

  getName(): string {
    return 'prediction-markets';
  }

  async run(): Promise<void> {
    await this.runPolymarket();
    await this.runKalshi();

    console.log(`[${this.getName()}] Counts:`, this.counts);
  }

  // ---------------------------------------------------------------------------
  // Polymarket
  // ---------------------------------------------------------------------------

  private async runPolymarket(): Promise<void> {
    console.log(`[${this.getName()}] Fetching Polymarket election markets...`);

    let markets: PolymarketMarket[];
    try {
      markets = await this.polymarket.getElectionMarkets();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[${this.getName()}] Failed to fetch Polymarket markets: ${msg}`);
      this.results.errors.push(`Polymarket fetch: ${msg}`);
      return;
    }

    console.log(`[${this.getName()}] Received ${markets.length} Polymarket markets.`);
    this.counts.polymarketFetched = markets.length;
    this.results.records_fetched += markets.length;

    for (const market of markets) {
      try {
        const contractId = await this.upsertPolymarketContract(market);
        await this.insertPolymarketSnapshot(contractId, market);
        this.counts.polymarketUpserted++;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[${this.getName()}] Error processing Polymarket market ${market.id}: ${msg}`);
        this.results.errors.push(`Polymarket market ${market.id}: ${msg}`);
      }
    }
  }

  private async upsertPolymarketContract(market: PolymarketMarket): Promise<string> {
    const outcomes: Record<string, number> = {};
    const currentPrices: Record<string, number> = {};

    for (let i = 0; i < market.outcomes.length; i++) {
      const label = market.outcomes[i];
      const price = parseFloat(market.outcomePrices[i] ?? '0');
      outcomes[label] = i;
      currentPrices[label] = price;
    }

    const record = {
      platform: 'polymarket',
      platform_id: market.id,
      question: market.question,
      category: market.category,
      outcomes,
      current_prices: currentPrices,
      volume: parseFloat(market.volume) || 0,
      liquidity: parseFloat(market.liquidity) || 0,
      start_date: market.startDate || null,
      end_date: market.endDate || null,
      resolved: market.resolved,
      resolution: null,
      metadata: {
        slug: market.slug,
        tags: market.tags ?? [],
        active: market.active,
        closed: market.closed,
        resolution_source: market.resolutionSource ?? null,
      },
    };

    const { data, error } = await this.supabase
      .from('prediction_contracts')
      .upsert(record, { onConflict: 'platform,platform_id' })
      .select('id')
      .single();

    if (error) throw new Error(`Polymarket contract upsert failed: ${error.message}`);

    this.results.records_updated++;
    return data!.id;
  }

  private async insertPolymarketSnapshot(
    contractId: string,
    market: PolymarketMarket
  ): Promise<void> {
    const prices: Record<string, number> = {};
    for (let i = 0; i < market.outcomes.length; i++) {
      prices[market.outcomes[i]] = parseFloat(market.outcomePrices[i] ?? '0');
    }

    const { error } = await this.supabase.from('prediction_snapshots').insert({
      contract_id: contractId,
      snapshot_time: new Date().toISOString(),
      prices,
      volume_24h: parseFloat(market.volume) || 0,
      liquidity: parseFloat(market.liquidity) || 0,
      metadata: { source: 'polymarket' },
    });

    if (error) throw new Error(`Polymarket snapshot insert failed: ${error.message}`);
    this.counts.snapshotsInserted++;
    this.results.records_inserted++;
  }

  // ---------------------------------------------------------------------------
  // Kalshi
  // ---------------------------------------------------------------------------

  private async runKalshi(): Promise<void> {
    console.log(`[${this.getName()}] Fetching Kalshi political events...`);

    let events;
    try {
      events = await this.kalshi.getPoliticalEvents();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[${this.getName()}] Failed to fetch Kalshi events: ${msg}`);
      this.results.errors.push(`Kalshi fetch: ${msg}`);
      return;
    }

    console.log(`[${this.getName()}] Received ${events.length} Kalshi events.`);

    for (const event of events) {
      let markets: KalshiMarket[];
      try {
        markets = await this.kalshi.getMarkets(event.event_ticker);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(
          `[${this.getName()}] Failed to fetch Kalshi markets for event ${event.event_ticker}: ${msg}`
        );
        this.results.errors.push(`Kalshi event ${event.event_ticker}: ${msg}`);
        continue;
      }

      this.counts.kalshiFetched += markets.length;
      this.results.records_fetched += markets.length;

      for (const market of markets) {
        try {
          const contractId = await this.upsertKalshiContract(event.title, event.category, market);
          const history = await this.fetchKalshiHistory(market.ticker);
          await this.insertKalshiSnapshots(contractId, history);
          await this.detectAndInsertAnomalies(contractId, market.ticker, history);
          this.counts.kalshiUpserted++;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(
            `[${this.getName()}] Error processing Kalshi market ${market.ticker}: ${msg}`
          );
          this.results.errors.push(`Kalshi market ${market.ticker}: ${msg}`);
        }
      }
    }
  }

  private async upsertKalshiContract(
    eventTitle: string,
    eventCategory: string,
    market: KalshiMarket
  ): Promise<string> {
    const currentPrices = {
      yes: market.yes_price,
      no: market.no_price,
    };

    const outcomes = { yes: 'Yes', no: 'No' };

    const record = {
      platform: 'kalshi',
      platform_id: market.ticker,
      question: market.title,
      category: eventCategory,
      outcomes,
      current_prices: currentPrices,
      volume: market.volume,
      liquidity: null,
      start_date: market.open_time || null,
      end_date: market.close_time || null,
      resolved: market.status === 'finalized',
      resolution: market.result || null,
      metadata: {
        event_ticker: market.event_ticker,
        event_title: eventTitle,
        outcome: market.outcome,
        status: market.status,
      },
    };

    const { data, error } = await this.supabase
      .from('prediction_contracts')
      .upsert(record, { onConflict: 'platform,platform_id' })
      .select('id')
      .single();

    if (error) throw new Error(`Kalshi contract upsert failed: ${error.message}`);

    this.results.records_updated++;
    return data!.id;
  }

  private async fetchKalshiHistory(ticker: string): Promise<KalshiSnapshot[]> {
    try {
      return await this.kalshi.getMarketHistory(ticker);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[${this.getName()}] Could not fetch history for ${ticker}: ${msg}`);
      return [];
    }
  }

  private async insertKalshiSnapshots(
    contractId: string,
    history: KalshiSnapshot[]
  ): Promise<void> {
    if (history.length === 0) return;

    const rows = history.map((snap) => ({
      contract_id: contractId,
      snapshot_time: new Date(snap.ts * 1000).toISOString(),
      prices: { yes: snap.yes_price, no: 1 - snap.yes_price },
      volume_24h: snap.volume,
      liquidity: null,
      metadata: { source: 'kalshi' },
    }));

    // Batch in chunks of 500 to avoid payload limits.
    const BATCH_SIZE = 500;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await this.supabase.from('prediction_snapshots').insert(batch);
      if (error) {
        // Unique constraint violations are acceptable (re-runs); other errors surface.
        if (error.code !== '23505') {
          throw new Error(`Kalshi snapshot batch insert failed: ${error.message}`);
        }
      } else {
        this.counts.snapshotsInserted += batch.length;
        this.results.records_inserted += batch.length;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Anomaly detection
  // ---------------------------------------------------------------------------

  private async detectAndInsertAnomalies(
    contractId: string,
    ticker: string,
    history: KalshiSnapshot[]
  ): Promise<void> {
    if (history.length < 2) return;

    const sorted = [...history].sort((a, b) => a.ts - b.ts);

    const volumeAnomalies = this.detectVolumeSpikes(sorted);
    const priceAnomalies = this.detectRapidPriceMoves(sorted);

    const all = [...volumeAnomalies, ...priceAnomalies];
    if (all.length === 0) return;

    for (const anomaly of all) {
      const { error } = await this.supabase.from('prediction_anomalies').insert({
        contract_id: contractId,
        anomaly_type: anomaly.type,
        detected_at: new Date().toISOString(),
        description: anomaly.description,
        evidence: anomaly.evidence,
        severity_score: anomaly.severity,
        wallet_addresses: [],
        metadata: { platform: 'kalshi', ticker },
      });

      if (error) {
        console.warn(
          `[${this.getName()}] Anomaly insert failed for ${ticker}: ${error.message}`
        );
      } else {
        this.counts.anomaliesInserted++;
        this.results.records_inserted++;
      }
    }
  }

  private detectVolumeSpikes(
    sorted: KalshiSnapshot[]
  ): Array<{ type: string; description: string; evidence: Record<string, unknown>; severity: number }> {
    const anomalies: Array<{
      type: string;
      description: string;
      evidence: Record<string, unknown>;
      severity: number;
    }> = [];

    if (sorted.length < 3) return anomalies;

    // Compute rolling average volume from all points except the last.
    const priorVolumes = sorted.slice(0, -1).map((s) => s.volume);
    const avgVolume = priorVolumes.reduce((sum, v) => sum + v, 0) / priorVolumes.length;
    const latest = sorted[sorted.length - 1];

    if (avgVolume > 0 && latest.volume > avgVolume * VOLUME_SPIKE_MULTIPLIER) {
      const ratio = latest.volume / avgVolume;
      anomalies.push({
        type: 'volume_spike',
        description: `Volume ${ratio.toFixed(1)}x above rolling average (${latest.volume.toFixed(0)} vs avg ${avgVolume.toFixed(0)})`,
        evidence: {
          snapshot_ts: latest.ts,
          latest_volume: latest.volume,
          average_volume: avgVolume,
          ratio,
        },
        // Severity scales 1–10: 3x = 5, 6x = 10.
        severity: Math.min(10, parseFloat(((ratio - VOLUME_SPIKE_MULTIPLIER) * (5 / 3) + 5).toFixed(1))),
      });
    }

    return anomalies;
  }

  private detectRapidPriceMoves(
    sorted: KalshiSnapshot[]
  ): Array<{ type: string; description: string; evidence: Record<string, unknown>; severity: number }> {
    const anomalies: Array<{
      type: string;
      description: string;
      evidence: Record<string, unknown>;
      severity: number;
    }> = [];

    if (sorted.length < 2) return anomalies;

    const latest = sorted[sorted.length - 1];
    const windowStart = latest.ts - RAPID_PRICE_MOVE_WINDOW_MS / 1000;

    // Find the oldest snapshot within the 1-hour window.
    const windowSnap = sorted.find((s) => s.ts >= windowStart);
    if (!windowSnap || windowSnap.ts === latest.ts) return anomalies;

    const priceDelta = Math.abs(latest.yes_price - windowSnap.yes_price);

    if (priceDelta > RAPID_PRICE_MOVE_THRESHOLD) {
      const direction = latest.yes_price > windowSnap.yes_price ? 'up' : 'down';
      const windowSeconds = latest.ts - windowSnap.ts;
      anomalies.push({
        type: 'rapid_price_move',
        description: `Yes price moved ${direction} ${(priceDelta * 100).toFixed(1)}% in ${Math.round(windowSeconds / 60)} minutes (${windowSnap.yes_price.toFixed(3)} → ${latest.yes_price.toFixed(3)})`,
        evidence: {
          from_ts: windowSnap.ts,
          to_ts: latest.ts,
          from_price: windowSnap.yes_price,
          to_price: latest.yes_price,
          delta: priceDelta,
          window_seconds: windowSeconds,
          direction,
        },
        // Severity scales 1–10: 20% = 5, 40% = 10.
        severity: Math.min(10, parseFloat(((priceDelta - RAPID_PRICE_MOVE_THRESHOLD) * (5 / RAPID_PRICE_MOVE_THRESHOLD) + 5).toFixed(1))),
      });
    }

    return anomalies;
  }
}
