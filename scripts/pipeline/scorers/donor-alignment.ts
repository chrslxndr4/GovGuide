import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IndustryScorecard {
  name: string;
  /** bill_id -> preferred vote: 'yea' | 'nay' */
  positions: Map<string, 'yea' | 'nay'>;
}

interface IndustryAlignmentDetail {
  industry: string;
  donor_amount: number;
  votes_scored: number;
  votes_aligned: number;
  alignment_pct: number;
}

export interface DonorAlignmentResult {
  official_id: string;
  alignment_score: number;         // 0-100 (100 = votes always match top donors)
  total_scored_votes: number;
  aligned_votes: number;
  top_industry_alignments: IndustryAlignmentDetail[];
}

interface Official {
  id: string;
  [key: string]: unknown;
}

interface ContributionRow {
  industry: string | null;
  amount: number | null;
}

interface VoteRecordRow {
  bill_id: string;
  vote: string | null;
}

interface IndustryBillPositionRow {
  industry_key: string;
  bill_id: string;
  position: 'support' | 'oppose';
}

interface LobbyingPositionRow {
  industry_key: string;
  bill_id: string;
  position: 'support' | 'oppose';
}

// ---------------------------------------------------------------------------
// Industry scorecard seed — keys match values stored in contributions.industry
// ---------------------------------------------------------------------------

const INDUSTRY_SCORECARDS: Record<string, IndustryScorecard> = {
  energy_fossil:    { name: 'Fossil Fuel Industry', positions: new Map() },
  energy_renewable: { name: 'Renewable Energy',     positions: new Map() },
  finance_banking:  { name: 'Banking & Finance',    positions: new Map() },
  healthcare_pharma:{ name: 'Pharmaceutical',       positions: new Map() },
  tech:             { name: 'Technology',            positions: new Map() },
  defense:          { name: 'Defense Industry',      positions: new Map() },
  labor:            { name: 'Labor Unions',          positions: new Map() },
  agriculture:      { name: 'Agriculture',           positions: new Map() },
  real_estate:      { name: 'Real Estate',           positions: new Map() },
  insurance:        { name: 'Insurance',             positions: new Map() },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load bill positions into the scorecard maps.
 *
 * Priority order:
 *   1. `industry_bill_positions` table (curated, explicit)
 *   2. `lobbying_data` table (inferred from 'support' / 'oppose' positions)
 *
 * Where both sources have a record for the same (industry, bill) pair the
 * curated table wins because it is processed first and the Map is not
 * overwritten.
 */
async function loadIndustryScorecards(): Promise<void> {
  // Reset all positions so this function is safe to call more than once.
  for (const scorecard of Object.values(INDUSTRY_SCORECARDS)) {
    scorecard.positions.clear();
  }

  // 1. Curated positions table
  const { data: curated, error: curatedErr } = await supabase
    .from('industry_bill_positions')
    .select('industry_key, bill_id, position');

  if (curatedErr) {
    console.warn(
      'Could not load industry_bill_positions table — continuing without curated data:',
      curatedErr.message
    );
  } else if (curated) {
    for (const row of curated as IndustryBillPositionRow[]) {
      const scorecard = INDUSTRY_SCORECARDS[row.industry_key];
      if (!scorecard) continue;
      const preferred: 'yea' | 'nay' = row.position === 'support' ? 'yea' : 'nay';
      scorecard.positions.set(row.bill_id, preferred);
    }
  }

  // 2. Lobbying data (inferred positions)
  const { data: lobbying, error: lobbyingErr } = await supabase
    .from('lobbying_data')
    .select('industry_key, bill_id, position')
    .in('position', ['support', 'oppose'])
    .not('bill_id', 'is', null)
    .not('industry_key', 'is', null);

  if (lobbyingErr) {
    console.warn(
      'Could not load lobbying_data positions — continuing without inferred data:',
      lobbyingErr.message
    );
  } else if (lobbying) {
    for (const row of lobbying as LobbyingPositionRow[]) {
      const scorecard = INDUSTRY_SCORECARDS[row.industry_key];
      if (!scorecard) continue;
      // Do NOT overwrite curated positions.
      if (scorecard.positions.has(row.bill_id)) continue;
      const preferred: 'yea' | 'nay' = row.position === 'support' ? 'yea' : 'nay';
      scorecard.positions.set(row.bill_id, preferred);
    }
  }
}

/**
 * Returns the top N donor industries for an official, ordered by total
 * contribution amount descending. Industries with no known scorecard key
 * are silently skipped so alignment math is always well-defined.
 */
async function getTopDonorIndustries(
  officialId: string,
  limit: number = 10
): Promise<Array<{ industry: string; total_amount: number }>> {
  const { data, error } = await supabase
    .from('contributions')
    .select('industry, amount')
    .eq('official_id', officialId)
    .not('industry', 'is', null);

  if (error || !data || data.length === 0) return [];

  const totals = new Map<string, number>();
  for (const row of data as ContributionRow[]) {
    const key = row.industry;
    if (!key || !INDUSTRY_SCORECARDS[key]) continue;
    totals.set(key, (totals.get(key) ?? 0) + Number(row.amount ?? 0));
  }

  return Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([industry, total_amount]) => ({ industry, total_amount }));
}

