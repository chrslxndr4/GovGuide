/**
 * Import current members of Congress from Congress.gov API.
 *
 * Requires environment variable:  CONGRESS_API_KEY
 *
 * Run with:  npm run import:congress
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Party = 'democratic' | 'republican' | 'independent' | 'libertarian' | 'green' | 'other';
type Branch = 'legislative';
type Chamber = 'senate' | 'house';

interface CongressApiMember {
  bioguideId: string;
  name: string;
  state: string;           // e.g. "TX"
  district: number | null; // null for senators
  partyName: string;       // "Democratic", "Republican", "Independent" …
  chamber: string;         // "House of Representatives" | "Senate"
  url: string | null;      // congress.gov URL
  depiction?: {
    imageUrl?: string;
  };
  terms?: {
    item?: Array<{ startYear: number; endYear: number | null; chamber: string }>;
  };
}

interface CongressApiResponse {
  members: CongressApiMember[];
  pagination: {
    count: number;
    total: number;
    next: string | null;
  };
}

interface OfficialInsert {
  first_name: string;
  last_name: string;
  full_name: string;
  slug: string;
  office_id: string;
  party: Party | null;
  photo_url: string | null;
  website: string | null;
  term_start: string | null;
  term_end: string | null;
  is_current: boolean;
  bioguide_id: string;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONGRESS_API_BASE = 'https://api.congress.gov/v3';
const PAGE_LIMIT = 250;

// Maps full state names (from Congress.gov) and two-letter abbreviations to
// the slug we use in the jurisdictions table.
const STATE_SLUG_MAP: Record<string, string> = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas',
  CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware',
  FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho',
  IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas',
  KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
  MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi',
  MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada',
  NH: 'new-hampshire', NJ: 'new-jersey', NM: 'new-mexico', NY: 'new-york',
  NC: 'north-carolina', ND: 'north-dakota', OH: 'ohio', OK: 'oklahoma',
  OR: 'oregon', PA: 'pennsylvania', RI: 'rhode-island', SC: 'south-carolina',
  SD: 'south-dakota', TN: 'tennessee', TX: 'texas', UT: 'utah',
  VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west-virginia',
  WI: 'wisconsin', WY: 'wyoming',
  // Non-voting delegates
  DC: 'district-of-columbia', PR: 'puerto-rico', GU: 'guam',
  VI: 'us-virgin-islands', MP: 'northern-mariana-islands', AS: 'american-samoa',
};

// Reverse map: full state name → abbreviation (Congress API returns full names)
const STATE_NAME_TO_ABBR: Record<string, string> = {
  'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR',
  'California': 'CA', 'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE',
  'Florida': 'FL', 'Georgia': 'GA', 'Hawaii': 'HI', 'Idaho': 'ID',
  'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA', 'Kansas': 'KS',
  'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD',
  'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN', 'Mississippi': 'MS',
  'Missouri': 'MO', 'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH', 'Oklahoma': 'OK',
  'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX', 'Utah': 'UT',
  'Vermont': 'VT', 'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV',
  'Wisconsin': 'WI', 'Wyoming': 'WY',
  'District of Columbia': 'DC', 'Puerto Rico': 'PR', 'Guam': 'GU',
  'Virgin Islands': 'VI', 'Northern Mariana Islands': 'MP', 'American Samoa': 'AS',
};

function resolveStateAbbr(stateInput: string): string {
  const upper = stateInput.toUpperCase();
  if (STATE_SLUG_MAP[upper]) return upper; // already an abbreviation
  return STATE_NAME_TO_ABBR[stateInput] ?? stateInput;
}

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
  if (lower.includes('independent')) return 'independent';
  return 'other';
}

/** Derive current chamber from terms array (Congress API doesn't put chamber at top level) */
function deriveCurrentChamber(member: CongressApiMember): string {
  if (member.chamber) return member.chamber;
  const terms = member.terms?.item;
  if (!terms || terms.length === 0) return 'unknown';
  // Latest term is the one without endYear or with the highest startYear
  const sorted = [...terms].sort((a, b) => (b.startYear ?? 0) - (a.startYear ?? 0));
  return sorted[0].chamber ?? 'unknown';
}

