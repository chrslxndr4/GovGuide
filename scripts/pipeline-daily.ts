/**
 * Daily Data Pipeline Runner
 *
 * Runs daily import tasks in sequence:
 * 1. FEC filings (contributions, expenditures)
 * 2. Congress.gov bill actions
 * 3. Stock trades
 * 4. Prediction markets
 * 5. Refresh materialized views
 * 6. Run conflict detection
 *
 * Run: npx tsx --env-file=.env scripts/pipeline-daily.ts
 */

import { execSync } from 'node:child_process';
import { supabase } from './lib/supabase-admin.js';

const SCRIPTS = [
  { name: 'FEC Contributions', script: 'scripts/import-fec-contributions.ts' },
  { name: 'FEC Expenditures', script: 'scripts/import-fec-expenditures.ts' },
  { name: 'Bills & Actions', script: 'scripts/import-bills.ts' },
  { name: 'Votes', script: 'scripts/import-votes.ts' },
  { name: 'Stock Trades', script: 'scripts/import-stock-trades.ts' },
  { name: 'Prediction Markets', script: 'scripts/import-predictions.ts' },
];

async function runScript(name: string, script: string): Promise<boolean> {
  console.log(`\n--- ${name} ---`);
  const start = Date.now();
  try {
    execSync(`npx tsx --env-file=.env ${script}`, {
      stdio: 'inherit',
      timeout: 600000, // 10 minutes per script
    });
    console.log(`  Completed in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    return true;
  } catch (err) {
    console.error(`  FAILED after ${((Date.now() - start) / 1000).toFixed(1)}s`);
    return false;
  }
}

async function refreshMaterializedViews(): Promise<void> {
  console.log('\n--- Refreshing Materialized Views ---');
  const { error } = await supabase.rpc('refresh_all_materialized_views');
  if (error) {
    console.error('  Failed to refresh views:', error.message);
  } else {
    console.log('  Views refreshed successfully.');
  }
}

async function main() {
  console.log('=== Daily Data Pipeline ===');
  console.log(`Started: ${new Date().toISOString()}\n`);

  const results: Array<{ name: string; success: boolean }> = [];

  for (const { name, script } of SCRIPTS) {
    const success = await runScript(name, script);
    results.push({ name, success });
  }

  await refreshMaterializedViews();

  // Run conflict detection
  await runScript('Conflict Detection', 'scripts/detect-conflicts.ts');

  console.log('\n=== Pipeline Summary ===');
  for (const r of results) {
    console.log(`  ${r.success ? 'PASS' : 'FAIL'} ${r.name}`);
  }
  console.log(`\nCompleted: ${new Date().toISOString()}`);

  const failures = results.filter((r) => !r.success);
  if (failures.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
