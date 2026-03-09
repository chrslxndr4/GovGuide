import { BasePipeline } from './base.js';
import type { PipelineResult } from '../../src/lib/types/api-clients.js';

// Pipeline registry — import and register pipelines as they're built
const PIPELINES: Record<string, () => BasePipeline> = {
  // Phase 3+: pipelines registered here as they're built
  // 'fec-committees': () => new FECCommitteesPipeline(),
  // 'fec-contributions': () => new FECContributionsPipeline(),
  // 'congress-members': () => new CongressMembersPipeline(),
  // 'congress-bills': () => new CongressBillsPipeline(),
  // 'lobbying': () => new LobbyingPipeline(),
  // 'courtlistener-judges': () => new CourtListenerJudgesPipeline(),
  // 'prediction-markets': () => new PredictionMarketsPipeline(),
};

async function main() {
  const args = process.argv.slice(2);
  const pipelineName = args[0];

  if (pipelineName === '--list') {
    console.log('Available pipelines:', Object.keys(PIPELINES).join(', '));
    return;
  }

  if (pipelineName === '--all') {
    const results: PipelineResult[] = [];
    for (const [name, factory] of Object.entries(PIPELINES)) {
      console.log(`\n${'='.repeat(60)}\nRunning: ${name}\n${'='.repeat(60)}`);
      const pipeline = factory();
      results.push(await pipeline.execute());
    }
    console.log('\n\nSummary:');
    for (const r of results) {
      const status = r.errors.length ? 'ERRORS' : 'OK';
      console.log(`  ${r.source}: ${status} (${r.records_inserted} inserted, ${r.records_updated} updated, ${r.errors.length} errors, ${r.duration_ms}ms)`);
    }
    return;
  }

  if (!pipelineName || !PIPELINES[pipelineName]) {
    console.error(`Usage: npx tsx scripts/pipeline/run.ts <pipeline-name|--all|--list>`);
    console.error(`Available: ${Object.keys(PIPELINES).join(', ')}`);
    process.exit(1);
  }

  const pipeline = PIPELINES[pipelineName]();
  await pipeline.execute();
}

main().catch(console.error);