function parseName(fullName: string): { first: string; last: string } {
  // Congress.gov returns "Last, First Middle" format
  const commaIndex = fullName.indexOf(',');
  if (commaIndex === -1) {
    const parts = fullName.trim().split(/\s+/);
    return { first: parts.slice(0, -1).join(' '), last: parts.at(-1) ?? '' };
  }
  const last = fullName.slice(0, commaIndex).trim();
  const first = fullName.slice(commaIndex + 1).trim();
  return { first, last };
}

// ---------------------------------------------------------------------------
// Jurisdiction helpers (with a local cache to avoid duplicate DB queries)
// ---------------------------------------------------------------------------

const jurisdictionCache = new Map<string, string>(); // slug → UUID

async function getOrCreateStateJurisdiction(
  stateAbbr: string,
  federalParentId: string,
): Promise<string | null> {
  const slug = STATE_SLUG_MAP[stateAbbr.toUpperCase()];
  if (!slug) {
    console.warn(`  Unknown state abbreviation: ${stateAbbr}`);
    return null;
  }

  if (jurisdictionCache.has(slug)) {
    return jurisdictionCache.get(slug)!;
  }

  // Try to find existing jurisdiction
  const { data: existing } = await supabase
    .from('jurisdictions')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();

  if (existing) {
    jurisdictionCache.set(slug, existing.id as string);
    return existing.id as string;
  }

  // Create a minimal state jurisdiction entry
  const stateName = stateAbbr.toUpperCase();
  const { data: created, error } = await supabase
    .from('jurisdictions')
    .insert({
      name: stateName,
      slug,
      level: 'state',
      state_abbr: stateAbbr.toUpperCase(),
      parent_id: federalParentId,
    })
    .select('id')
    .single();

  if (error || !created) {
    console.error(
      `  ERROR creating jurisdiction for ${stateAbbr}: ${error?.message}`,
    );
    return null;
  }

  jurisdictionCache.set(slug, (created as { id: string }).id);
  return (created as { id: string }).id;
}

// ---------------------------------------------------------------------------
// Office helpers (cache by "chamber:stateSlug:district")
// ---------------------------------------------------------------------------

const officeCache = new Map<string, string>(); // cacheKey → UUID

async function getOrCreateOffice(
  member: CongressApiMember,
  jurisdictionId: string,
): Promise<string | null> {
  const chamberStr = deriveCurrentChamber(member);
  const isSenate = chamberStr.toLowerCase().includes('senate');
  const chamberVal: Chamber = isSenate ? 'senate' : 'house';
  const title = isSenate ? 'U.S. Senator' : 'U.S. Representative';
  const district = member.district != null ? String(member.district) : null;
  const abbr = resolveStateAbbr(member.state);
  const stateSlug = STATE_SLUG_MAP[abbr.toUpperCase()] ?? member.state;
  const cacheKey = `${chamberVal}:${stateSlug}:${district ?? 'at-large'}`;

  if (officeCache.has(cacheKey)) {
    return officeCache.get(cacheKey)!;
  }

  const slug = slugify(
    `${title}-${stateSlug}${district ? `-district-${district}` : ''}`,
  );

  // Try existing
  const { data: existing } = await supabase
    .from('offices')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();

  if (existing) {
    officeCache.set(cacheKey, existing.id as string);
    return existing.id as string;
  }

  const { data: created, error } = await supabase
    .from('offices')
    .insert({
      title,
      slug,
      branch: 'legislative' as Branch,
      chamber: chamberVal,
      jurisdiction_id: jurisdictionId,
      district,
      is_elected: true,
    })
    .select('id')
    .single();

  if (error || !created) {
    console.error(`  ERROR creating office "${slug}": ${error?.message}`);
    return null;
  }

  officeCache.set(cacheKey, (created as { id: string }).id);
  return (created as { id: string }).id;
}

