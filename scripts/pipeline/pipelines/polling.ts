/**
 * Polling Pipeline
 *
 * Fetches polling data and pollster ratings from public sources and loads them
 * into the `polls` and `pollster_ratings` tables.
 *
 * Data sources (in priority order, with graceful fallback on each):
 *   1. FiveThirtyEight / ABC News polling averages dataset (CSV export)
 *   2. FiveThirtyEight pollster ratings dataset (CSV export)
 *   3. RealClearPolitics polling data (JSON endpoints where available)
 *
 * All sources are treated as best-effort. When a source URL is unreachable or
 * returns unexpected data, the pipeline logs the failure with a clear message
 * and continues to the next source rather than aborting the entire run.
 *
 * No API keys are required — all sources are publicly accessible.
 */

import { BasePipeline } from '../base.js';

// ---------------------------------------------------------------------------
// Constants — public data export URLs
// ---------------------------------------------------------------------------

/**
 * 538 / ABC News data exports.
 *
 * NOTE: Since 538 was acquired by ABC News these URLs can change without
 * notice. The pipeline checks each URL at runtime and logs a clear message
 * when a source is unavailable so operators can update the constant below.
 *
 * Historical CSV exports from the 538 GitHub repo are used as the primary
 * fallback because they remain publicly accessible even when the live API
 * changes.
 */
const SOURCES = {
  // Presidential general-election polls (current cycle preferred, 2024 as fallback)
  FTE_POLLS_2024_CSV:
    'https://projects.fivethirtyeight.com/polls/data/presidential_general_averages.csv',

  // All polls (presidential + congressional) — broader dataset
  FTE_ALL_POLLS_CSV:
    'https://projects.fivethirtyeight.com/polls/data/polls.csv',

  // 538 GitHub repo export — most stable long-term URL
  FTE_POLLS_GITHUB_CSV:
    'https://raw.githubusercontent.com/fivethirtyeight/data/master/polls/2024-polls.csv',

  // Pollster ratings — updated after each election cycle
  FTE_POLLSTER_RATINGS_CSV:
    'https://projects.fivethirtyeight.com/pollster-ratings/data/pollster-ratings.csv',

  // Pollster ratings from the 538 GitHub repo (fallback)
  FTE_POLLSTER_RATINGS_GITHUB_CSV:
    'https://raw.githubusercontent.com/fivethirtyeight/data/master/pollster-ratings/2024/pollster-ratings.csv',

  // RealClearPolitics does not expose a stable machine-readable JSON endpoint
  // for all races. Where they do, the URL pattern is:
  //   https://www.realclearpolling.com/api/polling/{race}
  // The pipeline attempts a presidential average as a representative sample.
  RCP_PRESIDENTIAL_JSON:
    'https://www.realclearpolling.com/api/polling/president/general/trump-vs-harris',
} as const;

// Fetch timeout for each individual network request (15 seconds).
const FETCH_TIMEOUT_MS = 15_000;

// Maximum number of CSV rows to process in a single pipeline run to avoid
// exhausting memory on very large exports. 0 = unlimited.
const MAX_ROWS_PER_SOURCE = 0;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CandidateResult {
  name: string;
  party: string;
  percentage: number;
}

interface ParsedPoll {
  pollster: string;
  poll_date: string; // ISO date string YYYY-MM-DD
  methodology: string | null;
  sample_size: number | null;
  margin_of_error: number | null;
  population: 'likely_voters' | 'registered_voters' | 'adults' | null;
  race: string;
  state: string | null; // two-letter abbreviation for state-level polls
  candidates: CandidateResult[];
  source_url: string;
  metadata: Record<string, unknown>;
}

interface ParsedPollsterRating {
  pollster: string;
  predictive_plus_minus: number | null;
  races_called_correctly: number | null;
  mean_reverted_bias: number | null;
  methodology_transparency: string | null;
  rating_grade: string | null;
  sample: string | null;
  metadata: Record<string, unknown>;
}

