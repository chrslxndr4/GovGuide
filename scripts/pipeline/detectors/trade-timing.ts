/**
 * Trade-Timing Conflict Detector
 *
 * Queries the `mv_stock_trade_alerts` materialized view — which surfaces
 * congressional stock trades within 30 days of a related roll-call vote — and
 * writes `conflict_alerts` rows with alert_type = 'trade_timing'.
 *
 * Severity model (0 – 10 scale):
 *   - Base timing score: trades that overlap the vote day score 5.0; each day
 *     of separation reduces the score linearly down to 1.0 at 30 days.
 *   - Late-filing bonus: disclosures filed after the 45-day STOCK Act deadline
 *     add up to +2.0 (capped), proportional to days_late.
 *   - Amount bonus: trades whose midpoint (or lower bound) falls in higher
 *     brackets add up to +3.0.
 *
 * The three components are summed and clamped to [1.0, 10.0], then rounded to
 * one decimal place to match the NUMERIC(3,1) column type.
 *
 * Idempotency: existing active alerts for the same (official_id, trade_id,
 * vote_id) triple are skipped so that re-runs do not produce duplicates.
 */

import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

function buildSupabaseClient() {
  const url = process.env.PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error(
      'Missing environment variable: PUBLIC_SUPABASE_URL\n' +
        'Set it in your shell or pass --env-file=.env to tsx.',
    );
  }
  if (!key) {
    throw new Error(
      'Missing environment variable: SUPABASE_SERVICE_ROLE_KEY\n' +
        'Set it in your shell or pass --env-file=.env to tsx.',
    );
  }

  return createClient(url, key);
}

// ---------------------------------------------------------------------------
// Materialized-view row shape
// ---------------------------------------------------------------------------

interface TradeAlertRow {
  trade_id: string;
  official_id: string;
  /** Stock ticker symbol, e.g. "NVDA". */
  ticker: string;
  asset_name: string | null;
  /** Normalised trade direction: 'buy' | 'sell' | 'exchange' | 'receive'. */
  trade_type: string;
  amount_range_low: number | null;
  amount_range_high: number | null;
  /** ISO date string of the trade transaction. */
  trade_date: string;
  /** Days between trade_date and disclosure_date; null when not filed yet. */
  days_late: number | null;
  vote_id: string;
  bill_identifier: string | null;
  bill_title: string | null;
  /** ISO date string of the roll-call vote. */
  vote_date: string;
  /** Absolute number of calendar days between trade_date and vote_date. */
  days_between: number;
  /** How the official voted: 'Yes' | 'No' | 'Present' | 'Not Voting' etc. */
  vote_position: string | null;
}

// ---------------------------------------------------------------------------
// Severity calculation
// ---------------------------------------------------------------------------

/**
 * Compute a severity score in [1.0, 10.0] for a trade-timing alert.
 *
 * Components:
 *   timingScore  – 5.0 at 0 days apart, decreasing linearly to 1.0 at 30 days.
 *   lateBonus    – up to +2.0 when days_late > 0, capped so very late filings
 *                  saturate quickly.
 *   amountBonus  – up to +3.0 based on the trade's amount midpoint bracket.
 */
function calculateSeverity(row: TradeAlertRow): number {
  // --- timing component ---
  const clampedDays = Math.min(Math.max(row.days_between, 0), 30);
  // Linear interpolation: days=0 → 5.0, days=30 → 1.0
  const timingScore = 5.0 - (4.0 * clampedDays) / 30;

  // --- late-filing component ---
  let lateBonus = 0;
  if (row.days_late !== null && row.days_late > 0) {
    // +0.5 per 30 days late, capped at +2.0 (i.e. saturates at 120 days late)
    lateBonus = Math.min(2.0, (row.days_late / 30) * 0.5);
  }

  // --- amount component ---
  // Use midpoint when both bounds are available; fall back to lower bound.
  const amountMidpoint =
    row.amount_range_low !== null
      ? row.amount_range_high !== null
        ? (row.amount_range_low + row.amount_range_high) / 2
        : row.amount_range_low
      : 0;

  let amountBonus = 0;
  if (amountMidpoint >= 1_000_001) {
    amountBonus = 3.0;
  } else if (amountMidpoint >= 500_001) {
    amountBonus = 2.5;
  } else if (amountMidpoint >= 250_001) {
    amountBonus = 2.0;
  } else if (amountMidpoint >= 100_001) {
    amountBonus = 1.5;
  } else if (amountMidpoint >= 50_001) {
    amountBonus = 1.0;
  } else if (amountMidpoint >= 15_001) {
    amountBonus = 0.5;
  }

  const raw = timingScore + lateBonus + amountBonus;
  // Clamp to [1.0, 10.0] and round to one decimal place.
  return Math.round(Math.min(10.0, Math.max(1.0, raw)) * 10) / 10;
}