// ---------------------------------------------------------------------------
// API pagination
// ---------------------------------------------------------------------------

async function fetchAllMembers(apiKey: string): Promise<CongressApiMember[]> {
  const allMembers: CongressApiMember[] = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const url = `${CONGRESS_API_BASE}/member?limit=${PAGE_LIMIT}&offset=${offset}&currentMember=true&api_key=${apiKey}`;
    console.log(`  Fetching members offset=${offset} …`);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Congress.gov API returned ${res.status} at offset ${offset}: ${res.statusText}`,
      );
    }

    const body = (await res.json()) as CongressApiResponse;
    total = body.pagination.total ?? body.pagination.count;
    allMembers.push(...body.members);
    offset += body.members.length;

    if (body.members.length === 0) break;
  }

  console.log(`  Total members fetched: ${allMembers.length}`);
  return allMembers;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importCongressMembers(): Promise<void> {
  console.log('=== Import Congress Members ===\n');

  const apiKey = process.env.CONGRESS_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing environment variable: CONGRESS_API_KEY\n' +
        'Obtain a free key at https://api.congress.gov/',
    );
  }

  // Get the federal jurisdiction ID (parent for state lookups / creation)
  const { data: fedJur, error: fedErr } = await supabase
    .from('jurisdictions')
    .select('id')
    .eq('slug', 'usa')
    .single();

  if (fedErr || !fedJur) {
    throw new Error(`Could not find federal jurisdiction: ${fedErr?.message}`);
  }
  const federalJurisdictionId = (fedJur as { id: string }).id;

  const members = await fetchAllMembers(apiKey);

  let inserted = 0;
  let skipped = 0;

  for (const member of members) {
    // 1. Resolve state jurisdiction
    const stateJurisdictionId = await getOrCreateStateJurisdiction(
      resolveStateAbbr(member.state),
      federalJurisdictionId,
    );
    if (!stateJurisdictionId) {
      skipped++;
      continue;
    }

    // 2. Resolve office
    const officeId = await getOrCreateOffice(member, stateJurisdictionId);
    if (!officeId) {
      skipped++;
      continue;
    }

    // 3. Parse name
    const { first, last } = parseName(member.name);
    const fullName = `${first} ${last}`.trim();
    const slug = slugify(`${first}-${last}`);

    // 4. Resolve term dates from the most recent term entry
    const terms = member.terms?.item ?? [];
    const latestTerm = terms.at(-1);
    const termStart = latestTerm?.startYear
      ? `${latestTerm.startYear}-01-03`
      : null;
    const termEnd = latestTerm?.endYear
      ? `${latestTerm.endYear}-01-03`
      : null;

    const official: OfficialInsert = {
      first_name: first,
      last_name: last,
      full_name: fullName,
      slug,
      office_id: officeId,
      party: mapParty(member.partyName),
      photo_url: member.depiction?.imageUrl ?? null,
      website: member.url ?? null,
      term_start: termStart,
      term_end: termEnd,
      is_current: true,
      bioguide_id: member.bioguideId,
      metadata: {
        bioguide_id: member.bioguideId,
        state: member.state,
        district: member.district,
        chamber: member.chamber,
        party_name: member.partyName,
      },
    };

    const { error } = await supabase
      .from('officials')
      .upsert(official, { onConflict: 'bioguide_id' });

    if (error) {
      console.error(`  ERROR upserting ${fullName}: ${error.message}`);
      skipped++;
    } else {
      inserted++;
      process.stdout.write('.');
    }
  }

  console.log(
    `\n\n=== Completed. Inserted/updated: ${inserted}, skipped: ${skipped} ===`,
  );
}

importCongressMembers().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
