/**
 * Donor-Vote Conflict Detector
 *
 * Identifies roll call votes where an official voted on a bill that affects
 * industries that are among their top donors.  For each match, a row is
 * inserted into `conflict_alerts` with alert_type = 'donor_vote'.
 *
 * Detection logic
 * ---------------
 * 1. Join vote_positions → roll_call_votes → bills → mv_official_industry_funding
 *    on overlapping NAICS codes (bills.naics_affected && ARRAY[naics_code]).
 * 2. Only consider industry funding totals above $10,000 per cycle.
 * 3. Severity is scaled 1–10 using a logarithmic curve so that funding amounts
 *    from $10,001 → ~$10M map smoothly across the full range.
 * 4. Existing alerts (same official + bill + naics_code) are skipped to keep
 *    the function idempotent across re-runs.
 *
 * Usage
 * -----
 *   import { detectDonorVoteConflicts } from './detectors/donor-vote.js';
 *   const summary = await detectDonorVoteConflicts();
 *
 * Environment variables required (loaded from .env via dotenv/config):
 *   PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import 'dotenv/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

function buildClient(): SupabaseClient {
  const url = process.env['PUBLIC_SUPABASE_URL'];
  const key = process.env['SUPABASE_SERVICE_ROLE_KEY'];

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
// Types
// ---------------------------------------------------------------------------

/**
 * Raw row returned by the conflict-detection query.
 * Column names mirror exactly what the SQL SELECT projects.
 */
interface ConflictRow {
  official_id: string;
  bill_uuid: string;
  naics_affected: string[];
  naics_code: string;
  total_amount: number;
  position: string;
  industry: string | null;
  bill_title: string | null;
  vote_date: string | null;
  vote_id: string;
}

/** Shape written to conflict_alerts.evidence */
interface DonorVoteEvidence {
  naics_code: string;
  industry: string | null;
  industry_funding: number;
  vote_position: string;
  bill_title: string | null;
  vote_date: string | null;
}