// ---------------------------------------------------------------------------
// Description builder
// ---------------------------------------------------------------------------

/**
 * Format an amount range as a human-readable string, e.g. "$50,001–$100,000"
 * or "$1,000,001+" when there is no upper bound.
 */
function formatAmountRange(low: number | null, high: number | null): string {
  if (low === null) return 'an undisclosed amount';
  const fmt = (n: number) =>
    '$' + n.toLocaleString('en-US');
  if (high === null) return `${fmt(low)}+`;
  return `${fmt(low)}–${fmt(high)}`;
}

/**
 * Build the human-readable description stored in conflict_alerts.description.
 *
 * Example outputs:
 *   "Official traded $50,001–$100,000 of NVDA (buy) 5 days before voting on
 *    H.R. 1234 – Semiconductor Innovation Act"
 *   "Official traded $100,001–$250,000 of AAPL (sell) on the same day they
 *    voted on S. 567 – Apple Antitrust Accountability Act"
 */
function buildDescription(row: TradeAlertRow): string {
  const amount = formatAmountRange(row.amount_range_low, row.amount_range_high);
  const ticker = row.ticker.toUpperCase();
  const direction = row.trade_type.toLowerCase();
  const bill = row.bill_identifier
    ? row.bill_title
      ? `${row.bill_identifier} – ${row.bill_title}`
      : row.bill_identifier
    : row.bill_title ?? 'an unknown bill';

  if (row.days_between === 0) {
    return (
      `Official traded ${amount} of ${ticker} (${direction}) on the same day ` +
      `they voted on ${bill}`
    );
  }

  const dayWord = row.days_between === 1 ? 'day' : 'days';

  // Determine temporal ordering: was the trade before or after the vote?
  const tradeMs = new Date(row.trade_date).getTime();
  const voteMs = new Date(row.vote_date).getTime();
  const relation = tradeMs < voteMs ? 'before' : 'after';

  return (
    `Official traded ${amount} of ${ticker} (${direction}) ` +
    `${row.days_between} ${dayWord} ${relation} voting on ${bill}`
  );
}

// ---------------------------------------------------------------------------
// Evidence builder
// ---------------------------------------------------------------------------

