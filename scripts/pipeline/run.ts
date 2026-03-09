import { BasePipeline } from './base.js';
import type { PipelineResult } from '../../src/lib/types/api-clients.js';

import { FECCommitteesPipeline } from './pipelines/fec-committees.js';
import { FECContributionsPipeline } from './pipelines/fec-contributions.js';
import { FECIndependentExpendituresPipeline } from './pipelines/fec-independent-expenditures.js';
import { CongressMembersPipeline } from './pipelines/congress-members.js';
import { CongressBillsPipeline } from './pipelines/congress-bills.js';
import { CongressVotesPipeline } from './pipelines/congress-votes.js';
import { LobbyingPipeline } from './pipelines/lobbying.js';
import { CourtListenerJudgesPipeline } from './pipelines/courtlistener-judges.js';
import { StockTradesPipeline } from './pipelines/stock-trades.js';
import { PredictionMarketsPipeline } from './pipelines/prediction-markets.js';
import { PollingPipeline } from './pipelines/polling.js';
import { FederalRegisterPipeline } from './pipelines/federal-register.js';
import { USASpendingPipeline } from './pipelines/usaspending.js';

const PIPELINES: Record<string, () => BasePipeline> = {
  'fec-committees': () => new FECCommitteesPipeline(),
  'fec-contributions': () => new FECContributionsPipeline(),
  'fec-independent-expenditures': () => new FECIndependentExpendituresPipeline(),
  'congress-members': () => new CongressMembersPipeline(),
  'congress-bills': () => new CongressBillsPipeline(),
  'congress-votes': () => new CongressVotesPipeline(),
  'lobbying': () => new LobbyingPipeline(),
  'courtlistener-judges': () => new CourtListenerJudgesPipeline(),
  'stock-trades': () => new StockTradesPipeline(),
  'prediction-markets': () => new PredictionMarketsPipeline(),
  'polling': () => new PollingPipeline(),
  'federal-register': () => new FederalRegisterPipeline(),
  'usaspending': () => new USASpendingPipeline(),
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
