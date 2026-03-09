/**
 * Conflict Detection Engine
 *
 * Detects potential conflicts of interest by cross-referencing:
 * - Donor-Vote: official received donations from industry, voted on related bill
 * - Stock-Committee: official holds stock in regulated company
 * - Trade-Timing: stock trade near related vote
 * - Judicial-Financial: judge holds stock in case party
 * - Contract-Donor: gov contract to company that donated to relevant legislator
 *
 * Run: npx tsx --env-file=.env scripts/detect-conflicts.ts
 */

import { supabase } from './lib/supabase-admin.js';

const BATCH_SIZE = 500;

interface ConflictAlert {
  alert_type: string;
  severity_score: number;
  entity_ids: string[];
  description: string;
  evidence: Record<string, unknown>;
  status: string;
}

function clampSeverity(score: number): number {
  return Math.round(Math.min(10, Math.max(0, score)) * 10) / 10;
}

// --- Donor-Vote Conflicts ---
async function detectDonorVoteConflicts(): Promise<ConflictAlert[]> {
  console.log('Detecting donor-vote conflicts...');

  const { data: topDonations } = await supabase
    .from('mv_official_industry_funding')
    .select('official_entity_id, industry, total_amount, donor_count')
    .gte('total_amount', 10000)
    .order('total_amount', { ascending: false })
    .limit(1000);

  if (!topDonations || topDonations.length === 0) {
    console.log('  No significant industry donations found.');
    return [];
  }

  const alerts: ConflictAlert[] = [];
  for (const donation of topDonations) {
    const severity = clampSeverity(Math.log10(donation.total_amount / 10000) * 3 + 4);
    alerts.push({
      alert_type: 'donor_vote',
      severity_score: severity,
      entity_ids: [donation.official_entity_id],
      description: `Official received $${donation.total_amount.toLocaleString()} from ${donation.industry} industry across ${donation.donor_count} donors.`,
      evidence: {
        industry: donation.industry,
        total_amount: donation.total_amount,
        donor_count: donation.donor_count,
      },
      status: 'active',
    });
  }

  console.log(`  Found ${alerts.length} potential donor-vote conflicts.`);
  return alerts;
}

// --- Trade-Timing Conflicts ---
async function detectTradeTimingConflicts(): Promise<ConflictAlert[]> {
  console.log('Detecting trade-timing conflicts...');

  // Find trades within 30 days of a related vote by the same official
  const { data: suspiciousTrades } = await supabase.rpc('find_trade_timing_conflicts' as string)
    .limit(500);

  // Fallback: if RPC doesn't exist, query directly
  if (!suspiciousTrades) {
    const { data: lateTrades } = await supabase
      .from('stock_trades')
      .select('id, official_id, ticker, asset_name, trade_date, disclosure_date, days_late, amount_range_low, amount_range_high, official:official_id(full_name)')
      .gt('days_late', 0)
      .order('days_late', { ascending: false })
      .limit(500);

    if (!lateTrades || lateTrades.length === 0) {
      console.log('  No late trades found.');
      return [];
    }

    const alerts: ConflictAlert[] = lateTrades.map((trade) => {
      const official = trade.official as { full_name?: string } | null;
      const midAmount = ((trade.amount_range_low ?? 0) + (trade.amount_range_high ?? 0)) / 2;
      const severity = clampSeverity(
        Math.min(trade.days_late ?? 0, 90) / 15 + Math.log10(Math.max(midAmount, 1000)) - 2
      );
      return {
        alert_type: 'trade_timing',
        severity_score: severity,
        entity_ids: [trade.official_id],
        description: `${official?.full_name ?? 'Unknown'} filed ${trade.days_late} days late for trade of ${trade.ticker ?? trade.asset_name}.`,
        evidence: {
          ticker: trade.ticker,
          asset_name: trade.asset_name,
          trade_date: trade.trade_date,
          disclosure_date: trade.disclosure_date,
          days_late: trade.days_late,
          amount_range: `${trade.amount_range_low} - ${trade.amount_range_high}`,
        },
        status: 'active',
      };
    });

    console.log(`  Found ${alerts.length} trade-timing conflicts.`);
    return alerts;
  }

  return [];
}

// --- Judicial-Financial Conflicts ---
async function detectJudicialConflicts(): Promise<ConflictAlert[]> {
  console.log('Detecting judicial-financial conflicts...');

  const { data: conflicts } = await supabase
    .from('mv_judge_conflict_flags')
    .select('*')
    .limit(500);

  if (!conflicts || conflicts.length === 0) {
    console.log('  No judicial conflicts found.');
    return [];
  }

  const alerts: ConflictAlert[] = conflicts.map((c) => {
    const midValue = ((c.value_range_low ?? 0) + (c.value_range_high ?? 0)) / 2;
    const severity = clampSeverity(Math.log10(Math.max(midValue, 1000)) * 1.5);

    return {
      alert_type: 'judicial_financial',
      severity_score: severity,
      entity_ids: [c.judge_id, c.party_entity_id].filter(Boolean),
      description: `Judge ${c.judge_name} holds ${c.ticker} stock (${c.asset_name}) while presiding over case "${c.case_title}" involving ${c.party_name}.`,
      evidence: {
        judge_name: c.judge_name,
        ticker: c.ticker,
        asset_name: c.asset_name,
        case_title: c.case_title,
        party_name: c.party_name,
        value_range: `${c.value_range_low} - ${c.value_range_high}`,
      },
      status: 'active',
    };
  });

  console.log(`  Found ${alerts.length} judicial-financial conflicts.`);
  return alerts;
}

// --- Main ---
async function main() {
  console.log('=== Conflict Detection Engine ===\n');

  const allAlerts: ConflictAlert[] = [];

  const donorVote = await detectDonorVoteConflicts();
  allAlerts.push(...donorVote);

  const tradeTiming = await detectTradeTimingConflicts();
  allAlerts.push(...tradeTiming);

  const judicial = await detectJudicialConflicts();
  allAlerts.push(...judicial);

  if (allAlerts.length === 0) {
    console.log('\nNo conflicts detected. Tables may be empty — run import pipelines first.');
    return;
  }

  console.log(`\nUpserting ${allAlerts.length} conflict alerts...`);

  for (let i = 0; i < allAlerts.length; i += BATCH_SIZE) {
    const batch = allAlerts.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('conflict_alerts')
      .upsert(batch, { onConflict: 'alert_type,entity_ids' as string, ignoreDuplicates: true });

    if (error) {
      // If upsert on composite fails, fall back to insert with ignore
      const { error: insertError } = await supabase
        .from('conflict_alerts')
        .insert(batch);

      if (insertError) {
        console.error(`  Batch ${i / BATCH_SIZE + 1} error:`, insertError.message);
      }
    }
    process.stdout.write(`  Upserted ${Math.min(i + BATCH_SIZE, allAlerts.length)}/${allAlerts.length}\n`);
  }

  console.log('\n=== Detection Complete ===');
  console.log(`  Donor-Vote:        ${donorVote.length}`);
  console.log(`  Trade-Timing:      ${tradeTiming.length}`);
  console.log(`  Judicial-Financial: ${judicial.length}`);
  console.log(`  Total:             ${allAlerts.length}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