/**
 * Fetches all vote records for an official as a Map<bill_id, normalised_vote>.
 * Normalised vote values: 'yea' | 'nay' (abstain/present/absent are excluded
 * from scoring because they cannot be aligned with a donor preference).
 */
async function getOfficialVotes(
  officialId: string
): Promise<Map<string, 'yea' | 'nay'>> {
  const { data, error } = await supabase
    .from('vote_records')
    .select('bill_id, vote')
    .eq('official_id', officialId)
    .not('vote', 'is', null);

  const voteMap = new Map<string, 'yea' | 'nay'>();
  if (error || !data) return voteMap;

  for (const row of data as VoteRecordRow[]) {
    const normalised = normaliseVote(row.vote);
    if (normalised) voteMap.set(row.bill_id, normalised);
  }

  return voteMap;
}

/**
 * Normalise raw vote strings from varied data sources into 'yea' | 'nay'.
 * Returns null for abstain / present / absent / unknown values.
 */
function normaliseVote(raw: string | null): 'yea' | 'nay' | null {
  if (!raw) return null;
  const v = raw.toLowerCase().trim();
  if (v === 'yea' || v === 'yes' || v === 'aye' || v === '1') return 'yea';
  if (v === 'nay' || v === 'no' || v === 'noe' || v === '0') return 'nay';
  return null;
}

// ---------------------------------------------------------------------------
// Per-official alignment calculation
// ---------------------------------------------------------------------------

