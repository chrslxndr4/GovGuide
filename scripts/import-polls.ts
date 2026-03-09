/**
 * Import FiveThirtyEight-style polling data from a CSV file.
 *
 * Requires environment variable:  POLLS_CSV_PATH
 * Point it at a local CSV file, e.g.:
 *   POLLS_CSV_PATH=./data/president_polls.csv npm run import:polls
 *
 * Expected CSV columns (order-independent, header row required):
 *   pollster, poll_id, question_id, race_type, geography,
 *   start_date, end_date, sample_size, methodology,
 *   margin_of_error, candidate_name, pct
 *
 * Processing logic:
 *   1. Parse the CSV and group rows by poll_id + question_id into a single
 *      poll record, aggregating candidate names/percentages into a JSONB object.
 *   2. Upsert poll records in batches of BATCH_SIZE.
 *   3. Derive a unique pollster_ratings row per pollster and upsert those.
 *      Accuracy/bias/races_polled values are seeded from whatever is present in
 *      the CSV; callers can layer in actual FiveThirtyEight ratings by adding
 *      accuracy_score, mean_bias, races_polled, methodology_rating columns.
 *
 * Run with:  npm run import:polls
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One row as it comes out of the CSV parser. */
interface CsvRow {
  pollster: string;
  poll_id: string;
  question_id: string;
  race_type: string;
  geography: string;
  start_date: string;
  end_date: string;
  sample_size: string;
  methodology: string;
  margin_of_error: string;
  candidate_name: string;
  pct: string;
  // Optional FiveThirtyEight rating columns that may be present.
  accuracy_score?: string;
  mean_bias?: string;
  races_polled?: string;
  methodology_rating?: string;
  [key: string]: string | undefined;
}

/** Shape written to the polls table. */
interface PollInsert {
  pollster: string;
  race_type: string | null;
  geography: string | null;
  date_conducted: string | null;
  sample_size: number | null;
  methodology: string | null;
  margin_of_error: number | null;
  candidates: Record<string, number>;
  metadata: Record<string, unknown>;
}

/** Shape written to the pollster_ratings table. */
interface PollsterRatingInsert {
  pollster: string;
  accuracy_score: number | null;
  mean_bias: number | null;
  races_polled: number | null;
  methodology_rating: string | null;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * Parse a line respecting quoted fields that may contain commas.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped double-quote inside a quoted field.
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }

  fields.push(current.trim());
  return fields;
}

/**
 * Read a CSV file and yield typed row objects.  The header row is used to map
 * column positions to field names so column order does not matter.
 */
async function* parseCsvFile(filePath: string): AsyncGenerator<CsvRow> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let headers: string[] = [];
  let isFirstLine = true;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (isFirstLine) {
      headers = parseCsvLine(trimmed).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
      isFirstLine = false;
      continue;
    }

    const values = parseCsvLine(trimmed);
    const row: Record<string, string | undefined> = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] ?? '';
    });

    yield row as CsvRow;
  }
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function nullableString(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed !== '' ? trimmed : null;
}

function nullableNumber(value: string | undefined): number | null {
  const trimmed = (value ?? '').trim();
  if (trimmed === '' || trimmed === 'NA' || trimmed === 'N/A') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise a date string to ISO format (YYYY-MM-DD).
 * Accepts "MM/DD/YYYY", "YYYY-MM-DD", and ISO timestamps.
 * Returns null when the value cannot be parsed.
 */
function normaliseDate(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;

  // Already ISO (or ISO timestamp) — strip time component.
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return trimmed.slice(0, 10);
  }

  // MM/DD/YYYY
  const mdyMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdyMatch) {
    const [, month, day, year] = mdyMatch;
    return `${year}-${month!.padStart(2, '0')}-${day!.padStart(2, '0')}`;
  }

  console.warn(`  WARNING: Unrecognised date format "${trimmed}" — storing null`);
  return null;
}

/**
 * Build a stable composite key that uniquely identifies a (poll, question) pair.
 * Falls back to a pollster+date+geo combo when poll_id is missing.
 */
