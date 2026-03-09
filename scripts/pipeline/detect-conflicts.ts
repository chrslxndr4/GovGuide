import { createClient } from '@supabase/supabase-js';
import { detectDonorVoteConflicts } from './detectors/donor-vote.js';
import { detectStockCommitteeConflicts } from './detectors/stock-committee.js';
import { detectTradeTimingConflicts } from './detectors/trade-timing.js';
import { detectJudicialFinancialConflicts } from './detectors/judicial-financial.js';
import { detectPredictionAnomalies } from './detectors/prediction-anomaly.js';

interface DetectorResult {
  name: string;
  alertCount: number;
  error?: string;
  durationMs: number;
}

const DETECTORS: Record<string, () => Promise<number>> = {
  'donor-vote': detectDonorVoteConflicts,
  'stock-committee': detectStockCommitteeConflicts,
  'trade-timing': detectTradeTimingConflicts,
  'judicial-financial': detectJudicialFinancialConflicts,
  'prediction-anomaly': detectPredictionAnomalies,
};

async function main() {
  const args = process.argv.slice(2);
  const detectorFlag = args.find(a => a.startsWith('--detector='));
  const dryRun = args.includes('--dry-run');
  const specificDetector = detectorFlag?.split('=')[1];

  if (specificDetector && !DETECTORS[specificDetector]) {
    console.error(`Unknown detector: ${specificDetector}`);
    console.error(`Available: ${Object.keys(DETECTORS).join(', ')}`);
    process.exit(1);
  }

  if (dryRun) {
    console.log('[detect-conflicts] DRY RUN — no alerts will be written');
    console.log('Would run:', specificDetector || 'all detectors');
    return;
  }

  // Step 1: Refresh materialized views
  console.log('[detect-conflicts] Refreshing materialized views...');
  try {
    const url = process.env.PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Missing Supabase credentials');
    const supabase = createClient(url, key);
    const { error } = await supabase.rpc('refresh_all_materialized_views');
    if (error) {
      console.warn(`[detect-conflicts] View refresh warning: ${error.message}`);
    } else {
      console.log('[detect-conflicts] Materialized views refreshed');
    }
  } catch (err) {
    console.warn(`[detect-conflicts] View refresh failed: ${err}`);
  }

  // Step 2: Run detectors
  const detectorsToRun = specificDetector
    ? { [specificDetector]: DETECTORS[specificDetector] }
    : DETECTORS;

  const results: DetectorResult[] = [];

  for (const [name, detector] of Object.entries(detectorsToRun)) {
    console.log(`\n${'='.repeat(50)}\n[detect-conflicts] Running: ${name}\n${'='.repeat(50)}`);
    const start = Date.now();

    try {
      const alertCount = await detector();
      results.push({
        name,
        alertCount,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[detect-conflicts] ${name} failed: ${msg}`);
      results.push({
        name,
        alertCount: 0,
        error: msg,
        durationMs: Date.now() - start,
      });
    }
  }

  // Step 3: Summary
  console.log(`\n${'='.repeat(50)}\n[detect-conflicts] Summary\n${'='.repeat(50)}`);
  let totalAlerts = 0;
  let totalErrors = 0;

  for (const r of results) {
    const status = r.error ? `ERROR: ${r.error}` : `${r.alertCount} alerts`;
    console.log(`  ${r.name}: ${status} (${r.durationMs}ms)`);
    totalAlerts += r.alertCount;
    if (r.error) totalErrors++;
  }

  console.log(`\nTotal: ${totalAlerts} new alerts, ${totalErrors} errors`);
}

main().catch(console.error);
