/**
 * Import federal agencies from:
 *   1. Federal Register API  (https://www.federalregister.gov/api/v1/agencies)
 *   2. CISA dotgov-data CSV  (supplementary .gov domain data)
 *
 * Run with:  npm run import:agencies
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AgencyType =
  | 'cabinet_department'
  | 'independent_agency'
  | 'executive_office'
  | 'regulatory_commission'
  | 'government_corporation'
  | 'quasi_official'
  | 'state_agency'
  | 'county_agency'
  | 'city_agency';

interface FederalRegisterAgency {
  id: number;
  name: string;
  short_name: string | null;
  slug: string;
  description: string | null;
  url: string | null;
  parent_id: number | null;
}

interface AgencyInsert {
  name: string;
  slug: string;
  abbreviation: string | null;
  agency_type: AgencyType;
  jurisdiction_id: string;
  parent_agency_id: string | null;
  description: string | null;
  website: string | null;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FEDERAL_REGISTER_AGENCIES_URL =
  'https://www.federalregister.gov/api/v1/agencies';

/**
 * The 15 cabinet-level departments.  Matching is done case-insensitively
 * against the agency name from the Federal Register API.
 */
const CABINET_DEPARTMENTS = new Set([
  'department of state',
  'department of the treasury',
  'department of defense',
  'department of justice',
  'department of the interior',
  'department of agriculture',
  'department of commerce',
  'department of labor',
  'department of health and human services',
  'department of housing and urban development',
  'department of transportation',
  'department of energy',
  'department of education',
  'department of veterans affairs',
  'department of homeland security',
]);

/**
 * Known independent regulatory commissions.
 */
const REGULATORY_COMMISSIONS = new Set([
  'federal reserve system',
  'federal trade commission',
  'federal communications commission',
  'securities and exchange commission',
  'nuclear regulatory commission',
  'consumer product safety commission',
  'equal employment opportunity commission',
  'federal energy regulatory commission',
  'commodity futures trading commission',
  'national labor relations board',
  'federal election commission',
  'consumer financial protection bureau',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function determineAgencyType(name: string): AgencyType {
  const lower = name.toLowerCase();
  if (CABINET_DEPARTMENTS.has(lower)) return 'cabinet_department';
  if (REGULATORY_COMMISSIONS.has(lower)) return 'regulatory_commission';
  if (
    lower.includes('executive office') ||
    lower.includes('office of the president') ||
    lower === 'office of management and budget' ||
    lower === 'national security council'
  ) {
    return 'executive_office';
  }
  if (
    lower.includes('corporation') ||
    lower.includes('bank for cooperatives')
  ) {
    return 'government_corporation';
  }
  return 'independent_agency';
}

// ---------------------------------------------------------------------------
// Main import logic
// ---------------------------------------------------------------------------

async function fetchFederalRegisterAgencies(): Promise<FederalRegisterAgency[]> {
  console.log(`Fetching agencies from ${FEDERAL_REGISTER_AGENCIES_URL} …`);
  const res = await fetch(FEDERAL_REGISTER_AGENCIES_URL);
  if (!res.ok) {
    throw new Error(
      `Federal Register API returned ${res.status}: ${res.statusText}`,
    );
  }
  const data = (await res.json()) as FederalRegisterAgency[];
  console.log(`  Received ${data.length} agencies.`);
  return data;
}

async function getFederalJurisdictionId(): Promise<string> {
  const { data, error } = await supabase
    .from('jurisdictions')
    .select('id')
    .eq('slug', 'usa')
    .single();

  if (error || !data) {
    throw new Error(
      `Could not find federal jurisdiction (slug='usa'): ${error?.message}`,
    );
  }
  return data.id as string;
}

async function importAgencies(): Promise<void> {
  console.log('=== Import Federal Agencies ===\n');

  const [federalJurisdictionId, rawAgencies] = await Promise.all([
    getFederalJurisdictionId(),
    fetchFederalRegisterAgencies(),
  ]);

  // First pass: insert top-level agencies (no parent) and collect the mapping
  // from Federal Register numeric ID → our UUID so we can link sub-agencies.
  const idMap = new Map<number, string>(); // federalRegister.id → our UUID

  const topLevel = rawAgencies.filter((a) => a.parent_id === null);
  const subLevel = rawAgencies.filter((a) => a.parent_id !== null);

  console.log(
    `Top-level agencies: ${topLevel.length}, sub-agencies: ${subLevel.length}\n`,
  );

  // ---- Insert top-level agencies ------------------------------------------
  console.log('Inserting top-level agencies …');
  for (const agency of topLevel) {
    const insert: AgencyInsert = {
      name: agency.name,
      slug: agency.slug ?? slugify(agency.name),
      abbreviation: agency.short_name ?? null,
      agency_type: determineAgencyType(agency.name),
      jurisdiction_id: federalJurisdictionId,
      parent_agency_id: null,
      description: agency.description ?? null,
      website: agency.url ?? null,
      metadata: { federal_register_id: agency.id },
    };

    const { data, error } = await supabase
      .from('agencies')
      .upsert(insert, { onConflict: 'slug' })
      .select('id')
      .single();

    if (error) {
      console.error(`  ERROR inserting "${agency.name}": ${error.message}`);
      continue;
    }

    idMap.set(agency.id, (data as { id: string }).id);
    process.stdout.write('.');
  }
  console.log('\n  Done.');

  // ---- Insert sub-agencies ------------------------------------------------
  console.log('\nInserting sub-agencies …');
  for (const agency of subLevel) {
    const parentUuid = agency.parent_id ? idMap.get(agency.parent_id) : null;

    const insert: AgencyInsert = {
      name: agency.name,
      slug: agency.slug ?? slugify(agency.name),
      abbreviation: agency.short_name ?? null,
      agency_type: determineAgencyType(agency.name),
      jurisdiction_id: federalJurisdictionId,
      parent_agency_id: parentUuid ?? null,
      description: agency.description ?? null,
      website: agency.url ?? null,
      metadata: {
        federal_register_id: agency.id,
        federal_register_parent_id: agency.parent_id,
      },
    };

    const { data, error } = await supabase
      .from('agencies')
      .upsert(insert, { onConflict: 'slug' })
      .select('id')
      .single();

    if (error) {
      console.error(`  ERROR inserting "${agency.name}": ${error.message}`);
      continue;
    }

    idMap.set(agency.id, (data as { id: string }).id);
    process.stdout.write('.');
  }
  console.log('\n  Done.');

  console.log(
    `\n=== Completed. Total agencies processed: ${rawAgencies.length} ===`,
  );
}

importAgencies().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