function buildPollKey(row: CsvRow): string {
  const pollId = nullableString(row.poll_id);
  const questionId = nullableString(row.question_id);

  if (pollId) {
    return questionId ? `${pollId}::${questionId}` : pollId;
  }

  // Fallback composite key.
  const parts = [
    nullableString(row.pollster) ?? 'unknown',
    nullableString(row.race_type) ?? '',
    nullableString(row.geography) ?? '',
    normaliseDate(row.end_date) ?? '',
  ];
  return parts.join('::');
}

// ---------------------------------------------------------------------------
// Accumulation structures
// ---------------------------------------------------------------------------

interface AccumulatedPoll {
  pollster: string;
  race_type: string | null;
  geography: string | null;
  date_conducted: string | null;
  sample_size: number | null;
  methodology: string | null;
  margin_of_error: number | null;
  candidates: Record<string, number>;
  poll_id: string | null;
  question_id: string | null;
}

interface AccumulatedRating {
  accuracy_score: number | null;
  mean_bias: number | null;
  races_polled: number | null;
  methodology_rating: string | null;
}

// ---------------------------------------------------------------------------
// Batch upsert helpers
// ---------------------------------------------------------------------------

async function flushPolls(
  batch: PollInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('polls')
    .upsert(batch, {
      // No globally unique column other than id; treat each batch row as a new
      // record.  To make this idempotent across re-runs, callers can add a
      // unique constraint on (pollster, race_type, geography, date_conducted)
      // and switch to onConflict targeting those columns.
      ignoreDuplicates: false,
    });

  if (error) {
    console.error(`  BATCH ERROR flushing ${batch.length} polls: ${error.message}`);
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

async function flushPollsterRatings(
  batch: PollsterRatingInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('pollster_ratings')
    .upsert(batch, { onConflict: 'pollster' });

  if (error) {
    console.error(
      `  BATCH ERROR flushing ${batch.length} pollster_ratings: ${error.message}`,
    );
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importPolls(): Promise<void> {
  console.log('=== Import Polls ===\n');

  const csvPath = process.env.POLLS_CSV_PATH;
  if (!csvPath) {
    throw new Error(
      'Missing environment variable: POLLS_CSV_PATH\n' +
        'Set it to the path of your FiveThirtyEight-style CSV file.\n' +
        'Example:  POLLS_CSV_PATH=./data/president_polls.csv npm run import:polls',
    );
  }

  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found: ${csvPath}`);
  }

  console.log(`Reading CSV: ${csvPath}\n`);

  // -------------------------------------------------------------------------
  // Pass 1: group rows by poll key into accumulated poll objects.
  // Track per-pollster rating data at the same time.
  // -------------------------------------------------------------------------

  const pollMap = new Map<string, AccumulatedPoll>();
  const pollsterMap = new Map<string, AccumulatedRating>();
  let csvRowCount = 0;

  for await (const row of parseCsvFile(csvPath)) {
    csvRowCount++;

    const key = buildPollKey(row);
    const candidateName = nullableString(row.candidate_name);
    const pct = nullableNumber(row.pct);

    if (!pollMap.has(key)) {
      pollMap.set(key, {
        pollster: nullableString(row.pollster) ?? 'Unknown',
        race_type: nullableString(row.race_type),
        geography: nullableString(row.geography),
        date_conducted: normaliseDate(row.end_date),
        sample_size: nullableNumber(row.sample_size),
        methodology: nullableString(row.methodology),
        margin_of_error: nullableNumber(row.margin_of_error),
        candidates: {},
        poll_id: nullableString(row.poll_id),
        question_id: nullableString(row.question_id),
      });
    }

    const poll = pollMap.get(key)!;

    // Accumulate candidate percentages.
    if (candidateName && pct !== null) {
      poll.candidates[candidateName] = pct;
    }

    // Accumulate pollster rating data (last non-null value wins per pollster).
    const pollster = poll.pollster;
    if (!pollsterMap.has(pollster)) {
      pollsterMap.set(pollster, {
        accuracy_score: null,
        mean_bias: null,
        races_polled: null,
        methodology_rating: null,
      });
    }

    const rating = pollsterMap.get(pollster)!;
    const accuracyScore = nullableNumber(row.accuracy_score);
    const meanBias = nullableNumber(row.mean_bias);
    const racesPolled = nullableNumber(row.races_polled);
    const methodologyRating = nullableString(row.methodology_rating);

    if (accuracyScore !== null) rating.accuracy_score = accuracyScore;
    if (meanBias !== null) rating.mean_bias = meanBias;
    if (racesPolled !== null) rating.races_polled = racesPolled;
    if (methodologyRating !== null) rating.methodology_rating = methodologyRating;
  }

  console.log(`Parsed ${csvRowCount} CSV rows into ${pollMap.size} distinct polls`);
  console.log(`Unique pollsters: ${pollsterMap.size}\n`);

  // -------------------------------------------------------------------------
  // Pass 2: upsert poll records in batches of BATCH_SIZE.
  // -------------------------------------------------------------------------

  let pollsInserted = 0;
  let pollsError = 0;
  let batchBuffer: PollInsert[] = [];

  for (const [key, accumulated] of pollMap) {
    const record: PollInsert = {
      pollster: accumulated.pollster,
      race_type: accumulated.race_type,
      geography: accumulated.geography,
      date_conducted: accumulated.date_conducted,
      sample_size: accumulated.sample_size,
      methodology: accumulated.methodology,
      margin_of_error: accumulated.margin_of_error,
      candidates: accumulated.candidates,
      metadata: {
        poll_id: accumulated.poll_id,
        question_id: accumulated.question_id,
        source_key: key,
      },
    };

    batchBuffer.push(record);

    if (batchBuffer.length >= BATCH_SIZE) {
      const { ok, err } = await flushPolls(batchBuffer.splice(0, BATCH_SIZE));
      pollsInserted += ok;
      pollsError += err;
      process.stdout.write(`  Flushed poll batch (ok=${ok}, err=${err})\n`);
    }
  }

  // Flush remaining polls.
  if (batchBuffer.length > 0) {
    const { ok, err } = await flushPolls(batchBuffer);
    pollsInserted += ok;
    pollsError += err;
    process.stdout.write(`  Flushed final poll batch (ok=${ok}, err=${err})\n`);
  }

  console.log(`\nPolls: inserted/updated=${pollsInserted}, errors=${pollsError}`);

  // -------------------------------------------------------------------------
  // Pass 3: upsert pollster_ratings in batches of BATCH_SIZE.
  // -------------------------------------------------------------------------

  let ratingsInserted = 0;
  let ratingsError = 0;
  let ratingsBatch: PollsterRatingInsert[] = [];

  for (const [pollster, rating] of pollsterMap) {
    ratingsBatch.push({
      pollster,
      accuracy_score: rating.accuracy_score,
      mean_bias: rating.mean_bias,
      races_polled: rating.races_polled,
      methodology_rating: rating.methodology_rating,
      metadata: {},
    });

    if (ratingsBatch.length >= BATCH_SIZE) {
      const { ok, err } = await flushPollsterRatings(
        ratingsBatch.splice(0, BATCH_SIZE),
      );
      ratingsInserted += ok;
      ratingsError += err;
      process.stdout.write(
        `  Flushed pollster_ratings batch (ok=${ok}, err=${err})\n`,
      );
    }
  }

  if (ratingsBatch.length > 0) {
    const { ok, err } = await flushPollsterRatings(ratingsBatch);
    ratingsInserted += ok;
    ratingsError += err;
    process.stdout.write(
      `  Flushed final pollster_ratings batch (ok=${ok}, err=${err})\n`,
    );
  }

  console.log(
    `Pollster ratings: inserted/updated=${ratingsInserted}, errors=${ratingsError}`,
  );

  console.log(
    `\n=== Completed. Polls: ${pollsInserted} upserted, ${pollsError} errors. ` +
      `Ratings: ${ratingsInserted} upserted, ${ratingsError} errors. ===`,
  );
}

importPolls().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