// Raw row shapes after CSV parsing (all values are strings before coercion).
type CsvRow = Record<string, string>;

// ---------------------------------------------------------------------------
// CSV parsing utility
// ---------------------------------------------------------------------------

/**
 * Minimal RFC 4180-compatible CSV parser that handles quoted fields and
 * embedded commas. Returns an array of objects keyed by the header row.
 *
 * This avoids any external dependency — the pipeline already uses only
 * stdlib + fetch for data access.
 */
function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return [];

  // Trim a BOM if present (common in Microsoft-generated CSV exports).
  const headerLine = lines[0].replace(/^\uFEFF/, '');
  const headers = splitCsvLine(headerLine);

  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = splitCsvLine(line);
    const row: CsvRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j].trim()] = (values[j] ?? '').trim();
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Splits a single CSV line into fields, respecting double-quoted fields that
 * may contain commas or escaped quotes (RFC 4180 §2).
 */
function splitCsvLine(line: string): string[] {
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
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a URL with a hard timeout. Returns null (rather than throwing) when
 * the request fails so callers can treat the source as unavailable.
 */
async function fetchWithTimeout(
  url: string,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Attempt to fetch a CSV from `url`. Returns the parsed rows on success, or
 * null with a console warning when the source is unavailable or malformed.
 */
async function fetchCsvSource(
  label: string,
  url: string,
): Promise<CsvRow[] | null> {
  const response = await fetchWithTimeout(url);
  if (!response) {
    console.warn(`[polling] Source unavailable (network/timeout): ${label} — ${url}`);
    return null;
  }
  if (!response.ok) {
    console.warn(
      `[polling] Source unavailable (HTTP ${response.status}): ${label} — ${url}`,
    );
    return null;
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    console.warn(`[polling] Could not read response body from: ${label} — ${url}`);
    return null;
  }
  const rows = parseCsv(text);
  if (rows.length === 0) {
    console.warn(`[polling] Source returned empty or unparseable CSV: ${label} — ${url}`);
    return null;
  }
  console.log(`[polling] Fetched ${rows.length} rows from: ${label}`);
  return rows;
}

/**
 * Parse a date string from various formats (MM/DD/YYYY, YYYY-MM-DD, etc.)
 * into a YYYY-MM-DD ISO date string. Returns null when the value is absent
 * or unparseable.
 */
function parseDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Already ISO format.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // MM/DD/YYYY
  const mdyMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdyMatch) {
    const [, m, d, y] = mdyMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // Try native Date as last resort.
  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }

  return null;
}

/**
 * Map raw population strings (e.g. "lv", "rv", "a", "likely voters") to the
 * DB enum values.
 */
function parsePopulation(
  raw: string | undefined,
): 'likely_voters' | 'registered_voters' | 'adults' | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === 'lv' || v.includes('likely')) return 'likely_voters';
  if (v === 'rv' || v.includes('registered')) return 'registered_voters';
  if (v === 'a' || v === 'all' || v.includes('adult')) return 'adults';
  return null;
}

/**
 * Parse a floating-point number from a raw string, returning null when the
 * value is absent, empty, or non-numeric.
 */
function parseFloat_(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/[%+]$/, '');
  if (!trimmed) return null;
  const n = parseFloat(trimmed);
  return isNaN(n) ? null : n;
}

/**
 * Parse an integer from a raw string, returning null when absent or
 * non-numeric.
 */
function parseInt_(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim().replace(/,/g, '');
  if (!trimmed) return null;
  const n = parseInt(trimmed, 10);
  return isNaN(n) ? null : n;
}

/**
 * Derive a canonical race key from available fields.
 *
 * Examples:
 *   president_2024, senate_2024_AZ, house_2024_AZ-1
 */
