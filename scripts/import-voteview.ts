/**
 * Import DW-NOMINATE ideology scores from VoteView bulk data.
 *
 * Data source: https://voteview.com/data
 *   Members CSV: https://voteview.com/static/data/out/members/HSall_members.csv
 *
 * Each row in the CSV represents a member's scores for a single congress.
 * This script filters to the target congress (default: 119) and upserts
 * scores into the `nominate_scores` table, matching members by bioguide_id.
 * It also back-fills `officials.metadata` with a `nominate` key so profile
 * pages have the data without a join.
 *
 * No external dependencies — uses built-in fetch and manual CSV parsing.
 *
 * Env vars (loaded from .env):
 *   PUBLIC_SUPABASE_URL       (required — via supabase-admin)
 *   SUPABASE_SERVICE_ROLE_KEY (required — via supabase-admin)
 *   CONGRESS_NUMBER           (optional, default 119)
 *
 * Run with:  npm run import:voteview
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VOTEVIEW_CSV_URL =
  'https://voteview.com/static/data/out/members/HSall_members.csv';

/** Number of rows flushed per Supabase upsert call. */
const BATCH_SIZE = 500;

/** Congress to import. Override with CONGRESS_NUMBER env var. */
const TARGET_CONGRESS = parseInt(process.env.CONGRESS_NUMBER ?? '119', 10);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Raw parsed row from HSall_members.csv.
 *
 * VoteView column order (as of 2025):
 *   congress, chamber, icpsr, state_icpsr, district_code, state_abbrev,
 *   party_code, occupancy, last_means, bioname, bioguide_id,
 *   born, died, nominate_dim1, nominate_dim2,
 *   nominate_log_likelihood, nominate_geo_mean_probability,
 *   nominate_number_of_votes, nominate_number_of_errors,
 *   conditional, nokken_poole_dim1, nokken_poole_dim2
 *
 * The CSV may add columns over time; we pick by header name, not index.
 */
interface VoteViewRow {
  congress: number;
  chamber: string;        // 'House' | 'Senate' | 'President'
  icpsr: number;
  state_abbrev: string;   // e.g. 'TX'
  party_code: number;     // 100 = Democrat, 200 = Republican, etc.
  bioname: string;        // "LAST, FIRST"
  bioguide_id: string;    // e.g. 'A000055' — may be empty for historical members
  born: number | null;
  died: number | null;
  nominate_dim1: number | null;  // primary ideology score: liberal(-1) → conservative(+1)
  nominate_dim2: number | null;  // secondary dimension (social/cross-cutting)
  nominate_log_likelihood: number | null;
  nominate_geo_mean_probability: number | null;
  nominate_number_of_votes: number | null;
  nominate_number_of_errors: number | null;
  nokken_poole_dim1: number | null;  // congress-specific (vs. career-span) score
  nokken_poole_dim2: number | null;
}

/** Shape inserted into the `nominate_scores` table. */
interface NominateScoreInsert {
  bioguide_id: string;
  congress: number;
  chamber: string;
  icpsr: number;
  party_code: number;
  state_abbrev: string;
  nominate_dim1: number | null;
  nominate_dim2: number | null;
  nominate_log_likelihood: number | null;
  nominate_geo_mean_probability: number | null;
  nominate_number_of_votes: number | null;
  nominate_number_of_errors: number | null;
  nokken_poole_dim1: number | null;
  nokken_poole_dim2: number | null;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// CSV parsing — no external deps
// ---------------------------------------------------------------------------

/**
 * Parse a single CSV line respecting double-quoted fields that may contain
 * commas. Does not handle escaped quotes (\") — VoteView CSVs don't use them.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      // Toggle quoted mode; handle "" as literal quote inside a quoted field.
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // skip next quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  fields.push(current);
  return fields;
}

/**
 * Parse the full CSV text into an array of typed VoteViewRow objects.
 * Selects columns by header name so column-order changes don't break parsing.
 */
function parseCsv(text: string): VoteViewRow[] {
  const lines = text.split('\n');
  if (lines.length < 2) {
    throw new Error('CSV appears empty — fewer than 2 lines');
  }

  // Normalise Windows line endings.
  const headers = parseCsvLine(lines[0].replace(/\r$/, '')).map((h) =>
    h.trim().toLowerCase(),
  );

  // Helper: get column index by name, throw if missing.
  function col(name: string): number {
    const idx = headers.indexOf(name.toLowerCase());
    if (idx === -1) {
      throw new Error(`Expected CSV column "${name}" not found. Headers: ${headers.join(', ')}`);
    }
    return idx;
  }

  // Resolve column indices once up front.
  const COL = {
    congress: col('congress'),
    chamber: col('chamber'),
    icpsr: col('icpsr'),
    state_abbrev: col('state_abbrev'),
    party_code: col('party_code'),
    bioname: col('bioname'),
    bioguide_id: col('bioguide_id'),
    born: col('born'),
    died: col('died'),
    nominate_dim1: col('nominate_dim1'),
    nominate_dim2: col('nominate_dim2'),
    nominate_log_likelihood: col('nominate_log_likelihood'),
    nominate_geo_mean_probability: col('nominate_geo_mean_probability'),
    nominate_number_of_votes: col('nominate_number_of_votes'),
    nominate_number_of_errors: col('nominate_number_of_errors'),
    nokken_poole_dim1: col('nokken_poole_dim1'),
    nokken_poole_dim2: col('nokken_poole_dim2'),
  } as const;

  const rows: VoteViewRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '').trim();
    if (!raw) continue;

