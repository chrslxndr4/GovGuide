/**
 * Weekly Data Pipeline Runner
 *
 * Runs weekly import tasks:
 * 1. FEC committees
 * 2. Lobbying registrations and filings
 * 3. Judicial data (judges, financials)
 * 4. Polling data
 * 5. Entity resolution
 * 6. Refresh materialized views
 * 7. Conflict detection
 *
 * Run: npx tsx --env-file=.env scripts/pipeline-weekly.ts
 */

import { execSync } from 'node:child_process';
import { supabase } from './lib/supabase-admin.js';

const SCRIPTS = [
  { name: 'FEC Committees', script: 'scripts/import-fec-committees.ts' },
  { name: 'Lobbying Data', script: 'scripts/import-lobbying.ts' },
  { name: 'Judges', script: 'scripts/import-judges.ts' },
  { name: 'Judge Financials', script: 'scripts/import-judge-financials.ts' },
  { name: 'Polling Data', script: 'scripts/import-polls.ts' },
  { name: 'Entity Resolution', script: 'scripts/resolve-entities.ts' },
];

async function runScript(name: string, script: string): Promise<boolean> {
  console.log(`\n--- ${name} ---`);
  const start = Date.now();
  try {
    execSync(`npx tsx --env-file=.env ${script}`, {
      stdio: 'inherit',
      timeout: 1200000, // 20 minutes per script
    });
    console.log(`  Completed in ${((Date.now() - start) / 1000).toFixed(1)}s`);
    return true;
  } catch (err) {
    console.error(`  FAILED after ${((Date.now() - start) / 1000).toFixed(1)}s`);
    return false;
  }
}

async function main() {
  console.log('=== Weekly Data Pipeline ===');
  console.log(`Started: ${new Date().toISOString()}\n`);

  const results: Array<{ name: string; success: boolean }> = [];

  for (const { name, script } of SCRIPTS) {
    const success = await runScript(name, script);
    results.push({ name, success });
  }

  // Refresh materialized views
  console.log('\n--- Refreshing Materialized Views ---');
  const { error } = await supabase.rpc('refresh_all_materialized_views');
  if (error) {
    console.error('  Failed:', error.message);
  } else {
    console.log('  Views refreshed.');
  }

  // Conflict detection
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