function deriveRaceKey(row: CsvRow): string {
  const type = (
    row['type'] ??
    row['office'] ??
    row['race_type'] ??
    row['office_type'] ??
    ''
  )
    .toLowerCase()
    .trim();

  const year =
    row['year'] ??
    row['cycle'] ??
    row['election_year'] ??
    String(new Date().getFullYear());

  const state = (row['state'] ?? row['location'] ?? '').trim().toUpperCase();
  const district = (row['seat'] ?? row['district'] ?? '').trim();

  let base = 'unknown';
  if (type.includes('pres') || type === 'p') base = 'president';
  else if (type.includes('sen') || type === 's') base = 'senate';
  else if (type.includes('gov')) base = 'governor';
  else if (type.includes('house') || type === 'h') base = 'house';
  else if (type) base = type.replace(/\s+/g, '_');

  const parts = [base, year];
  if (state && state.length === 2) parts.push(state);
  if (district) parts.push(district);
  return parts.join('_');
}

// ---------------------------------------------------------------------------
// 538 poll CSV row parsers
// ---------------------------------------------------------------------------

/**
 * Attempt to parse a row from the 538 all-polls CSV export into a
 * normalised ParsedPoll.  The schema has shifted between 538 iterations;
 * this handles common variants by checking multiple candidate column names.
 *
 * Returns null when the row lacks the minimum required fields (pollster,
 * date, at least one candidate result).
 */
function parseFtePollRow(row: CsvRow, sourceUrl: string): ParsedPoll | null {
  const pollster = (
    row['pollster'] ??
    row['pollster_id'] ??
    row['firm'] ??
    ''
  ).trim();

  if (!pollster) return null;

  const rawDate =
    row['end_date'] ??
    row['date'] ??
    row['end'] ??
    row['poll_date'] ??
    row['startdate'] ??
    row['enddate'] ??
    '';

  const poll_date = parseDate(rawDate);
  if (!poll_date) return null;

  // Candidate columns vary significantly across 538 exports.
  // Try to build a candidates array from whatever columns are present.
  const candidates = parseFteCandidateColumns(row);
  if (candidates.length === 0) return null;

  const state =
    (row['state'] ?? row['location'] ?? row['geo'] ?? '').trim().toUpperCase() ||
    null;

  return {
    pollster,
    poll_date,
    methodology: (row['methodology'] ?? row['mode'] ?? null)?.trim() || null,
    sample_size: parseInt_(row['sample_size'] ?? row['n'] ?? row['observations']),
    margin_of_error: parseFloat_(row['moe'] ?? row['margin_of_error']),
    population: parsePopulation(
      row['population'] ??
        row['ql'] ??
        row['voter_type'] ??
        row['likely_voters'],
    ),
    race: deriveRaceKey(row),
    state: state && state.length === 2 ? state : null,
    candidates,
    source_url: sourceUrl,
    metadata: {
      raw_question: row['question_text'] ?? row['question'] ?? null,
      poll_id: row['poll_id'] ?? row['id'] ?? null,
      partisan: row['partisan'] ?? null,
      tracking: row['tracking'] ?? null,
      internal: row['internal'] ?? null,
    },
  };
}

/**
 * Extract candidate name/party/percentage from a 538 CSV row.
 *
 * 538 uses two different layouts depending on the export:
 *  a) Wide format: columns like "dem", "rep", "ind", or candidate names
 *     directly (e.g. "Biden", "Trump", "Harris").
 *  b) Long format: "answer" (candidate name), "pct" (percentage), "party".
 */