export interface DetectorSummary {
  inspected: number;
  inserted: number;
  skipped: number;
  errors: string[];
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Severity scoring
// ---------------------------------------------------------------------------

/**
 * Map a funding amount to a severity score in the range [1, 10].
 *
 * Uses a log10 curve anchored so that:
 *   $10,001  → ~1.0
 *   ~$10M    → 10.0
 *
 * Amounts below the threshold are clamped to 1; amounts above $10M are
 * clamped to 10.
 */
function calculateSeverity(totalAmount: number): number {
  const MIN_AMOUNT = 10_000;
  const MAX_AMOUNT = 10_000_000;

  const clamped = Math.max(MIN_AMOUNT, Math.min(MAX_AMOUNT, totalAmount));

  // Normalise log10(amount) into [1, 10].
  const logMin = Math.log10(MIN_AMOUNT);   // 4
  const logMax = Math.log10(MAX_AMOUNT);   // 7
  const logVal = Math.log10(clamped);

  const normalised = (logVal - logMin) / (logMax - logMin); // [0, 1]
  const score = 1 + normalised * 9;                         // [1, 10]

  // Round to one decimal place and clamp tightly.
  return Math.min(10, Math.max(1, Math.round(score * 10) / 10));
}

// ---------------------------------------------------------------------------
// Core SQL
// ---------------------------------------------------------------------------

/**
 * The query intentionally avoids Supabase ORM methods because it requires a
 * cross-join on array overlap (&&) against a materialised view — a pattern
 * not expressible via the Supabase filter API.  We therefore fall back to
 * supabase.rpc() backed by a helper SQL function, or — when that function
 * does not exist — a direct execute via the REST /rpc endpoint is unavailable,
 * so we use the Postgres REST sql endpoint exposed by the service role.
 *
 * To keep zero external dependencies the query is issued via
 * `supabase.rpc('exec_sql', { query })` where `exec_sql` is a trusted
 * SECURITY DEFINER function that accepts arbitrary SQL.  If that function is
 * not available the detector falls back to executing a named RPC function
 * `get_donor_vote_conflicts` which must return the same columns.
 *
 * If neither RPC exists, the detector logs an actionable error message and
 * exits without throwing so the broader run harness can continue.
 */
const CONFLICT_QUERY = `
SELECT
  o.id                   AS official_id,
  b.id                   AS bill_uuid,
  b.naics_affected,
  mif.naics_code,
  mif.total_amount,
  mif.industry,
  vp.position,
  b.title                AS bill_title,
  rcv.vote_date,
  vp.vote_id
FROM vote_positions        vp
JOIN officials             o   ON o.id   = vp.official_id
JOIN roll_call_votes       rcv ON rcv.id = vp.vote_id
JOIN bills                 b   ON b.id   = rcv.bill_id
JOIN mv_official_industry_funding mif
                               ON mif.official_id = o.id
WHERE b.naics_affected && ARRAY[mif.naics_code]
  AND mif.total_amount > 10000
ORDER BY mif.total_amount DESC;
`.trim();

// ---------------------------------------------------------------------------
// Conflict alert deduplication
// ---------------------------------------------------------------------------

/**
 * Build a unique string key per (official, bill, naics_code) triple so we
 * can skip alerts that are already recorded without an extra DB round trip
 * per row after the first bulk fetch.
 */
function conflictKey(officialId: string, billUuid: string, naicsCode: string): string {
  return `${officialId}::${billUuid}::${naicsCode}`;
}

/**
 * Fetch the set of (official_id, bill_id, naics_code) triples that already
 * exist in conflict_alerts so we can skip duplicates efficiently.
 */
async function fetchExistingConflictKeys(supabase: SupabaseClient): Promise<Set<string>> {
  const existing = new Set<string>();

  // Page through all existing donor_vote alerts so we never exceed the
  // default Supabase row limit of 1,000.
  const PAGE_SIZE = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('conflict_alerts')
      .select('official_id, bill_id, evidence')
      .eq('alert_type', 'donor_vote')
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Failed to fetch existing conflict alerts: ${error.message}`);
    }

    if (!data || data.length === 0) break;

    for (const row of data as Array<{
      official_id: string;
      bill_id: string;
      evidence: { naics_code?: string } | null;
    }>) {
      const naicsCode = row.evidence?.naics_code ?? '';
      existing.add(conflictKey(row.official_id, row.bill_id, naicsCode));
    }

    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return existing;
}

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

/**
 * Execute the detection query.  Attempts three strategies in order:
 *
 *   1. `supabase.rpc('exec_sql', { query: SQL })` — a generic trusted SQL
 *      executor, common in service-role tooling setups.
 *   2. `supabase.rpc('get_donor_vote_conflicts')` — a named, purpose-built
 *      RPC function that encapsulates the query inside the database.
 *
 * If both fail the function throws so the caller can surface the error.
 */
async function runConflictQuery(supabase: SupabaseClient): Promise<ConflictRow[]> {
  // Strategy 1: generic exec_sql RPC.
  {
    const { data, error } = await supabase.rpc('exec_sql', { query: CONFLICT_QUERY });

    if (!error) {
      return (data ?? []) as ConflictRow[];
    }

    // Only continue to the next strategy when the function simply doesn't exist.
    const isNotFound =
      error.code === '42883' ||               // undefined_function (PostgreSQL)
      error.message.includes('exec_sql') ||
      error.message.includes('does not exist');

    if (!isNotFound) {
      throw new Error(`exec_sql RPC failed: ${error.message}`);
    }
  }

  // Strategy 2: named purpose-built RPC.
  {
    const { data, error } = await supabase.rpc('get_donor_vote_conflicts');

    if (!error) {
      return (data ?? []) as ConflictRow[];
    }

    throw new Error(
      `get_donor_vote_conflicts RPC failed: ${error.message}\n` +
        'Neither exec_sql nor get_donor_vote_conflicts RPC functions are available.\n' +
        'Create one of these functions in your Supabase project, or apply the\n' +
        'following migration to create exec_sql:\n\n' +
        "  CREATE OR REPLACE FUNCTION exec_sql(query text)\n" +
        "  RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$\n" +
        "  DECLARE result json;\n" +
        "  BEGIN\n" +
        "    EXECUTE 'SELECT json_agg(r) FROM (' || query || ') r' INTO result;\n" +
        "    RETURN COALESCE(result, '[]'::json);\n" +
        "  END;\n" +
        "  $$;\n",
    );
  }
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Detect donor-vote conflicts and insert alerts into `conflict_alerts`.
 *
 * The function is idempotent: re-running will skip alerts that are already
 * present (matched on official_id + bill_id + evidence.naics_code).
 *
 * @returns A summary object describing what was found, inserted, and skipped.
 */
export async function detectDonorVoteConflicts(): Promise<DetectorSummary> {
  const start = Date.now();

  const summary: DetectorSummary = {
    inspected: 0,
    inserted: 0,
    skipped: 0,
    errors: [],
    duration_ms: 0,
  };

  const supabase = buildClient();

  console.log('[donor-vote] Starting conflict detection...');

  // ------------------------------------------------------------------
  // 1. Run the detection query.
  // ------------------------------------------------------------------

  let rows: ConflictRow[];
  try {
    rows = await runConflictQuery(supabase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[donor-vote] Query execution failed: ${msg}`);
    summary.errors.push(msg);
    summary.duration_ms = Date.now() - start;
    return summary;
  }

  console.log(`[donor-vote] Query returned ${rows.length} candidate conflict(s).`);
  summary.inspected = rows.length;

  if (rows.length === 0) {
    summary.duration_ms = Date.now() - start;
    return summary;
  }

  // ------------------------------------------------------------------
  // 2. Fetch existing alert keys to enable idempotent re-runs.
  // ------------------------------------------------------------------

  let existingKeys: Set<string>;
  try {
    existingKeys = await fetchExistingConflictKeys(supabase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[donor-vote] Could not fetch existing alerts: ${msg}`);
    summary.errors.push(`existing-alert fetch: ${msg}`);
    summary.duration_ms = Date.now() - start;
    return summary;
  }

  console.log(`[donor-vote] ${existingKeys.size} existing donor_vote alert(s) on record.`);

  // ------------------------------------------------------------------
  // 3. Insert new alerts.
  // ------------------------------------------------------------------

  for (const row of rows) {
    const key = conflictKey(row.official_id, row.bill_uuid, row.naics_code);

    if (existingKeys.has(key)) {
      summary.skipped++;
      continue;
    }

    const severityScore = calculateSeverity(row.total_amount);

    const evidence: DonorVoteEvidence = {
      naics_code:       row.naics_code,
      industry:         row.industry ?? null,
      industry_funding: row.total_amount,
      vote_position:    row.position,
      bill_title:       row.bill_title ?? null,
      vote_date:        row.vote_date ?? null,
    };

    const description =
      `Official ${row.official_id} voted "${row.position}" on bill ` +
      `"${row.bill_title ?? row.bill_uuid}" while receiving ` +
      `$${row.total_amount.toLocaleString()} from ` +
      `${row.industry ?? `NAICS ${row.naics_code}`} — an affected industry.`;

    const alertRow = {
      alert_type:     'donor_vote',
      official_id:    row.official_id,
      bill_id:        row.bill_uuid,
      description,
      evidence,
      severity_score: severityScore,
      status:         'active',
    };

    const { error: insertError } = await supabase
      .from('conflict_alerts')
      .insert(alertRow);

    if (insertError) {
      // 23505 = unique_violation — treat as a skip rather than a hard error
      // in case the existing-key set was stale.
      if (insertError.code === '23505') {
        summary.skipped++;
        existingKeys.add(key); // prevent redundant retries in same run
        continue;
      }

      const msg =
        `Insert failed for official=${row.official_id} bill=${row.bill_uuid} ` +
        `naics=${row.naics_code}: ${insertError.message}`;
      console.error(`[donor-vote] ${msg}`);
      summary.errors.push(msg);
      continue;
    }

    existingKeys.add(key);
    summary.inserted++;

    console.log(
      `[donor-vote] Alert inserted — severity=${severityScore} ` +
        `official=${row.official_id} bill=${row.bill_uuid} naics=${row.naics_code}`,
    );
  }

  summary.duration_ms = Date.now() - start;

  console.log('[donor-vote] Detection complete.', {
    inspected: summary.inspected,
    inserted:  summary.inserted,
    skipped:   summary.skipped,
    errors:    summary.errors.length,
    duration:  `${summary.duration_ms}ms`,
  });

  return summary;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
// Allows direct execution:  npx tsx scripts/pipeline/detectors/donor-vote.ts

if (
  process.argv[1] &&
  (process.argv[1].endsWith('donor-vote.ts') || process.argv[1].endsWith('donor-vote.js'))
) {
  detectDonorVoteConflicts()
    .then((summary) => {
      if (summary.errors.length > 0) {
        console.error('[donor-vote] Completed with errors:', summary.errors);
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error('[donor-vote] Unhandled error:', err);
      process.exit(1);
    });
}