function buildEvidence(row: TradeAlertRow): Record<string, unknown> {
  return {
    ticker: row.ticker,
    trade_type: row.trade_type,
    amount_range: {
      low: row.amount_range_low,
      high: row.amount_range_high,
      formatted: formatAmountRange(row.amount_range_low, row.amount_range_high),
    },
    trade_date: row.trade_date,
    vote_date: row.vote_date,
    days_between: row.days_between,
    days_late: row.days_late,
    bill_title: row.bill_title,
    bill_identifier: row.bill_identifier,
    vote_position: row.vote_position,
    asset_name: row.asset_name,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export interface DetectorResult {
  alerts_inserted: number;
  alerts_skipped: number;
  errors: string[];
}

/**
 * Detect trade-timing conflicts by scanning `mv_stock_trade_alerts` and
 * writing new rows into `conflict_alerts`.
 *
 * Already-active alerts for the same (official_id, trade_id, vote_id) triple
 * are skipped to keep the operation idempotent across re-runs.
 */
export async function detectTradeTimingConflicts(): Promise<DetectorResult> {
  const supabase = buildSupabaseClient();
  const result: DetectorResult = {
    alerts_inserted: 0,
    alerts_skipped: 0,
    errors: [],
  };

  console.log('[trade-timing] Querying mv_stock_trade_alerts...');

  // Fetch all rows from the materialized view in a single query.
  // The view already filters to trades within 30 days of a related vote.
  const { data: rows, error: fetchError } = await supabase
    .from('mv_stock_trade_alerts')
    .select(
      [
        'trade_id',
        'official_id',
        'ticker',
        'asset_name',
        'trade_type',
        'amount_range_low',
        'amount_range_high',
        'trade_date',
        'days_late',
        'vote_id',
        'bill_identifier',
        'bill_title',
        'vote_date',
        'days_between',
        'vote_position',
      ].join(', '),
    );

  if (fetchError) {
    const msg = `Failed to query mv_stock_trade_alerts: ${fetchError.message}`;
    console.error(`[trade-timing] ${msg}`);
    result.errors.push(msg);
    return result;
  }

  if (!rows || rows.length === 0) {
    console.log('[trade-timing] No suspicious trades found.');
    return result;
  }

  console.log(`[trade-timing] Found ${rows.length} candidate trade-timing alerts.`);

  // Pull existing active alert keys to avoid duplicates without relying on a
  // unique constraint that may not yet exist on conflict_alerts.
  const { data: existingAlerts, error: existingError } = await supabase
    .from('conflict_alerts')
    .select('official_id, trade_id, bill_id')
    .eq('alert_type', 'trade_timing')
    .eq('status', 'active');

  if (existingError) {
    // Non-fatal — we fall back to inserting everything and let the DB reject
    // any actual duplicates.
    console.warn(
      `[trade-timing] Could not prefetch existing alerts (${existingError.message}). ` +
        'Proceeding without deduplication cache.',
    );
  }

  // Build a fast-lookup set of "official_id|trade_id|vote_id" strings.
  type ExistingAlertRow = { official_id: string; trade_id: string | null; bill_id: string | null };
  const existingKeys = new Set<string>(
    ((existingAlerts as ExistingAlertRow[] | null) ?? []).map(
      (a) => `${a.official_id}|${a.trade_id ?? ''}|${a.bill_id ?? ''}`,
    ),
  );

  for (const raw of rows as TradeAlertRow[]) {
    const dedupeKey = `${raw.official_id}|${raw.trade_id}|${raw.vote_id}`;

    if (existingKeys.has(dedupeKey)) {
      result.alerts_skipped++;
      continue;
    }

    const severity = calculateSeverity(raw);
    const description = buildDescription(raw);
    const evidence = buildEvidence(raw);

    const alertRow = {
      alert_type: 'trade_timing' as const,
      official_id: raw.official_id,
      // entity_id is intentionally null here — the stock trade does not map to
      // a lobbying / campaign entity; the ticker is captured inside evidence.
      entity_id: null as string | null,
      bill_id: raw.vote_id,   // vote_id is a FK to the bills / votes table
      trade_id: raw.trade_id,
      description,
      evidence,
      severity_score: severity,
      status: 'active',
    };

    const { error: insertError } = await supabase
      .from('conflict_alerts')
      .insert(alertRow);

    if (insertError) {
      // 23505 = unique_violation; treat as a benign skip.
      if (insertError.code === '23505') {
        result.alerts_skipped++;
        existingKeys.add(dedupeKey);
        continue;
      }

      const msg =
        `Insert failed for trade=${raw.trade_id} / vote=${raw.vote_id}: ` +
        insertError.message;
      console.error(`[trade-timing] ${msg}`);
      result.errors.push(msg);
      continue;
    }

    result.alerts_inserted++;
    // Register in the local cache so subsequent loop iterations skip it.
    existingKeys.add(dedupeKey);
  }

  console.log('[trade-timing] Complete.', {
    inserted: result.alerts_inserted,
    skipped: result.alerts_skipped,
    errors: result.errors.length,
  });

  return result;
}