function parseFteCandidateColumns(row: CsvRow): CandidateResult[] {
  const candidates: CandidateResult[] = [];

  // Long-format (single answer + pct columns)
  if (row['answer'] !== undefined && row['pct'] !== undefined) {
    const pct = parseFloat_(row['pct']);
    if (pct !== null) {
      candidates.push({
        name: (row['answer'] ?? '').trim(),
        party: inferParty(row['answer'] ?? '', row['party'] ?? ''),
        percentage: pct,
      });
    }
    return candidates;
  }

  // Wide-format: well-known party shorthand columns
  const partyColumns: Array<{ key: string; party: string }> = [
    { key: 'dem', party: 'D' },
    { key: 'rep', party: 'R' },
    { key: 'ind', party: 'I' },
    { key: 'lib', party: 'L' },
    { key: 'grn', party: 'G' },
    { key: 'oth', party: 'other' },
  ];

  for (const { key, party } of partyColumns) {
    const pct = parseFloat_(row[key]);
    if (pct !== null) {
      const name = (row[`${key}_candidate`] ?? row[`${key}_name`] ?? '').trim();
      candidates.push({ name, party, percentage: pct });
    }
  }

  if (candidates.length > 0) return candidates;

  // Wide-format: specific well-known candidate name columns (2024 cycle)
  const knownCandidates: Array<{ key: string; party: string }> = [
    { key: 'Biden', party: 'D' },
    { key: 'Harris', party: 'D' },
    { key: 'Trump', party: 'R' },
    { key: 'DeSantis', party: 'R' },
    { key: 'Kennedy', party: 'I' },
  ];

  for (const { key, party } of knownCandidates) {
    const pct = parseFloat_(row[key] ?? row[key.toLowerCase()]);
    if (pct !== null) {
      candidates.push({ name: key, party, percentage: pct });
    }
  }

  return candidates;
}

/**
 * Infer a party abbreviation from a candidate name or an explicit party
 * column value when present.
 */
function inferParty(name: string, partyRaw: string): string {
  if (partyRaw) {
    const p = partyRaw.trim().toUpperCase();
    if (p === 'DEM' || p === 'D' || p === 'DEMOCRATIC') return 'D';
    if (p === 'REP' || p === 'R' || p === 'REPUBLICAN') return 'R';
    if (p === 'IND' || p === 'I' || p === 'INDEPENDENT') return 'I';
    if (p === 'LIB' || p === 'L' || p === 'LIBERTARIAN') return 'L';
    if (p === 'GRN' || p === 'G' || p === 'GREEN') return 'G';
    return p;
  }
  // Best-effort inference from known names.
  const lower = name.toLowerCase();
  if (['biden', 'harris', 'clinton', 'obama'].includes(lower)) return 'D';
  if (['trump', 'desantis', 'romney', 'mccain'].includes(lower)) return 'R';
  return 'other';
}

// ---------------------------------------------------------------------------
// 538 pollster ratings CSV row parser
// ---------------------------------------------------------------------------

/**
 * Parse a row from the 538 pollster ratings CSV into a normalised
 * ParsedPollsterRating. Returns null when the pollster name is absent.
 */
function parseFtePollsterRatingRow(row: CsvRow): ParsedPollsterRating | null {
  const pollster = (
    row['Pollster'] ??
    row['pollster'] ??
    row['firm'] ??
    ''
  ).trim();

  if (!pollster) return null;

  return {
    pollster,
    predictive_plus_minus: parseFloat_(
      row['Predictive    Plus-Minus'] ??
        row['Predictive Plus-Minus'] ??
        row['predictive_plus_minus'] ??
        row['PPM'] ??
        row['538 Grade'],
    ),
    races_called_correctly: parseFloat_(
      row['Races Called Correctly'] ??
        row['races_called_correctly'] ??
        row['correct_direction'] ??
        row['% Correct Direction'],
    ),
    mean_reverted_bias: parseFloat_(
      row['Mean-Reverted Bias'] ??
        row['mean_reverted_bias'] ??
        row['bias'] ??
        row['Bias'],
    ),
    methodology_transparency: (
      row['Methodology Transparency'] ??
        row['methodology_transparency'] ??
        row['transparency_score'] ??
        null
    )?.trim() || null,
    rating_grade: (
      row['538 Grade'] ??
        row['grade'] ??
        row['Grade'] ??
        row['rating'] ??
        null
    )?.trim() || null,
    sample: (
      row['Sample'] ??
        row['sample'] ??
        row['typical_sample'] ??
        null
    )?.trim() || null,
    metadata: {
      advanced_plus_minus: parseFloat_(
        row['Advanced Plus-Minus'] ?? row['advanced_plus_minus'],
      ),
      simple_average_error: parseFloat_(
        row['Simple Average Error'] ?? row['simple_average_error'],
      ),
      polls_analyzed: parseInt_(
        row['Polls Analyzed'] ?? row['polls_analyzed'] ?? row['num_polls'],
      ),
      banned_by_client: (row['Banned by Client'] ?? row['banned'] ?? '').trim() || null,
    },
  };
}

