/**
 * Import statewide executive officials (lieutenant governors, attorneys general,
 * secretaries of state, treasurers, etc.) from a local JSON snapshot.
 *
 * Source file: data/statewide-executives.json
 *
 * For each state entry this script:
 *   1. Resolves the state jurisdiction_id via slug lookup (cached).
 *   2. Upserts an office row (branch='executive', chamber=null).
 *   3. Upserts an official row linked to that office.
 *   Records are processed in batches of 100.
 *
 * Run with:  npm run import:statewide-executives
 * Filter:    STATES=AL,AK npm run import:statewide-executives
 */

import { readFileSync } from 'node:fs';
import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Party =
  | 'democratic'
  | 'republican'
  | 'independent'
  | 'libertarian'
  | 'green'
  | 'other';

type Branch = 'executive' | 'legislative' | 'judicial';

interface JsonOfficial {
  first_name: string;
  last_name: string;
  party: Party;
  email: string | null;
  phone: string | null;
  website: string | null;
  photo_url: string | null;
  term_start: string | null;
  term_end: string | null;
}

interface JsonOfficeEntry {
  title: string;
  branch: Branch;
  is_elected: boolean;
  official: JsonOfficial;
}

interface JsonData {
  [stateAbbr: string]: {
    offices: JsonOfficeEntry[];
  };
}

interface OfficeInsert {
  title: string;
  slug: string;
  branch: Branch;
  chamber: null;
  jurisdiction_id: string;
  district: null;
  is_elected: boolean;
}

interface OfficialInsert {
  first_name: string;
  last_name: string;
  full_name: string;
  slug: string;
  office_id: string;
  party: Party;
  photo_url: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  term_start: string | null;
  term_end: string | null;
  is_current: boolean;
  bioguide_id: null;
  fec_id: null;
  social_media: Record<string, string>;
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

function normalizeParty(value: string): Party {
  const lower = value.toLowerCase();
  if (lower.includes('democrat')) return 'democratic';
  if (lower.includes('republican')) return 'republican';
  if (lower.includes('libertarian')) return 'libertarian';
  if (lower.includes('green')) return 'green';
  if (lower.includes('independent') || lower === 'ind') return 'independent';
  return 'other';
}

// ---------------------------------------------------------------------------
// Caches (to avoid redundant DB round-trips within a single run)
// ---------------------------------------------------------------------------

const jurisdictionCache = new Map<string, string>(); // slug → UUID
const officeCache = new Map<string, string>();        // office slug → UUID

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

async function getOrCreateOffice(insert: OfficeInsert): Promise<string | null> {
  const cacheKey = insert.slug;

  if (officeCache.has(cacheKey)) return officeCache.get(cacheKey)!;

  // Try existing record first to avoid redundant upsert round-trips.
  const { data: existing } = await supabase
    .from('offices')
    .select('id')
    .eq('slug', insert.slug)
    .eq('jurisdiction_id', insert.jurisdiction_id)
    .maybeSingle();

  if (existing) {
    officeCache.set(cacheKey, (existing as { id: string }).id);
    return (existing as { id: string }).id;
  }

  const { data: created, error } = await supabase
    .from('offices')
    .insert(insert)
    .select('id')
    .single();

  if (error || !created) {
    console.error(`  ERROR creating office "${insert.slug}": ${error?.message}`);
    return null;
  }

  const id = (created as { id: string }).id;
  officeCache.set(cacheKey, id);
  return id;
}

// ---------------------------------------------------------------------------
// Batch upsert helpers
// ---------------------------------------------------------------------------

async function flushOfficials(batch: OfficialInsert[]): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('officials')
    .upsert(batch, { onConflict: 'slug,office_id' });

  if (error) {
    console.error(`  BATCH ERROR (${batch.length} records): ${error.message}`);
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importStatewideExecutives(): Promise<void> {
  console.log('=== Import Statewide Executives ===\n');

  // Load the JSON snapshot using an import-meta-relative path so this script
  // works regardless of the CWD from which it is invoked.
  const dataPath = new URL('../data/statewide-executives.json', import.meta.url);
  const raw = readFileSync(dataPath, 'utf-8');
  const jsonData = JSON.parse(raw) as JsonData;

  let totalInserted = 0;
  let totalSkipped = 0;

  for (const stateAbbr of STATE_ABBRS) {
    const stateEntry = jsonData[stateAbbr];
    if (!stateEntry) {
      console.log(`\n--- ${stateAbbr} --- (no data in JSON, skipping)`);
      continue;
    }

    console.log(`\n--- ${stateAbbr} ---`);
    console.log(`  Offices in JSON: ${stateEntry.offices.length}`);

    const jurisdictionId = await getJurisdictionId(stateAbbr);
    if (!jurisdictionId) {
      totalSkipped += stateEntry.offices.length;
      continue;
    }

    const officialsBatch: OfficialInsert[] = [];

    for (const entry of stateEntry.offices) {
      // Build a stable office slug: {state_abbr_lower}-{slugified-title}
      const officeSlug = `${stateAbbr.toLowerCase()}-${slugify(entry.title)}`;

      const officeInsert: OfficeInsert = {
        title: entry.title,
        slug: officeSlug,
        branch: entry.branch,
        chamber: null,
        jurisdiction_id: jurisdictionId,
        district: null,
        is_elected: entry.is_elected,
      };

      const officeId = await getOrCreateOffice(officeInsert);
      if (!officeId) {
        totalSkipped++;
        continue;
      }

      const { first_name, last_name } = entry.official;
      const fullName = `${first_name} ${last_name}`.trim();
      // Include state abbreviation in the slug to keep it unique across states
      // (e.g. two "John Smith" attorney generals in different states).
      const officialSlug = slugify(`${first_name}-${last_name}-${stateAbbr}`);

      const official: OfficialInsert = {
        first_name,
        last_name,
        full_name: fullName,
        slug: officialSlug,
        office_id: officeId,
        party: normalizeParty(entry.official.party),
        photo_url: entry.official.photo_url,
        email: entry.official.email,
        phone: entry.official.phone,
        website: entry.official.website,
        term_start: entry.official.term_start,
        term_end: entry.official.term_end,
        is_current: true,
        bioguide_id: null,
        fec_id: null,
        social_media: {},
      };

      officialsBatch.push(official);

      // Flush when the batch is full.
      if (officialsBatch.length >= BATCH_SIZE) {
        const { ok, err } = await flushOfficials(officialsBatch.splice(0, BATCH_SIZE));
        totalInserted += ok;
        totalSkipped += err;
        process.stdout.write(`  Flushed batch (ok=${ok}, err=${err})\n`);
      }
    }

    // Flush remaining records for this state.
    if (officialsBatch.length > 0) {
      const { ok, err } = await flushOfficials(officialsBatch);
      totalInserted += ok;
      totalSkipped += err;
      process.stdout.write(`  Flushed final batch (ok=${ok}, err=${err})\n`);
    }
  }

  console.log(
    `\n=== Completed. Inserted/updated: ${totalInserted}, skipped: ${totalSkipped} ===`,
  );
}

importStatewideExecutives().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
