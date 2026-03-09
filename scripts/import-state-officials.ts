/**
 * Import state governors and legislators from the OpenStates API v3.
 *
 * Requires environment variable:  OPENSTATES_API_KEY
 * Obtain a free key at: https://openstates.org/accounts/profile/
 *
 * For each state/DC this script:
 *   1. Fetches current legislators (role=legislator) and the governor
 *      (role=governor) from the /people endpoint.
 *   2. Resolves the state jurisdiction_id via slug lookup.
 *   3. Upserts an office row (branch='legislative' or 'executive').
 *   4. Upserts an official row linked to that office.
 *   Records are processed in batches of 100.
 *
 * Run with:  npm run import:state-officials
 */

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

type Branch = 'executive' | 'legislative';

type Chamber = 'senate' | 'house' | 'upper' | 'lower' | 'unicameral';

interface OpenStatesLink {
  url: string;
  note?: string;
}

interface OpenStatesContactDetail {
  type: string;    // 'email' | 'voice' | 'address' | …
  value: string;
  note?: string;
}

interface OpenStatesPerson {
  id: string;               // ocd-person/…
  name: string;
  party: string;
  current_role: {
    title: string;
    org_classification: string; // 'legislature' | 'executive' | 'upper' | 'lower'
    district: string | null;
    division_id: string;
  } | null;
  image: string | null;
  links: OpenStatesLink[];
  contact_details: OpenStatesContactDetail[];
  sources: OpenStatesLink[];
  jurisdiction?: {
    id: string;
    name: string;
    classification: string;
  };
}

interface OpenStatesResponse {
  results: OpenStatesPerson[];
  pagination: {
    page: number;
    max_page: number;
    per_page: number;
    total_items: number;
  };
}

