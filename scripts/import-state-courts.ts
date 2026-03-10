/**
 * Import state courts and judges from a local JSON snapshot.
 *
 * Source file: data/state-courts.json
 *
 * For each state entry this script:
 *   1. Resolves the state jurisdiction_id via slug lookup (cached).
 *   2. Upserts a courts row for each court, storing selection_method and
 *      num_seats in courts.metadata.
 *   3. For each judge, creates or resolves an entities row (entity_type='judge')
 *      using external_ids->>'state_judge_slug' as the idempotency key.
 *   4. Upserts a judges row linked to the entity and court, deduplicating on
 *      the judges.slug unique index.
 *   Records are processed in batches of 100.
 *
 * Run with:  npx tsx --env-file=.env scripts/import-state-courts.ts
 * Filter:    STATES=AL,AK npx tsx --env-file=.env scripts/import-state-courts.ts
 */

import { readFileSync } from 'node:fs';
import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CourtType =
  | 'supreme'
  | 'circuit'
  | 'district'
  | 'bankruptcy'
  | 'state_supreme'
  | 'state_appellate'
  | 'state_trial'
  | 'special';

interface JsonJudge {
  first_name: string;
  last_name: string;
  full_name: string;
  appointing_president: string | null;
  term_start: string | null;
  term_end: string | null;
  role: string | null;
}

interface JsonCourt {
  name: string;
  court_type: CourtType;
  website: string | null;
  selection_method: string | null;
  num_seats: number | null;
  judges: JsonJudge[];
}

interface JsonData {
  [stateAbbr: string]: {
    courts: JsonCourt[];
  };
}

interface CourtUpsert {
  name: string;
  slug: string;
  court_type: CourtType;
  jurisdiction_id: string | null;
  circuit_number: null;
  website: string | null;
  metadata: Record<string, unknown>;
}

interface EntityInsert {
  entity_type: 'judge';
  name: string;
  aliases: string[];
  external_ids: Record<string, string>;
  metadata: Record<string, unknown>;
}

