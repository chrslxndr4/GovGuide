/**
 * Import federal judges from the FJC Judges Database CSV.
 *
 * The FJC (Federal Judicial Center) publishes a biographical database of all
 * Article III judges as a downloadable CSV at:
 *   https://www.fjc.gov/history/judges/biographical-database-article-iii-federal-judges-export
 *
 * Requires environment variable:  FJC_CSV_PATH
 *   Path to the downloaded CSV file on disk, e.g. /tmp/fjc-judges.csv
 *
 * Optional environment variables:
 *   FJC_JURISDICTION_SLUG  — GovGuide jurisdictions.slug to use as the default
 *                            federal jurisdiction (default: 'federal')
 *
 * For each row this script:
 *   1. Resolves (or creates) a courts record for the judge's court.
 *   2. Upserts an entities record of type 'judge'.
 *   3. Upserts a judges record linked to the entity and court.
 *
 * Records are processed in batches of 100.
 *
 * Run with:  npx tsx --env-file=.env scripts/import-judges.ts
 */

import fs from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Raw row parsed directly from the FJC CSV.
 *
 * The FJC Biographical Database CSV header names (as of the 2024 export).
 * Some columns are repeating (e.g. for multiple courts / nominations) — we
 * only consume the first nomination block here, which covers ~95 % of judges.
 */
interface FjcRow {
  // Identity
  nid: string;                     // Unique Judge ID
  firstname: string;
  middlename: string;
  lastname: string;
  suffix: string;
  birthyear: string;
  deathyear: string;
  gender: string;
  race: string;
  // Court of current / primary service
  court_name: string;              // "Court Name (1)"
  court_type: string;              // "Court Type (1)"
  // Appointment
  appointing_president: string;    // "Appointing President (1)"
  party_of_appointing_president: string;
  // Senate confirmation
  confirmation_date: string;       // "Senate Vote Date (1)"
  confirmation_vote: string;       // e.g. "98-0"
  // Service
  aba_rating: string;              // "ABA Rating (1)"
  senior_status_date: string;
  termination_date: string;
  termination_reason: string;
  // Raw record store
  _raw: Record<string, string>;
}

interface CourtInsert {
  name: string;
  court_type: CourtType;
  jurisdiction_id: string | null;
  circuit_number: number | null;
  metadata: Record<string, unknown>;
}

interface EntityInsert {
  entity_type: 'judge';
  name: string;
  aliases: string[];
  external_ids: Record<string, string>;
  metadata: Record<string, unknown>;
}

interface JudgeInsert {
  entity_id: string;
  court_id: string;
  full_name: string;
  slug: string;
  appointing_president_id: string | null; // FK to officials — kept null here
  confirmation_date: string | null;
  confirmation_vote: string | null;
  aba_rating: string | null;
  senior_status_date: string | null;
  termination_date: string | null;
  termination_reason: string | null;
  metadata: Record<string, unknown>;
}

type CourtType = 'supreme' | 'appellate' | 'district' | 'bankruptcy' | 'specialized';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100;

/**
 * Maps FJC "Court Type" strings to the courts.court_type enum values in the
 * GovGuide schema.
 */
const FJC_COURT_TYPE_MAP: Record<string, CourtType> = {
  'U.S. Supreme Court': 'supreme',
  'U.S. Court of Appeals': 'appellate',
  'U.S. Court of Appeals for the Federal Circuit': 'appellate',
  'U.S. Court of Appeals for the Armed Forces': 'appellate',
  'U.S. District Court': 'district',
  'U.S. District Court with Bankruptcy Jurisdiction': 'district',
  'U.S. Bankruptcy Court': 'bankruptcy',
  'U.S. Court of International Trade': 'specialized',
  'U.S. Court of Federal Claims': 'specialized',
  'U.S. Tax Court': 'specialized',
  'U.S. Court of Veterans Appeals': 'specialized',
  'U.S. Court of Appeals for Veterans Claims': 'specialized',
};

/**
 * FJC circuit designations embedded in court names.
 * e.g. "U.S. Court of Appeals for the First Circuit" → 1
 */
const ORDINAL_TO_NUMBER: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Normalise a date string from FJC format (M/D/YYYY or MM/DD/YYYY) to
 * ISO 8601 (YYYY-MM-DD).  Returns null if the input is empty or unparseable.
 */