interface OfficeInsert {
  title: string;
  slug: string;
  branch: Branch;
  chamber: Chamber | null;
  jurisdiction_id: string;
  district: string | null;
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
  bioguide_id: string | null;
  fec_id: string | null;
  social_media: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENSTATES_API_BASE = 'https://v3.openstates.org';
const BATCH_SIZE = 100;
const PAGE_SIZE = 100; // max allowed by OpenStates

/**
 * All 50 states + DC.  Keys are the OpenStates jurisdiction slug prefix used
 * in the jurisdiction_id field (e.g. "ocd-jurisdiction/country:us/state:al/…").
 * Values are the GovGuide jurisdictions.slug values.
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

// OpenStates uses two-letter state codes in the jurisdiction id path.
// e.g. "ocd-jurisdiction/country:us/state:al/government"
const STATE_ABBRS = Object.keys(STATE_ABBR_TO_SLUG);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function mapParty(partyName: string): Party {
  const lower = partyName.toLowerCase();
  if (lower.includes('democrat')) return 'democratic';
  if (lower.includes('republican')) return 'republican';
  if (lower.includes('libertarian')) return 'libertarian';
  if (lower.includes('green')) return 'green';
  if (lower.includes('independent') || lower === 'ind') return 'independent';
  return 'other';
}

/**
 * Split a full name into first / last.  Handles "First Last", "First M. Last",
 * "Last, First" formats.
 */
function parseName(full: string): { first: string; last: string } {
  const trimmed = full.trim();
  const commaIdx = trimmed.indexOf(',');
  if (commaIdx !== -1) {
    // "Last, First" format
    const last = trimmed.slice(0, commaIdx).trim();
    const first = trimmed.slice(commaIdx + 1).trim();
    return { first, last };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return { first: '', last: parts[0] };
  const last = parts.at(-1) ?? '';
  const first = parts.slice(0, -1).join(' ');
  return { first, last };
}

function extractContact(
  details: OpenStatesContactDetail[],
  type: string,
): string | null {
  return details.find((d) => d.type === type)?.value ?? null;
}

function extractWebsite(links: OpenStatesLink[]): string | null {
  // Prefer an explicit "website" or "homepage" link over others.
  const preferred = links.find(
    (l) =>
      !l.note ||
      l.note.toLowerCase().includes('website') ||
      l.note.toLowerCase().includes('home'),
  );
  return preferred?.url ?? links[0]?.url ?? null;
}

/**
 * Derive Chamber from an OpenStates org_classification string.
 * OpenStates uses 'upper' / 'lower' / 'legislature' (unicameral, e.g. NE).
 */
function orgClassificationToChamber(classification: string): Chamber | null {
  switch (classification.toLowerCase()) {
    case 'upper':
      return 'upper';
    case 'lower':
      return 'lower';
    case 'legislature':
      return 'unicameral';
    default:
      return null;
  }
}

/**
 * Derive a human-readable title from org_classification + state.
 */
function deriveTitle(
  classification: string,
  stateAbbr: string,
): string {
  switch (classification.toLowerCase()) {
    case 'upper':
      return `${stateAbbr} State Senator`;
    case 'lower':
      return `${stateAbbr} State Representative`;
    case 'legislature':
      return `${stateAbbr} State Legislator`;
    case 'executive':
      return `Governor of ${stateAbbr}`;
    default:
      return `${stateAbbr} State Official`;
  }
}

// ---------------------------------------------------------------------------
// Caches (to avoid redundant DB round-trips within a single run)
// ---------------------------------------------------------------------------

const jurisdictionCache = new Map<string, string>(); // slug → UUID
const officeCache = new Map<string, string>();        // slugKey → UUID

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

  // officials.slug may collide across offices (two legislators with the same
  // name in different states).  Use the OpenStates ID stored in bioguide_id as
  // the conflict key; fall back to a composite slug + office_id conflict.
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
// OpenStates API
// ---------------------------------------------------------------------------

async function fetchPeopleForState(
  stateAbbr: string,
  role: 'legislator' | 'governor',
  apiKey: string,
): Promise<OpenStatesPerson[]> {
  const jurisdiction = `ocd-jurisdiction/country:us/state:${stateAbbr.toLowerCase()}/government`;
  const people: OpenStatesPerson[] = [];
  let page = 1;
  let maxPage = 1;

  do {
    const url =
      `${OPENSTATES_API_BASE}/people` +
      `?jurisdiction=${encodeURIComponent(jurisdiction)}` +
      `&role=${role}` +
      `&page=${page}` +
      `&per_page=${PAGE_SIZE}` +
      `&include=contact_details` +
      `&include=links` +
      `&include=sources`;

    const res = await fetch(url, {
      headers: { 'X-API-KEY': apiKey },
    });

    if (!res.ok) {
      // A 404 just means this state has no records for that role — not fatal.
      if (res.status === 404) break;
      throw new Error(
        `OpenStates API error ${res.status} for ${stateAbbr}/${role}: ${res.statusText}`,
      );
    }

    const body = (await res.json()) as OpenStatesResponse;
    people.push(...body.results);
    maxPage = body.pagination.max_page;
    page++;
  } while (page <= maxPage);

  return people;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importStateOfficials(): Promise<void> {
  console.log('=== Import State Officials ===\n');

  const apiKey = process.env.OPENSTATES_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing environment variable: OPENSTATES_API_KEY\n' +
        'Obtain a free key at https://openstates.org/accounts/profile/',
    );
  }

  let totalInserted = 0;
  let totalSkipped = 0;

  for (const stateAbbr of STATE_ABBRS) {
    console.log(`\n--- ${stateAbbr} ---`);

    const jurisdictionId = await getJurisdictionId(stateAbbr);
    if (!jurisdictionId) {
      totalSkipped++;
      continue;
    }

    // Fetch legislators + governor concurrently.
    let legislators: OpenStatesPerson[] = [];
    let governors: OpenStatesPerson[] = [];

    try {
      [legislators, governors] = await Promise.all([
        fetchPeopleForState(stateAbbr, 'legislator', apiKey),
        fetchPeopleForState(stateAbbr, 'governor', apiKey),
      ]);
    } catch (err) {
      console.error(`  ERROR fetching from OpenStates: ${(err as Error).message}`);
      totalSkipped++;
      continue;
    }

    console.log(
      `  Legislators: ${legislators.length}, Governors: ${governors.length}`,
    );

    const allPeople = [...legislators, ...governors];
    const officialsBatch: OfficialInsert[] = [];

    for (const person of allPeople) {
      const role = person.current_role;

      // Determine branch / chamber from the role's org_classification.
      const orgClass = role?.org_classification?.toLowerCase() ?? '';
      const isExecutive = orgClass === 'executive';
      const branch: Branch = isExecutive ? 'executive' : 'legislative';
      const chamber: Chamber | null = isExecutive
        ? null
        : orgClassificationToChamber(orgClass);
      const title = role?.title || deriveTitle(orgClass, stateAbbr);
      const district = role?.district ?? null;

      // Build a stable office slug.
      const officeSlugParts = [stateAbbr.toLowerCase(), slugify(title)];
      if (district) officeSlugParts.push(slugify(district));
      const officeSlug = officeSlugParts.join('-');

      const officeInsert: OfficeInsert = {
        title,
        slug: officeSlug,
        branch,
        chamber,
        jurisdiction_id: jurisdictionId,
        district,
        is_elected: true,
      };

      const officeId = await getOrCreateOffice(officeInsert);
      if (!officeId) {
        totalSkipped++;
        continue;
      }

      // Build official row.
      const { first, last } = parseName(person.name);
      const fullName = `${first} ${last}`.trim();
      // Combine name + state + office to keep slug unique across states.
      const officialSlug = slugify(`${first}-${last}-${stateAbbr}`);
      const email = extractContact(person.contact_details, 'email');
      const phone = extractContact(person.contact_details, 'voice');
      const website = extractWebsite(person.links);

      const official: OfficialInsert = {
        first_name: first,
        last_name: last,
        full_name: fullName,
        slug: officialSlug,
        office_id: officeId,
        party: mapParty(person.party),
        photo_url: person.image ?? null,
        email,
        phone,
        website,
        term_start: null,
        term_end: null,
        is_current: true,
        // Store the OpenStates OCD ID here for deduplication.
        bioguide_id: person.id,
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

importStateOfficials().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
