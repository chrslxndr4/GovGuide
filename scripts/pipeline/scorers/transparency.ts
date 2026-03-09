import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TransparencyComponents {
  disclosure_compliance: number; // 0-100
  voting_attendance: number;     // 0-100
  small_donor_pct: number;       // 0-100
  conflict_score: number;        // 0-100
  stock_compliance: number;      // 0-100
}

interface OfficialScore {
  official_id: string;
  score: number;      // 0-100 weighted composite
  grade: string;      // A, B, C, D, F
  components: TransparencyComponents;
}

interface Official {
  id: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Weight constants (must sum to 1.0)
// ---------------------------------------------------------------------------

const WEIGHTS = {
  disclosure_compliance: 0.30,
  voting_attendance:     0.25,
  small_donor_pct:       0.15,
  conflict_score:        0.15,
  stock_compliance:      0.15,
} as const;

// ---------------------------------------------------------------------------
// Component scorers
// ---------------------------------------------------------------------------

/**
 * Financial Disclosure Compliance (30%)
 *
 * 100 if all required disclosures were filed on time.
 * Deduct points for late filings and missing filings.
 */
async function scoreDisclosureCompliance(officialId: string): Promise<number> {
  const { data, error } = await supabase
    .from('financial_disclosures')
    .select('filed_on_time, is_missing')
    .eq('official_id', officialId);

  if (error || !data || data.length === 0) {
    // No disclosure records — treat as missing, return minimum passing score
    return 0;
  }

  const total = data.length;
  let deductions = 0;

  for (const record of data) {
    if (record.is_missing) {
      deductions += 20; // heavy penalty for outright missing disclosure
    } else if (!record.filed_on_time) {
      deductions += 10; // moderate penalty for late filing
    }
  }

  // Normalise deductions so a single infraction on a large record set is less
  // catastrophic than on a small one.
  const maxDeduction = total * 20;
  const score = 100 - Math.round((deductions / maxDeduction) * 100);
  return Math.max(0, Math.min(100, score));
}

/**
 * Voting Attendance (25%)
 *
 * Percentage of recorded votes the official participated in vs the total
 * number of votes held in their chamber during their tenure.
 */
async function scoreVotingAttendance(officialId: string): Promise<number> {
  // Total votes the official was recorded as casting
  const { count: participated, error: pErr } = await supabase
    .from('vote_records')
    .select('*', { count: 'exact', head: true })
    .eq('official_id', officialId)
    .not('vote', 'is', null);

  if (pErr) return 50; // neutral fallback on query failure

  // Total votes in chamber — join via the votes table
  const { data: official, error: oErr } = await supabase
    .from('officials')
    .select('chamber')
    .eq('id', officialId)
    .single();

  if (oErr || !official?.chamber) return 50;

  const { count: total, error: tErr } = await supabase
    .from('votes')
    .select('*', { count: 'exact', head: true })
    .eq('chamber', official.chamber);

  if (tErr || !total || total === 0) return 50;

  const attendance = (participated ?? 0) / total;
  return Math.round(Math.min(1, attendance) * 100);
}

/**
 * Small Donor Percentage (15%)
 *
 * Percentage of total campaign contribution dollars that came from donors
 * giving less than $200 in aggregate. Higher percentage = better score.
 */
async function scoreSmallDonorPct(officialId: string): Promise<number> {
  const { data, error } = await supabase
    .from('contributions')
    .select('amount, is_small_donor')
    .eq('official_id', officialId);

  if (error || !data || data.length === 0) return 50; // neutral fallback

  let totalAmount = 0;
  let smallDonorAmount = 0;

  for (const row of data) {
    const amount = Number(row.amount ?? 0);
    totalAmount += amount;
    if (row.is_small_donor) {
      smallDonorAmount += amount;
    }
  }

  if (totalAmount === 0) return 50;

  const pct = smallDonorAmount / totalAmount;
  return Math.round(Math.min(1, pct) * 100);
}

/**
 * Conflict of Interest Count (15%)
 *
 * Number of active conflict alerts. 0 conflicts = 100. Each conflict
 * reduces the score by 20 points, floored at 0.
 */
async function scoreConflictOfInterest(officialId: string): Promise<number> {
  const { count, error } = await supabase
    .from('conflict_alerts')
    .select('*', { count: 'exact', head: true })
    .eq('official_id', officialId)
    .eq('is_active', true);

  if (error) return 50; // neutral fallback

  const conflicts = count ?? 0;
  return Math.max(0, 100 - conflicts * 20);
}

/**
 * STOCK Act Compliance (15%)
 *
 * Trade disclosure timeliness. 100 if no late filings; deduct points per
 * late filing. Officials with no trades are considered fully compliant.
 */
async function scoreStockActCompliance(officialId: string): Promise<number> {
  const { data, error } = await supabase
    .from('stock_trades')
    .select('filed_on_time')
    .eq('official_id', officialId);

  if (error) return 50; // neutral fallback
  if (!data || data.length === 0) return 100; // no trades = fully compliant

  const total = data.length;
  const lateCount = data.filter((t) => !t.filed_on_time).length;

  const score = 100 - Math.round((lateCount / total) * 100);
  return Math.max(0, score);
}

// ---------------------------------------------------------------------------
// Grade mapping
// ---------------------------------------------------------------------------

function mapGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

// ---------------------------------------------------------------------------
// Main scorer
// ---------------------------------------------------------------------------

export async function calculateTransparencyScores(): Promise<OfficialScore[]> {
  // 1. Fetch all officials
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

  const results: OfficialScore[] = [];

  // 2. Score each official
  for (const official of officials as Official[]) {
    const [
      disclosure_compliance,
      voting_attendance,
      small_donor_pct,
      conflict_score,
      stock_compliance,
    ] = await Promise.all([
      scoreDisclosureCompliance(official.id),
      scoreVotingAttendance(official.id),
      scoreSmallDonorPct(official.id),
      scoreConflictOfInterest(official.id),
      scoreStockActCompliance(official.id),
    ]);

    const components: TransparencyComponents = {
      disclosure_compliance,
      voting_attendance,
      small_donor_pct,
      conflict_score,
      stock_compliance,
    };

    // 4. Weighted composite
    const score = Math.round(
      disclosure_compliance * WEIGHTS.disclosure_compliance +
      voting_attendance     * WEIGHTS.voting_attendance     +
      small_donor_pct       * WEIGHTS.small_donor_pct       +
      conflict_score        * WEIGHTS.conflict_score        +
      stock_compliance      * WEIGHTS.stock_compliance
    );

    // 5. Grade
    const grade = mapGrade(score);

    results.push({ official_id: official.id, score, grade, components });

    // 6. Upsert into officials table
    const { error: upsertError } = await supabase
      .from('officials')
      .update({
        transparency_score: score,
        transparency_grade: grade,
      })
      .eq('id', official.id);

    if (upsertError) {
      console.error(
        `Failed to upsert score for official ${official.id}: ${upsertError.message}`
      );
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

if (process.argv[1]?.endsWith('transparency.ts')) {
  calculateTransparencyScores()
    .then((results) => {
      console.log(`Scored ${results.length} officials`);
      const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
      for (const r of results) grades[r.grade as keyof typeof grades]++;
      console.log('Grade distribution:', grades);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