    const fields = parseCsvLine(raw);
    if (fields.length < headers.length) continue; // malformed row — skip

    const num = (idx: number): number | null => {
      const v = fields[idx]?.trim();
      if (!v || v === '' || v.toLowerCase() === 'na' || v === '.') return null;
      const n = parseFloat(v);
      return isNaN(n) ? null : n;
    };

    const int = (idx: number): number => {
      return parseInt(fields[idx]?.trim() ?? '0', 10) || 0;
    };

    const str = (idx: number): string => {
      return fields[idx]?.trim() ?? '';
    };

    rows.push({
      congress: int(COL.congress),
      chamber: str(COL.chamber),
      icpsr: int(COL.icpsr),
      state_abbrev: str(COL.state_abbrev),
      party_code: int(COL.party_code),
      bioname: str(COL.bioname),
      bioguide_id: str(COL.bioguide_id),
      born: num(COL.born) !== null ? int(COL.born) : null,
      died: num(COL.died) !== null ? int(COL.died) : null,
      nominate_dim1: num(COL.nominate_dim1),
      nominate_dim2: num(COL.nominate_dim2),
      nominate_log_likelihood: num(COL.nominate_log_likelihood),
      nominate_geo_mean_probability: num(COL.nominate_geo_mean_probability),
      nominate_number_of_votes: num(COL.nominate_number_of_votes) !== null ? int(COL.nominate_number_of_votes) : null,
      nominate_number_of_errors: num(COL.nominate_number_of_errors) !== null ? int(COL.nominate_number_of_errors) : null,
      nokken_poole_dim1: num(COL.nokken_poole_dim1),
      nokken_poole_dim2: num(COL.nokken_poole_dim2),
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

async function downloadCsv(): Promise<string> {
  console.log(`  Downloading CSV from ${VOTEVIEW_CSV_URL} …`);
  const res = await fetch(VOTEVIEW_CSV_URL);
  if (!res.ok) {
    throw new Error(
      `VoteView returned HTTP ${res.status} ${res.statusText} for ${VOTEVIEW_CSV_URL}`,
    );
  }
  const text = await res.text();
  console.log(`  Downloaded ${(text.length / 1024).toFixed(1)} KB`);
  return text;
}

// ---------------------------------------------------------------------------
// Batch upsert helpers
// ---------------------------------------------------------------------------

/**
 * Upsert a batch of nominate_scores rows.
 * Returns counts of successes and errors.
 */
async function flushScores(
  batch: NominateScoreInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('nominate_scores')
    .upsert(batch, { onConflict: 'bioguide_id,congress' });

  if (error) {
    console.error(
      `\n  BATCH ERROR nominate_scores (${batch.length} rows): ${error.message}`,
    );
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

/**
 * Back-fill `officials.metadata` with the DW-NOMINATE summary for each
 * matched bioguide_id.  We use jsonb_set via a raw update rather than a
 * select-then-upsert to avoid overwriting other metadata keys.
 *
 * Supabase JS client doesn't expose jsonb_set directly, so we do a plain
 * update that merges the nominate object into the existing metadata using
 * Postgres's `||` JSONB concatenation operator via `.update()` with a
 * computed value.  Since the JS client doesn't support `||` natively, we
 * instead fetch the current metadata and merge in-process, then write back.
 * For a one-off import script this is acceptable — it's not hot-path code.
 */
async function updateOfficialMetadata(
  rows: VoteViewRow[],
): Promise<{ updated: number; notFound: number }> {
  let updated = 0;
  let notFound = 0;

  for (const row of rows) {
    if (!row.bioguide_id) {
      notFound++;
      continue;
    }

    // Fetch current metadata for this official.
    const { data: official, error: fetchErr } = await supabase
      .from('officials')
      .select('id, metadata')
      .eq('bioguide_id', row.bioguide_id)
      .maybeSingle();

    if (fetchErr) {
      console.warn(
        `\n  WARN fetch official bioguide=${row.bioguide_id}: ${fetchErr.message}`,
      );
      notFound++;
      continue;
    }

    if (!official) {
      notFound++;
      continue;
    }

    const officialRecord = official as { id: string; metadata: Record<string, unknown> };
    const existingMeta: Record<string, unknown> = officialRecord.metadata ?? {};

    const nominatePatch: Record<string, unknown> = {
      nominate: {
        dim1: row.nominate_dim1,
        dim2: row.nominate_dim2,
        log_likelihood: row.nominate_log_likelihood,
        geo_mean_probability: row.nominate_geo_mean_probability,
        number_of_votes: row.nominate_number_of_votes,
        number_of_errors: row.nominate_number_of_errors,
        nokken_poole_dim1: row.nokken_poole_dim1,
        nokken_poole_dim2: row.nokken_poole_dim2,
        congress: row.congress,
        party_code: row.party_code,
        icpsr: row.icpsr,
        source: 'voteview',
      },
    };

    const mergedMeta = { ...existingMeta, ...nominatePatch };

    const { error: updateErr } = await supabase
      .from('officials')
      .update({ metadata: mergedMeta })
      .eq('id', officialRecord.id);

    if (updateErr) {
      console.warn(
        `\n  WARN update official id=${officialRecord.id}: ${updateErr.message}`,
      );
      notFound++;
    } else {
      updated++;
      process.stdout.write('.');
    }
  }

  return { updated, notFound };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importVoteview(): Promise<void> {
  console.log(`=== Import VoteView DW-NOMINATE Scores (Congress ${TARGET_CONGRESS}) ===\n`);

  // 1. Download CSV.
  const csvText = await downloadCsv();

  // 2. Parse all rows.
  console.log('  Parsing CSV …');
  const allRows = parseCsv(csvText);
  console.log(`  Total rows in file: ${allRows.length.toLocaleString()}`);

  // 3. Filter to target congress. VoteView includes both 'House' and 'Senate'
  //    chamber values for Congress members; 'President' rows have no
  //    bioguide_id and should be dropped.
  const filtered = allRows.filter(
    (r) =>
      r.congress === TARGET_CONGRESS &&
      (r.chamber === 'House' || r.chamber === 'Senate'),
  );
  console.log(
    `  Rows for Congress ${TARGET_CONGRESS}: ${filtered.length} ` +
    `(House: ${filtered.filter((r) => r.chamber === 'House').length}, ` +
    `Senate: ${filtered.filter((r) => r.chamber === 'Senate').length})`,
  );

  // 4. Drop rows without a bioguide_id — historical members that predate the
  //    Biographical Directory of the U.S. Congress.
  const withId = filtered.filter((r) => r.bioguide_id.length > 0);
  const missingId = filtered.length - withId.length;
  if (missingId > 0) {
    console.log(`  Skipping ${missingId} row(s) with no bioguide_id`);
  }

  if (withId.length === 0) {
    console.log(
      `\n  No members found for Congress ${TARGET_CONGRESS}. ` +
      `If the congress has not started yet, VoteView may not have data for it. ` +
      `Try a lower CONGRESS_NUMBER (e.g. 118).`,
    );
    return;
  }

  // 5. Build insert objects for nominate_scores table.
  const scoreInserts: NominateScoreInsert[] = withId.map((r) => ({
    bioguide_id: r.bioguide_id,
    congress: r.congress,
    chamber: r.chamber.toLowerCase() as 'house' | 'senate',
    icpsr: r.icpsr,
    party_code: r.party_code,
    state_abbrev: r.state_abbrev,
    nominate_dim1: r.nominate_dim1,
    nominate_dim2: r.nominate_dim2,
    nominate_log_likelihood: r.nominate_log_likelihood,
    nominate_geo_mean_probability: r.nominate_geo_mean_probability,
    nominate_number_of_votes: r.nominate_number_of_votes,
    nominate_number_of_errors: r.nominate_number_of_errors,
    nokken_poole_dim1: r.nokken_poole_dim1,
    nokken_poole_dim2: r.nokken_poole_dim2,
    metadata: {
      bioname: r.bioname,
      born: r.born,
      died: r.died,
    },
  }));

  // 6. Upsert into nominate_scores in batches.
  console.log(`\n  Upserting ${scoreInserts.length} score row(s) into nominate_scores …\n`);

  let totalOk = 0;
  let totalErr = 0;

  for (let i = 0; i < scoreInserts.length; i += BATCH_SIZE) {
    const chunk = scoreInserts.slice(i, i + BATCH_SIZE);
    const { ok, err } = await flushScores(chunk);
    totalOk += ok;
    totalErr += err;

    const batchEnd = Math.min(i + BATCH_SIZE, scoreInserts.length);
    process.stdout.write(
      `  [${batchEnd}/${scoreInserts.length}] upserted=${totalOk} err=${totalErr}\n`,
    );
  }

  // 7. Back-fill officials.metadata with nominate summary.
  console.log(
    `\n  Back-filling officials.metadata with DW-NOMINATE summary …\n  (one dot per match)\n`,
  );

  const { updated, notFound } = await updateOfficialMetadata(withId);

  // 8. Summary.
  console.log(
    `\n\n=== Completed ===\n` +
    `  nominate_scores upserted : ${totalOk}\n` +
    `  nominate_scores errors   : ${totalErr}\n` +
    `  officials.metadata updated: ${updated}\n` +
    `  officials not found       : ${notFound} ` +
    `(historical members or not yet imported via import:congress)\n`,
  );
}

importVoteview().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