async function calculateOfficialAlignment(
  officialId: string
): Promise<DonorAlignmentResult> {
  const [topIndustries, officialVotes] = await Promise.all([
    getTopDonorIndustries(officialId),
    getOfficialVotes(officialId),
  ]);

  const topIndustryAlignments: IndustryAlignmentDetail[] = [];
  let globalScoredVotes = 0;
  let globalAlignedVotes = 0;

  for (const { industry, total_amount } of topIndustries) {
    const scorecard = INDUSTRY_SCORECARDS[industry];
    if (!scorecard || scorecard.positions.size === 0) continue;

    let votesScored = 0;
    let votesAligned = 0;

    for (const [billId, preferredVote] of scorecard.positions) {
      const officialVote = officialVotes.get(billId);
      if (!officialVote) continue; // official did not vote on this bill — skip

      votesScored++;
      if (officialVote === preferredVote) votesAligned++;
    }

    const alignmentPct =
      votesScored > 0 ? Math.round((votesAligned / votesScored) * 100) : 0;

    topIndustryAlignments.push({
      industry,
      donor_amount: total_amount,
      votes_scored: votesScored,
      votes_aligned: votesAligned,
      alignment_pct: alignmentPct,
    });

    globalScoredVotes += votesScored;
    globalAlignedVotes += votesAligned;
  }

  const alignmentScore =
    globalScoredVotes > 0
      ? Math.round((globalAlignedVotes / globalScoredVotes) * 100)
      : 0;

  // Sort details by donor amount descending for readability
  topIndustryAlignments.sort((a, b) => b.donor_amount - a.donor_amount);

  return {
    official_id: officialId,
    alignment_score: alignmentScore,
    total_scored_votes: globalScoredVotes,
    aligned_votes: globalAlignedVotes,
    top_industry_alignments: topIndustryAlignments,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persistResults(results: DonorAlignmentResult[]): Promise<void> {
  if (results.length === 0) return;

  // 1. Upsert top-level score into officials table
  const officialUpdates = results.map((r) => ({
    id: r.official_id,
    donor_alignment_score: r.alignment_score,
  }));

  for (const update of officialUpdates) {
    const { error } = await supabase
      .from('officials')
      .update({ donor_alignment_score: update.donor_alignment_score })
      .eq('id', update.id);

    if (error) {
      console.error(
        `Failed to update donor_alignment_score for official ${update.id}: ${error.message}`
      );
    }
  }

  // 2. Upsert detailed results into donor_alignment_details table
  const detailRows = results.map((r) => ({
    official_id: r.official_id,
    alignment_score: r.alignment_score,
    total_scored_votes: r.total_scored_votes,
    aligned_votes: r.aligned_votes,
    top_industry_alignments: r.top_industry_alignments,
    computed_at: new Date().toISOString(),
  }));

  const { error: detailError } = await supabase
    .from('donor_alignment_details')
    .upsert(detailRows, { onConflict: 'official_id' });

  if (detailError) {
    console.error(
      `Failed to upsert donor_alignment_details: ${detailError.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

export async function calculateDonorAlignments(): Promise<DonorAlignmentResult[]> {
  // 1. Populate scorecard positions from DB / lobbying data
  await loadIndustryScorecards();

  const totalPositions = Object.values(INDUSTRY_SCORECARDS).reduce(
    (sum, s) => sum + s.positions.size,
    0
  );
  console.log(`Loaded ${totalPositions} industry bill positions across ${Object.keys(INDUSTRY_SCORECARDS).length} industries`);

  // 2. Fetch all officials
  const { data: officials, error: officialsError } = await supabase
    .from('officials')
    .select('id');

  if (officialsError) {
    throw new Error(`Failed to fetch officials: ${officialsError.message}`);
  }

  if (!officials || officials.length === 0) {
    console.warn('No officials found in the database.');
    return [];
  }

  console.log(`Calculating donor alignment for ${officials.length} officials...`);

  // 3. Score each official — sequential to avoid overwhelming the DB
  const results: DonorAlignmentResult[] = [];

  for (const official of officials as Official[]) {
    const result = await calculateOfficialAlignment(official.id);
    results.push(result);
  }

  // 4. Persist
  await persistResults(results);

  return results;
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

if (process.argv[1]?.endsWith('donor-alignment.ts')) {
  calculateDonorAlignments()
    .then((results) => {
      console.log(`Processed ${results.length} officials`);

      const withVotes = results.filter((r) => r.total_scored_votes > 0);
      if (withVotes.length === 0) {
        console.log('No officials had scorable votes against donor industries.');
        return;
      }

      const avg =
        Math.round(
          withVotes.reduce((sum, r) => sum + r.alignment_score, 0) / withVotes.length
        );

      const buckets = { '0-24': 0, '25-49': 0, '50-74': 0, '75-100': 0 };
      for (const r of withVotes) {
        if (r.alignment_score < 25)       buckets['0-24']++;
        else if (r.alignment_score < 50)  buckets['25-49']++;
        else if (r.alignment_score < 75)  buckets['50-74']++;
        else                              buckets['75-100']++;
      }

      console.log(`Officials with scorable votes: ${withVotes.length}`);
      console.log(`Average donor alignment score: ${avg}`);
      console.log('Score distribution:', buckets);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