function normaliseDate(raw: string): string | null {
  if (!raw || raw.trim() === '') return null;
  const parts = raw.trim().split('/');
  if (parts.length !== 3) return null;
  const [month, day, year] = parts;
  if (!month || !day || !year) return null;
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

/**
 * Infer the court_type enum value from an FJC court type string.
 * Falls back to 'specialized' for any unknown value.
 */
function inferCourtType(fjcType: string): CourtType {
  if (!fjcType) return 'specialized';
  // Exact match first.
  if (FJC_COURT_TYPE_MAP[fjcType]) return FJC_COURT_TYPE_MAP[fjcType];
  // Fuzzy match.
  const lower = fjcType.toLowerCase();
  if (lower.includes('supreme')) return 'supreme';
  if (lower.includes('appeals') || lower.includes('appellate')) return 'appellate';
  if (lower.includes('district')) return 'district';
  if (lower.includes('bankruptcy')) return 'bankruptcy';
  return 'specialized';
}

/**
 * Extract a circuit number from a court name string.
 * e.g. "U.S. Court of Appeals for the Ninth Circuit" → 9
 */
function extractCircuitNumber(courtName: string): number | null {
  if (!courtName) return null;
  const lower = courtName.toLowerCase();
  for (const [word, num] of Object.entries(ORDINAL_TO_NUMBER)) {
    if (lower.includes(word)) return num;
  }
  // Handle "D.C. Circuit"
  if (lower.includes('d.c. circuit') || lower.includes('district of columbia circuit')) {
    return null; // D.C. circuit has no number
  }
  return null;
}

/**
 * Build a deduplicated full name from FJC name parts.
 */
function buildFullName(row: FjcRow): string {
  const parts = [row.firstname, row.middlename, row.lastname, row.suffix]
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.join(' ');
}

/**
 * Generate a unique slug for a judge.  Uses NID as a suffix to guarantee
 * uniqueness even for judges with identical names.
 */
function buildJudgeSlug(fullName: string, nid: string): string {
  return slugify(`${fullName}-${nid}`);
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * Parse a CSV line handling quoted fields that may contain commas.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // Escaped quote inside a quoted field.
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

/**
 * Stream-parse the FJC CSV file and yield structured FjcRow objects.
 *
 * The FJC CSV uses a repeating column pattern for multiple nominations:
 *   "Court Name (1)", "Court Name (2)", …
 * We only read the first nomination block.
 */
async function* streamFjcCsv(csvPath: string): AsyncGenerator<FjcRow> {
  const stream = createReadStream(csvPath, { encoding: 'utf-8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let headers: string[] = [];
  let isFirstLine = true;

  for await (const line of rl) {
    if (!line.trim()) continue;

    if (isFirstLine) {
      headers = parseCsvLine(line).map((h) => h.trim().toLowerCase());
      isFirstLine = false;
      continue;
    }

    const values = parseCsvLine(line);
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => {
      raw[h] = (values[i] ?? '').trim();
    });

    // Map FJC column names to our typed interface.
    // The FJC CSV uses "(1)" suffixes for the first nomination block.
    yield {
      nid: raw['nid'] ?? raw['judge identification number'] ?? '',
      firstname: raw['first name'] ?? raw['firstname'] ?? '',
      middlename: raw['middle name'] ?? raw['middlename'] ?? '',
      lastname: raw['last name'] ?? raw['lastname'] ?? '',
      suffix: raw['suffix'] ?? '',
      birthyear: raw['birth year'] ?? raw['year of birth'] ?? '',
      deathyear: raw['death year'] ?? raw['year of death'] ?? '',
      gender: raw['gender'] ?? '',
      race: raw['race or ethnicity'] ?? raw['race'] ?? '',
      court_name: raw['court name (1)'] ?? raw['court name'] ?? '',
      court_type: raw['court type (1)'] ?? raw['court type'] ?? '',
      appointing_president: raw['appointing president (1)'] ?? raw['appointing president'] ?? '',
      party_of_appointing_president: raw['party of appointing president (1)'] ?? '',
      confirmation_date: raw['senate vote date (1)'] ?? raw['confirmation date'] ?? '',
      confirmation_vote: raw['senate vote (1)'] ?? raw['confirmation vote'] ?? '',
      aba_rating: raw['aba rating (1)'] ?? raw['aba rating'] ?? '',
      senior_status_date: raw['senior status date (1)'] ?? raw['senior status date'] ?? '',
      termination_date: raw['termination date (1)'] ?? raw['termination date'] ?? '',
      termination_reason: raw['termination reason (1)'] ?? raw['termination reason'] ?? '',
      _raw: raw,
    };
  }
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

const courtCache = new Map<string, string>();       // normalised court name → UUID
const entityCache = new Map<string, string>();      // fjc nid → entity UUID
const jurisdictionIdCache = { value: null as string | null, resolved: false };

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function getFederalJurisdictionId(slug: string): Promise<string | null> {
  if (jurisdictionIdCache.resolved) return jurisdictionIdCache.value;

  const { data, error } = await supabase
    .from('jurisdictions')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();

  if (error) {
    console.error(`  ERROR looking up federal jurisdiction "${slug}": ${error.message}`);
    jurisdictionIdCache.value = null;
  } else if (!data) {
    console.warn(`  Federal jurisdiction not found for slug "${slug}"`);
    jurisdictionIdCache.value = null;
  } else {
    jurisdictionIdCache.value = (data as { id: string }).id;
  }

  jurisdictionIdCache.resolved = true;
  return jurisdictionIdCache.value;
}

async function getOrCreateCourt(insert: CourtInsert): Promise<string | null> {
  const cacheKey = insert.name.toLowerCase();
  if (courtCache.has(cacheKey)) return courtCache.get(cacheKey)!;

  // Check for existing record first.
  const { data: existing } = await supabase
    .from('courts')
    .select('id')
    .eq('name', insert.name)
    .maybeSingle();

  if (existing) {
    const id = (existing as { id: string }).id;
    courtCache.set(cacheKey, id);
    return id;
  }

  const { data: created, error } = await supabase
    .from('courts')
    .insert(insert)
    .select('id')
    .single();

  if (error || !created) {
    console.error(`  ERROR creating court "${insert.name}": ${error?.message}`);
    return null;
  }

  const id = (created as { id: string }).id;
  courtCache.set(cacheKey, id);
  return id;
}

// ---------------------------------------------------------------------------
// Batch flush helpers
// ---------------------------------------------------------------------------

/**
 * Upsert a batch of entity rows.  Returns a map from fjc_nid → entity UUID
 * for the successfully upserted rows.
 */
async function flushEntities(
  batch: Array<{ nid: string; insert: EntityInsert }>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (batch.length === 0) return result;

  const { data, error } = await supabase
    .from('entities')
    .upsert(
      batch.map((b) => b.insert),
      { onConflict: 'external_ids' },
    )
    .select('id, external_ids');

  if (error || !data) {
    console.error(`  ENTITY BATCH ERROR (${batch.length} records): ${error?.message}`);
    return result;
  }

  // Match returned rows back to NIDs via the external_ids JSONB field.
  for (const row of data as Array<{ id: string; external_ids: Record<string, string> }>) {
    const nid = row.external_ids['fjc_nid'];
    if (nid) result.set(nid, row.id);
  }
  return result;
}

/**
 * Upsert a batch of judge rows, deduplicating on the slug unique index.
 */
async function flushJudges(batch: JudgeInsert[]): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('judges')
    .upsert(batch, { onConflict: 'slug' });

  if (error) {
    console.error(`  JUDGE BATCH ERROR (${batch.length} records): ${error.message}`);
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importJudges(): Promise<void> {
  console.log('=== Import FJC Judges ===\n');

  const csvPath = process.env['FJC_CSV_PATH'];
  if (!csvPath) {
    throw new Error(
      'Missing environment variable: FJC_CSV_PATH\n' +
        'Set it to the path of the downloaded FJC CSV file.\n' +
        'Download from: https://www.fjc.gov/history/judges/biographical-database-article-iii-federal-judges-export',
    );
  }

  if (!fs.existsSync(csvPath)) {
    throw new Error(`FJC CSV file not found at path: ${csvPath}`);
  }

  const jurisdictionSlug = process.env['FJC_JURISDICTION_SLUG'] ?? 'federal';
  const federalJurisdictionId = await getFederalJurisdictionId(jurisdictionSlug);

  if (!federalJurisdictionId) {
    console.warn(
      `  Warning: could not resolve jurisdiction slug "${jurisdictionSlug}". ` +
        'Courts will be created without a jurisdiction_id.',
    );
  }

  let totalInserted = 0;
  let totalSkipped = 0;

  // Accumulator batches.
  const entityBatch: Array<{ nid: string; insert: EntityInsert }> = [];
  const pendingJudgeRows: Array<{
    nid: string;
    courtId: string;
    row: FjcRow;
    fullName: string;
    slug: string;
  }> = [];

  async function flushBatch(): Promise<void> {
    if (entityBatch.length === 0) return;

    // 1. Upsert entities and collect nid → entity_id map.
    const entityIdMap = await flushEntities(entityBatch);

    // 2. Build judge insert rows for entities that were successfully upserted.
    const judgeInserts: JudgeInsert[] = [];
    for (const pending of pendingJudgeRows) {
      const entityId = entityIdMap.get(pending.nid) ?? entityCache.get(pending.nid);
      if (!entityId) {
        console.warn(
          `  Could not resolve entity_id for judge NID "${pending.nid}" — skipping`,
        );
        totalSkipped++;
        continue;
      }
      entityCache.set(pending.nid, entityId);

      const confirmationDate = normaliseDate(pending.row.confirmation_date);
      const seniorStatusDate = normaliseDate(pending.row.senior_status_date);
      const terminationDate = normaliseDate(pending.row.termination_date);

      judgeInserts.push({
        entity_id: entityId,
        court_id: pending.courtId,
        full_name: pending.fullName,
        slug: pending.slug,
        appointing_president_id: null, // Resolved separately via import-congress-members
        confirmation_date: confirmationDate,
        confirmation_vote: pending.row.confirmation_vote || null,
        aba_rating: pending.row.aba_rating || null,
        senior_status_date: seniorStatusDate,
        termination_date: terminationDate,
        termination_reason: pending.row.termination_reason || null,
        metadata: {
          appointing_president_name: pending.row.appointing_president || null,
          party_of_appointing_president: pending.row.party_of_appointing_president || null,
          birth_year: pending.row.birthyear ? parseInt(pending.row.birthyear, 10) : null,
          death_year: pending.row.deathyear ? parseInt(pending.row.deathyear, 10) : null,
          gender: pending.row.gender || null,
          race: pending.row.race || null,
        },
      });
    }

    // 3. Upsert judge rows.
    const { ok, err } = await flushJudges(judgeInserts);
    totalInserted += ok;
    totalSkipped += err;
    process.stdout.write(`  Flushed batch (entities=${entityBatch.length}, judges ok=${ok}, err=${err})\n`);

    // Reset batches.
    entityBatch.length = 0;
    pendingJudgeRows.length = 0;
  }

  let rowsRead = 0;

  for await (const row of streamFjcCsv(csvPath)) {
    rowsRead++;

    const fullName = buildFullName(row);
    if (!fullName || !row.nid) {
      totalSkipped++;
      continue;
    }

    // Resolve or create the court.
    const courtName = row.court_name.trim();
    if (!courtName) {
      console.warn(`  Row NID "${row.nid}" has no court name — skipping`);
      totalSkipped++;
      continue;
    }

    const courtType = inferCourtType(row.court_type);
    const circuitNumber = extractCircuitNumber(courtName);

    const courtId = await getOrCreateCourt({
      name: courtName,
      court_type: courtType,
      jurisdiction_id: federalJurisdictionId,
      circuit_number: circuitNumber,
      metadata: { fjc_court_type: row.court_type },
    });

    if (!courtId) {
      totalSkipped++;
      continue;
    }

    const judgeSlug = buildJudgeSlug(fullName, row.nid);

    // Entity insert (upsert key: external_ids.fjc_nid).
    const entityInsert: EntityInsert = {
      entity_type: 'judge',
      name: fullName,
      aliases: [],
      external_ids: { fjc_nid: row.nid },
      metadata: {
        court_name: courtName,
        court_type: courtType,
      },
    };

    entityBatch.push({ nid: row.nid, insert: entityInsert });
    pendingJudgeRows.push({
      nid: row.nid,
      courtId,
      row,
      fullName,
      slug: judgeSlug,
    });

    if (entityBatch.length >= BATCH_SIZE) {
      await flushBatch();
    }
  }

  // Flush any remaining records.
  await flushBatch();

  console.log(`\n  CSV rows read: ${rowsRead}`);
  console.log(
    `\n=== Completed. Inserted/updated: ${totalInserted}, skipped: ${totalSkipped} ===`,
  );
}

importJudges().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