interface JudgeUpsert {
  entity_id: string;
  court_id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  slug: string;
  appointing_president: string | null;
  commission_date: string | null;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100;

/**
 * Maps two-letter state abbreviations to GovGuide jurisdictions.slug values.
 */
const STATE_ABBR_TO_SLUG: Record<string, string> = {
  AL: 'alabama',
  AK: 'alaska',
  AZ: 'arizona',
  AR: 'arkansas',
  CA: 'california',
  CO: 'colorado',
  CT: 'connecticut',
  DE: 'delaware',
  FL: 'florida',
  GA: 'georgia',
  HI: 'hawaii',
  ID: 'idaho',
  IL: 'illinois',
  IN: 'indiana',
  IA: 'iowa',
  KS: 'kansas',
  KY: 'kentucky',
  LA: 'louisiana',
  ME: 'maine',
  MD: 'maryland',
  MA: 'massachusetts',
  MI: 'michigan',
  MN: 'minnesota',
  MS: 'mississippi',
  MO: 'missouri',
  MT: 'montana',
  NE: 'nebraska',
  NV: 'nevada',
  NH: 'new-hampshire',
  NJ: 'new-jersey',
  NM: 'new-mexico',
  NY: 'new-york',
  NC: 'north-carolina',
  ND: 'north-dakota',
  OH: 'ohio',
  OK: 'oklahoma',
  OR: 'oregon',
  PA: 'pennsylvania',
  RI: 'rhode-island',
  SC: 'south-carolina',
  SD: 'south-dakota',
  TN: 'tennessee',
  TX: 'texas',
  UT: 'utah',
  VT: 'vermont',
  VA: 'virginia',
  WA: 'washington',
  WV: 'west-virginia',
  WI: 'wisconsin',
  WY: 'wyoming',
  DC: 'district-of-columbia',
};

const ALL_STATE_ABBRS = Object.keys(STATE_ABBR_TO_SLUG);

// Allow filtering to a subset via env:  STATES=AL,AK  (comma-separated)
function getTargetStates(): string[] {
  const raw = process.env.STATES?.trim();
  if (!raw) return ALL_STATE_ABBRS;
  const requested = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const valid = requested.filter((s) => STATE_ABBR_TO_SLUG[s]);
  const invalid = requested.filter((s) => !STATE_ABBR_TO_SLUG[s]);
  if (invalid.length > 0) {
    console.warn(`  WARN: Unknown state codes ignored: ${invalid.join(', ')}`);
  }
  return valid;
}

const STATE_ABBRS = getTargetStates();

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
 * Normalise an ISO date string.  Accepts YYYY-MM-DD and passes it through.
 * Returns null for empty or non-date strings.
 */
function normaliseDate(raw: string | null | undefined): string | null {
  if (!raw || raw.trim() === '') return null;
  const trimmed = raw.trim();
  // Already ISO format: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  return null;
}

// ---------------------------------------------------------------------------
// Caches (to avoid redundant DB round-trips within a single run)
// ---------------------------------------------------------------------------

/** jurisdictions.slug → jurisdictions.id */
const jurisdictionCache = new Map<string, string>();

/** court slug → courts.id */
const courtCache = new Map<string, string>();

/**
 * state_judge_slug → entities.id
 *
 * Populated after the first successful entity lookup or insert so we never
 * query the same judge more than once per run.
 */
const entityCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function getJurisdictionId(stateAbbr: string): Promise<string | null> {
  const slug = STATE_ABBR_TO_SLUG[stateAbbr.toUpperCase()];
  if (!slug) {
    console.warn(`  Unknown state abbreviation: "${stateAbbr}" — skipping`);
    return null;
  }

  if (jurisdictionCache.has(slug)) return jurisdictionCache.get(slug)!;

  const { data, error } = await supabase
    .from('jurisdictions')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();

  if (error) {
    console.error(`  ERROR looking up jurisdiction "${slug}": ${error.message}`);
    return null;
  }

  if (!data) {
    console.warn(`  Jurisdiction not found for slug "${slug}" — skipping`);
    return null;
  }

  jurisdictionCache.set(slug, (data as { id: string }).id);
  return (data as { id: string }).id;
}

/**
 * Upsert a court row and return its UUID.
 *
 * Courts are deduplicated on their slug (unique index).  We check the in-process
 * cache first to avoid round-trips when the same court appears in multiple runs.
 */
async function upsertCourt(insert: CourtUpsert): Promise<string | null> {
  if (courtCache.has(insert.slug)) return courtCache.get(insert.slug)!;

  const { data, error } = await supabase
    .from('courts')
    .upsert(insert, { onConflict: 'slug' })
    .select('id')
    .single();

  if (error || !data) {
    console.error(`  ERROR upserting court "${insert.name}": ${error?.message}`);
    return null;
  }

  const id = (data as { id: string }).id;
  courtCache.set(insert.slug, id);
  return id;
}

/**
 * Resolve or create an entity row for a state judge.
 *
 * Idempotency key: external_ids->>'state_judge_slug'.
 * Uses the in-process entityCache to skip repeated DB lookups within a run.
 */
async function resolveOrCreateEntity(
  judgeSlug: string,
  insert: EntityInsert,
): Promise<string | null> {
  if (entityCache.has(judgeSlug)) return entityCache.get(judgeSlug)!;

  // Check for an existing entity with the matching external_ids key.
  const { data: existing } = await supabase
    .from('entities')
    .select('id')
    .contains('external_ids', { state_judge_slug: judgeSlug })
    .maybeSingle();

  if (existing) {
    const id = (existing as { id: string }).id;
    entityCache.set(judgeSlug, id);
    return id;
  }

  // Insert a new entity.
  const { data: created, error } = await supabase
    .from('entities')
    .insert(insert)
    .select('id')
    .single();

  if (error || !created) {
    // Handle name uniqueness collision — append slug suffix to disambiguate.
    if (error && error.message.includes('uq_entities_name')) {
      const disambiguatedInsert: EntityInsert = {
        ...insert,
        name: `${insert.name} (${judgeSlug})`,
      };
      const { data: retry, error: retryErr } = await supabase
        .from('entities')
        .insert(disambiguatedInsert)
        .select('id')
        .single();

      if (retry) {
        const id = (retry as { id: string }).id;
        entityCache.set(judgeSlug, id);
        return id;
      }

      console.error(`  ENTITY ERROR "${insert.name}" (${judgeSlug}): ${retryErr?.message}`);
      return null;
    }

    console.error(`  ENTITY ERROR "${insert.name}" (${judgeSlug}): ${error?.message}`);
    return null;
  }

  const id = (created as { id: string }).id;
  entityCache.set(judgeSlug, id);
  return id;
}

/**
 * Batch-upsert judge rows, deduplicating on the slug unique index.
 */
async function flushJudges(batch: JudgeUpsert[]): Promise<{ ok: number; err: number }> {
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

async function importStateCourts(): Promise<void> {
  console.log('=== Import State Courts and Judges ===\n');

  const dataPath = new URL('../data/state-courts.json', import.meta.url);
  const raw = readFileSync(dataPath, 'utf-8');
  const jsonData = JSON.parse(raw) as JsonData;

  let totalCourtsCreated = 0;
  let totalJudgesInserted = 0;
  let totalJudgesSkipped = 0;

  for (const stateAbbr of STATE_ABBRS) {
    const stateEntry = jsonData[stateAbbr];
    if (!stateEntry) {
      console.log(`\n--- ${stateAbbr} --- (no data in JSON, skipping)`);
      continue;
    }

    console.log(`\n--- ${stateAbbr} ---`);
    console.log(`  Courts in JSON: ${stateEntry.courts.length}`);

    const jurisdictionId = await getJurisdictionId(stateAbbr);
    if (!jurisdictionId) {
      const judgeCount = stateEntry.courts.reduce((n, c) => n + c.judges.length, 0);
      totalJudgesSkipped += judgeCount;
      continue;
    }

    for (const court of stateEntry.courts) {
      // Build a stable court slug: {stateAbbr-lower}-{slugified-court-name}
      const courtSlug = slugify(`${stateAbbr}-${court.name}`);

      const courtUpsert: CourtUpsert = {
        name: court.name,
        slug: courtSlug,
        court_type: court.court_type,
        jurisdiction_id: jurisdictionId,
        circuit_number: null,
        website: court.website ?? null,
        metadata: {
          selection_method: court.selection_method ?? null,
          num_seats: court.num_seats ?? null,
        },
      };

      const courtId = await upsertCourt(courtUpsert);
      if (!courtId) {
        totalJudgesSkipped += court.judges.length;
        continue;
      }

      totalCourtsCreated++;
      console.log(`  Court: ${court.name} (${court.judges.length} judges)`);

      // Accumulate judge inserts and flush in batches of BATCH_SIZE.
      const judgesBatch: JudgeUpsert[] = [];

      for (const judge of court.judges) {
        const fullName = judge.full_name?.trim() || `${judge.first_name} ${judge.last_name}`.trim();
        if (!fullName) {
          console.warn(`    Skipping judge with no name in court "${court.name}"`);
          totalJudgesSkipped++;
          continue;
        }

        // Judge slug: slugify(fullName-stateAbbr-courtType)
        // This keeps the slug unique across states and court types while
        // remaining stable across re-imports of the same JSON.
        const judgeSlug = slugify(`${fullName}-${stateAbbr}-${court.court_type}`);

        // Entity insert payload.
        const entityInsert: EntityInsert = {
          entity_type: 'judge',
          name: fullName,
          aliases: [],
          external_ids: { state_judge_slug: judgeSlug },
          metadata: {
            state: stateAbbr,
            court_name: court.name,
            court_type: court.court_type,
          },
        };

        const entityId = await resolveOrCreateEntity(judgeSlug, entityInsert);
        if (!entityId) {
          totalJudgesSkipped++;
          continue;
        }

        const judgeUpsert: JudgeUpsert = {
          entity_id: entityId,
          court_id: courtId,
          first_name: judge.first_name?.trim() ?? '',
          last_name: judge.last_name?.trim() ?? '',
          full_name: fullName,
          slug: judgeSlug,
          // appointing_president is a plain text field; null for elected judges.
          appointing_president: judge.appointing_president?.trim() || null,
          // term_start maps to commission_date per the judges schema.
          commission_date: normaliseDate(judge.term_start),
          metadata: {
            term_end: normaliseDate(judge.term_end),
            role: judge.role?.trim() || null,
          },
        };

        judgesBatch.push(judgeUpsert);

        if (judgesBatch.length >= BATCH_SIZE) {
          const { ok, err } = await flushJudges(judgesBatch.splice(0, BATCH_SIZE));
          totalJudgesInserted += ok;
          totalJudgesSkipped += err;
          process.stdout.write(`    Flushed batch (ok=${ok}, err=${err})\n`);
        }
      }

      // Flush the remaining judges for this court.
      if (judgesBatch.length > 0) {
        const { ok, err } = await flushJudges(judgesBatch);
        totalJudgesInserted += ok;
        totalJudgesSkipped += err;
        process.stdout.write(`    Flushed final batch (ok=${ok}, err=${err})\n`);
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log(`  Courts created/updated : ${totalCourtsCreated}`);
  console.log(`  Judges inserted/updated: ${totalJudgesInserted}`);
  console.log(`  Judges skipped         : ${totalJudgesSkipped}`);
  console.log('=== Completed ===');
}

importStateCourts().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