// ---------------------------------------------------------------------------
// RealClearPolitics JSON parser
// ---------------------------------------------------------------------------

/**
 * Attempts to parse a RealClearPolitics JSON response. RCP does not publish
 * a documented schema so this is best-effort. Returns an array of ParsedPoll
 * (possibly empty) on any structure mismatch.
 */
function parseRcpJson(data: unknown, sourceUrl: string): ParsedPoll[] {
  if (!data || typeof data !== 'object') return [];

  // RCP wraps poll data in various shapes depending on the race endpoint.
  // Common shapes:
  //   { polls: [...] }
  //   { data: { polls: [...] } }
  //   [ ...poll objects ]

  const root = data as Record<string, unknown>;
  let polls: unknown[] = [];

  if (Array.isArray(root)) {
    polls = root;
  } else if (Array.isArray(root['polls'])) {
    polls = root['polls'] as unknown[];
  } else if (
    root['data'] &&
    typeof root['data'] === 'object' &&
    Array.isArray((root['data'] as Record<string, unknown>)['polls'])
  ) {
    polls = (root['data'] as Record<string, unknown>)['polls'] as unknown[];
  } else {
    return [];
  }

  const results: ParsedPoll[] = [];

  for (const rawPoll of polls) {
    if (!rawPoll || typeof rawPoll !== 'object') continue;
    const p = rawPoll as Record<string, unknown>;

    const pollster = String(p['pollster'] ?? p['source'] ?? '').trim();
    if (!pollster) continue;

    const poll_date = parseDate(
      String(p['date'] ?? p['end_date'] ?? p['endDate'] ?? ''),
    );
    if (!poll_date) continue;

    // RCP typically embeds candidate results inside a "candidates" array or
    // a top-level property per candidate name.
    const candidates: CandidateResult[] = [];

    if (Array.isArray(p['candidates'])) {
      for (const c of p['candidates'] as unknown[]) {
        if (!c || typeof c !== 'object') continue;
        const cObj = c as Record<string, unknown>;
        const pct = parseFloat_(String(cObj['pct'] ?? cObj['value'] ?? ''));
        if (pct !== null) {
          candidates.push({
            name: String(cObj['name'] ?? cObj['candidate'] ?? '').trim(),
            party: String(cObj['party'] ?? '').trim() || 'other',
            percentage: pct,
          });
        }
      }
    }

    if (candidates.length === 0) continue;

    const state = String(p['state'] ?? p['location'] ?? '').trim().toUpperCase();

    results.push({
      pollster,
      poll_date,
      methodology: String(p['methodology'] ?? p['type'] ?? '').trim() || null,
      sample_size: parseInt_(String(p['n'] ?? p['sample_size'] ?? '')),
      margin_of_error: parseFloat_(String(p['moe'] ?? '')),
      population: parsePopulation(String(p['population'] ?? p['voter_type'] ?? '')),
      race: String(p['race'] ?? p['contest'] ?? 'unknown').trim(),
      state: state.length === 2 ? state : null,
      candidates,
      source_url: sourceUrl,
      metadata: {
        rcp_poll_id: p['id'] ?? null,
        partisan: p['partisan'] ?? null,
      },
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Pipeline class
// ---------------------------------------------------------------------------

export class PollingPipeline extends BasePipeline {
  // In-process cache: state abbreviation → jurisdiction UUID
  private jurisdictionCache = new Map<string, string | null>();

  getName(): string {
    return 'polling';
  }

  // -------------------------------------------------------------------------
  // Entry point
  // -------------------------------------------------------------------------

  async run(): Promise<void> {
    // ------------------------------------------------------------------
    // Phase 1: Polls
    // ------------------------------------------------------------------
    console.log(`[${this.getName()}] Phase 1: Fetching polls...`);

    const allPolls: ParsedPoll[] = [];
    let sourcesAttempted = 0;
    let sourcesSucceeded = 0;

    // 1a. 538 all-polls CSV (primary source)
    sourcesAttempted++;
    {
      const rows = await fetchCsvSource('538 all-polls CSV', SOURCES.FTE_ALL_POLLS_CSV);
      if (rows) {
        sourcesSucceeded++;
        const parsed = this.parsePollRows(rows, SOURCES.FTE_ALL_POLLS_CSV);
        console.log(
          `[${this.getName()}] Parsed ${parsed.length} polls from 538 all-polls CSV.`,
        );
        allPolls.push(...parsed);
      }
    }

    // 1b. 538 presidential averages CSV (supplemental — covers averages not
    //     individual polls, useful when 1a is unavailable)
    if (allPolls.length === 0) {
      sourcesAttempted++;
      const rows = await fetchCsvSource(
        '538 presidential averages CSV',
        SOURCES.FTE_POLLS_2024_CSV,
      );
      if (rows) {
        sourcesSucceeded++;
        const parsed = this.parsePollRows(rows, SOURCES.FTE_POLLS_2024_CSV);
        console.log(
          `[${this.getName()}] Parsed ${parsed.length} polls from 538 presidential averages CSV.`,
        );
        allPolls.push(...parsed);
      }
    }

    // 1c. 538 GitHub archive (fallback when both primary URLs have changed)
    if (allPolls.length === 0) {
      sourcesAttempted++;
      const rows = await fetchCsvSource(
        '538 GitHub archive CSV',
        SOURCES.FTE_POLLS_GITHUB_CSV,
      );
      if (rows) {
        sourcesSucceeded++;
        const parsed = this.parsePollRows(rows, SOURCES.FTE_POLLS_GITHUB_CSV);
        console.log(
          `[${this.getName()}] Parsed ${parsed.length} polls from 538 GitHub archive.`,
        );
        allPolls.push(...parsed);
      }
    }

    // 1d. RealClearPolitics JSON (supplemental — presidential only)
    sourcesAttempted++;
    {
      const rcpPolls = await this.fetchRcpPolls();
      if (rcpPolls !== null) {
        sourcesSucceeded++;
        console.log(
          `[${this.getName()}] Parsed ${rcpPolls.length} polls from RealClearPolitics.`,
        );
        allPolls.push(...rcpPolls);
      }
    }

    console.log(
      `[${this.getName()}] Sources: ${sourcesSucceeded}/${sourcesAttempted} succeeded. ` +
        `Total parsed polls: ${allPolls.length}.`,
    );

    if (allPolls.length === 0) {
      console.warn(
        `[${this.getName()}] WARNING: No polls were retrieved from any source. ` +
          `The 538/ABC News export URLs may have changed. ` +
          `Update SOURCES constants at the top of polling.ts with the new URLs.`,
      );
    }

    this.results.records_fetched += allPolls.length;

    // Upsert all parsed polls.
    for (const poll of allPolls) {
      await this.upsertPoll(poll);
    }

    // ------------------------------------------------------------------
    // Phase 2: Pollster ratings
    // ------------------------------------------------------------------
    console.log(`[${this.getName()}] Phase 2: Fetching pollster ratings...`);

    const allRatings: ParsedPollsterRating[] = [];

    // 2a. 538 pollster ratings (primary)
    {
      const rows = await fetchCsvSource(
        '538 pollster ratings CSV',
        SOURCES.FTE_POLLSTER_RATINGS_CSV,
      );
      if (rows) {
        const parsed = this.parsePollsterRatingRows(rows);
        console.log(
          `[${this.getName()}] Parsed ${parsed.length} pollster ratings from 538.`,
        );
        allRatings.push(...parsed);
      }
    }

    // 2b. 538 GitHub archive fallback
    if (allRatings.length === 0) {
      const rows = await fetchCsvSource(
        '538 pollster ratings GitHub archive',
        SOURCES.FTE_POLLSTER_RATINGS_GITHUB_CSV,
      );
      if (rows) {
        const parsed = this.parsePollsterRatingRows(rows);
        console.log(
          `[${this.getName()}] Parsed ${parsed.length} pollster ratings from GitHub archive.`,
        );
        allRatings.push(...parsed);
      }
    }

    if (allRatings.length === 0) {
      console.warn(
        `[${this.getName()}] WARNING: No pollster ratings were retrieved. ` +
          `Update FTE_POLLSTER_RATINGS_CSV / FTE_POLLSTER_RATINGS_GITHUB_CSV in polling.ts.`,
      );
    }

    this.results.records_fetched += allRatings.length;

    for (const rating of allRatings) {
      await this.upsertPollsterRating(rating);
    }
  }

  // -------------------------------------------------------------------------
  // Parsing helpers
  // -------------------------------------------------------------------------

  private parsePollRows(rows: CsvRow[], sourceUrl: string): ParsedPoll[] {
    const polls: ParsedPoll[] = [];
    const limit = MAX_ROWS_PER_SOURCE > 0 ? MAX_ROWS_PER_SOURCE : rows.length;

    for (let i = 0; i < Math.min(rows.length, limit); i++) {
      const parsed = parseFtePollRow(rows[i], sourceUrl);
      if (parsed) polls.push(parsed);
    }
    return polls;
  }

  private parsePollsterRatingRows(rows: CsvRow[]): ParsedPollsterRating[] {
    const ratings: ParsedPollsterRating[] = [];
    for (const row of rows) {
      const parsed = parseFtePollsterRatingRow(row);
      if (parsed) ratings.push(parsed);
    }
    return ratings;
  }

  // -------------------------------------------------------------------------
  // RealClearPolitics fetch
  // -------------------------------------------------------------------------

  /**
   * Attempts to retrieve polls from RealClearPolitics. Returns null when the
   * endpoint is unavailable, returning an empty array when reachable but empty.
   */
  private async fetchRcpPolls(): Promise<ParsedPoll[] | null> {
    const response = await fetchWithTimeout(SOURCES.RCP_PRESIDENTIAL_JSON);
    if (!response) {
      console.warn(
        `[${this.getName()}] RealClearPolitics endpoint unavailable (network/timeout).`,
      );
      return null;
    }
    if (!response.ok) {
      console.warn(
        `[${this.getName()}] RealClearPolitics returned HTTP ${response.status}. ` +
          `This endpoint may have moved or require authentication.`,
      );
      return null;
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      console.warn(
        `[${this.getName()}] RealClearPolitics response was not valid JSON. ` +
          `The endpoint may now return HTML or a different format.`,
      );
      return null;
    }
    return parseRcpJson(data, SOURCES.RCP_PRESIDENTIAL_JSON);
  }

  // -------------------------------------------------------------------------
  // Jurisdiction resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve a jurisdiction UUID from a two-letter state abbreviation using
   * the `jurisdictions` table. Results are cached in-process to avoid
   * redundant DB lookups across many polls for the same state.
   *
   * Returns null when no matching jurisdiction is found.
   */
  private async resolveJurisdictionId(state: string): Promise<string | null> {
    const upper = state.trim().toUpperCase();
    if (!upper || upper.length !== 2) return null;

    if (this.jurisdictionCache.has(upper)) {
      return this.jurisdictionCache.get(upper) ?? null;
    }

    const { data, error } = await this.supabase
      .from('jurisdictions')
      .select('id')
      .eq('abbreviation', upper)
      .maybeSingle();

    if (error) {
      console.warn(
        `[${this.getName()}] Could not look up jurisdiction for state "${upper}": ${error.message}`,
      );
      this.jurisdictionCache.set(upper, null);
      return null;
    }

    const id = data?.id ?? null;
    this.jurisdictionCache.set(upper, id);
    return id;
  }

  // -------------------------------------------------------------------------
  // Database upserts
  // -------------------------------------------------------------------------

  /**
   * Upsert a single poll into the `polls` table.
   *
   * Deduplication key: pollster + poll_date + race + source_url. If an
   * identical row already exists it is updated in place (to pick up any
   * corrected sample sizes or percentages from a re-run).
   */
  private async upsertPoll(poll: ParsedPoll): Promise<void> {
    try {
      const jurisdiction_id = poll.state
        ? await this.resolveJurisdictionId(poll.state)
        : null;

      const row = {
        pollster: poll.pollster,
        poll_date: poll.poll_date,
        methodology: poll.methodology,
        sample_size: poll.sample_size,
        margin_of_error: poll.margin_of_error,
        population: poll.population,
        race: poll.race,
        jurisdiction_id,
        candidates: poll.candidates,
        source_url: poll.source_url,
        metadata: poll.metadata,
      };

      // Attempt upsert; fall back to insert-or-skip on conflict.
      const { error } = await this.supabase
        .from('polls')
        .upsert(row, {
          onConflict: 'pollster,poll_date,race,source_url',
          ignoreDuplicates: false,
        });

      if (error) {
        // 23505 = unique_violation — treat as a skip (already exists).
        if (error.code === '23505') {
          this.results.records_skipped++;
          return;
        }
        // Column list mismatch (42703) can occur when the onConflict index
        // does not exist yet; attempt a plain insert as a best-effort fallback.
        if (error.code === '42703' || error.code === '42P10') {
          const { error: insertError } = await this.supabase
            .from('polls')
            .insert(row);
          if (insertError) {
            if (insertError.code === '23505') {
              this.results.records_skipped++;
              return;
            }
            throw new Error(`polls insert failed: ${insertError.message}`);
          }
          this.results.records_inserted++;
          return;
        }
        throw new Error(`polls upsert failed: ${error.message}`);
      }

      this.results.records_inserted++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[${this.getName()}] Error upserting poll (${poll.pollster} / ${poll.poll_date} / ${poll.race}): ${msg}`,
      );
      this.results.errors.push(
        `poll upsert [${poll.pollster}/${poll.poll_date}/${poll.race}]: ${msg}`,
      );
    }
  }

  /**
   * Upsert a single pollster rating into the `pollster_ratings` table.
   *
   * Deduplication key: pollster (UNIQUE constraint on the column). On conflict
   * the row is updated with the latest rating data.
   */
  private async upsertPollsterRating(rating: ParsedPollsterRating): Promise<void> {
    try {
      const row = {
        pollster: rating.pollster,
        predictive_plus_minus: rating.predictive_plus_minus,
        races_called_correctly: rating.races_called_correctly,
        mean_reverted_bias: rating.mean_reverted_bias,
        methodology_transparency: rating.methodology_transparency,
        rating_grade: rating.rating_grade,
        sample: rating.sample,
        metadata: rating.metadata,
      };

      const { error } = await this.supabase
        .from('pollster_ratings')
        .upsert(row, {
          onConflict: 'pollster',
          ignoreDuplicates: false,
        });

      if (error) {
        if (error.code === '23505') {
          this.results.records_skipped++;
          return;
        }
        throw new Error(`pollster_ratings upsert failed: ${error.message}`);
      }

      this.results.records_updated++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[${this.getName()}] Error upserting pollster rating (${rating.pollster}): ${msg}`,
      );
      this.results.errors.push(`pollster_rating upsert [${rating.pollster}]: ${msg}`);
    }
  }
}
