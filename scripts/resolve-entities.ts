/**
 * Entity Resolution Pipeline
 *
 * Runs deterministic and fuzzy matching, then optionally merges duplicates.
 *
 * Run: npx tsx --env-file=.env scripts/resolve-entities.ts
 * Dry run: DRY_RUN=1 npx tsx --env-file=.env scripts/resolve-entities.ts
 */

import {
  findDeterministicMatches,
  findFuzzyMatches,
  mergeEntities,
  type EntityMatch,
} from './lib/entity-resolver.js';

const DRY_RUN = process.env['DRY_RUN'] === '1';
const FUZZY_THRESHOLD = parseFloat(process.env['FUZZY_THRESHOLD'] ?? '0.90');
const AUTO_MERGE_THRESHOLD = 0.95;

async function main() {
  console.log('=== Entity Resolution Pipeline ===');
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`  Fuzzy threshold: ${FUZZY_THRESHOLD}`);
  console.log(`  Auto-merge threshold: ${AUTO_MERGE_THRESHOLD}\n`);

  // Phase 1: Deterministic
  console.log('Phase 1: Deterministic matching...');
  const deterministicMatches = await findDeterministicMatches();
  console.log(`  Found ${deterministicMatches.length} deterministic matches.\n`);

  // Phase 2: Fuzzy
  console.log('Phase 2: Fuzzy name matching...');
  const fuzzyMatches = await findFuzzyMatches(FUZZY_THRESHOLD);
  console.log(`  Found ${fuzzyMatches.length} fuzzy matches.\n`);

  // Combine and deduplicate
  const allMatches = [...deterministicMatches, ...fuzzyMatches];
  const seen = new Set<string>();
  const uniqueMatches: EntityMatch[] = [];

  for (const match of allMatches) {
    const key = [match.sourceId, match.targetId].sort().join(':');
    if (!seen.has(key)) {
      seen.add(key);
      uniqueMatches.push(match);
    }
  }

  console.log(`Total unique matches: ${uniqueMatches.length}\n`);

  // Phase 3: Auto-merge high-confidence matches
  const autoMerge = uniqueMatches.filter((m) => m.confidence >= AUTO_MERGE_THRESHOLD);
  const review = uniqueMatches.filter((m) => m.confidence < AUTO_MERGE_THRESHOLD);

  console.log(`Auto-merge (>=${AUTO_MERGE_THRESHOLD}): ${autoMerge.length}`);
  console.log(`Needs review (<${AUTO_MERGE_THRESHOLD}): ${review.length}\n`);

  let mergeCount = 0;
  for (const match of autoMerge) {
    try {
      await mergeEntities(match.sourceId, match.targetId, DRY_RUN);
      mergeCount++;
      if (mergeCount % 50 === 0) {
        console.log(`  Merged ${mergeCount}/${autoMerge.length}`);
      }
    } catch (err) {
      console.error(`  Error merging ${match.sourceId} <- ${match.targetId}:`, err);
    }
  }

  console.log(`\n=== Resolution Complete ===`);
  console.log(`  Merged: ${mergeCount}`);
  console.log(`  Needs review: ${review.length}`);

  if (review.length > 0 && review.length <= 50) {
    console.log('\n--- Matches needing review ---');
    for (const m of review) {
      console.log(
        `  ${m.sourceId} <-> ${m.targetId} | confidence: ${m.confidence.toFixed(3)} | type: ${m.matchType} | evidence: ${JSON.stringify(m.evidence)}`
      );
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
