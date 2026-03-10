/**
 * Import local government units from the Census of Governments 2022 dataset.
 *
 * Source: https://www2.census.gov/programs-surveys/gus/datasets/2022/govt_units_2022.ZIP
 * Contains ~91,000 government units across 4 sheets:
 *   - General Purpose (counties, municipalities, townships): 38,737 units
 *   - Special District (housing, water, fire, etc.): 39,556 units
 *   - School District: 12,547 units
 *   - DEP School Dist (dependent school districts): 1,314 units
 *
 * This script upserts rows into the jurisdictions table using the Census GIDID
 * as the unique identifier. It also stores contact info and metadata.
 *
 * Run with:  npm run import:census-governments
 */

import XLSX from 'xlsx';
import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GovernmentUnit {
  census_id_pid6: string;
  census_id_gidid: string;
  unit_name: string;
  unit_type?: string;
  function_name?: string;
  title?: string;
  address1?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  zip4?: string;
  web_address?: string;
  population?: number;
  population_year?: number;
  enrollment?: number;
  enrollment_year?: number;
  fips_state?: string;
  fips_county?: string;
  county_area_name?: string;
  school_level_description?: string;
}

interface JurisdictionInsert {
  name: string;
  slug: string;
  level: string;
  state_abbr: string | null;
  parent_id: string | null;
  fips_code: string | null;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 500;

const FIPS_STATE_TO_ABBR: Record<string, string> = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA',
  '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL',
  '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN',
  '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME',
  '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS',
  '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND',
  '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
  '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT',
  '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI',
  '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP', '72': 'PR', '78': 'VI',
};

const STATE_ABBR_TO_SLUG: Record<string, string> = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas',
  CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware',
  DC: 'district-of-columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii',
  ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa',
  KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine',
  MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota',
  MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska',
  NV: 'nevada', NH: 'new-hampshire', NJ: 'new-jersey', NM: 'new-mexico',
  NY: 'new-york', NC: 'north-carolina', ND: 'north-dakota', OH: 'ohio',
  OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode-island',
  SC: 'south-carolina', SD: 'south-dakota', TN: 'tennessee', TX: 'texas',
  UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington',
  WV: 'west-virginia', WI: 'wisconsin', WY: 'wyoming',
  AS: 'american-samoa', GU: 'guam', MP: 'northern-mariana-islands',
  PR: 'puerto-rico', VI: 'us-virgin-islands',
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

function mapUnitTypeToLevel(unitType: string | undefined, sheetName: string): string {
  if (sheetName.includes('School')) return 'school_district';
  if (sheetName === 'Special District') return 'special_district';
  if (!unitType) return 'local';
  const t = unitType.toLowerCase();
  if (t.includes('county')) return 'county';
  if (t.includes('municipality') || t.includes('city') || t.includes('town') || t.includes('village') || t.includes('borough')) return 'city';
  if (t.includes('township')) return 'township';
  if (t.includes('state')) return 'state';
  return 'local';
}

function parseUnitType(raw: string | undefined): string | null {
  if (!raw) return null;
  // Format: "1 - COUNTY" → "county"
  const match = raw.match(/^\d+\s*-\s*(.+)$/);
  return match ? match[1].trim().toLowerCase() : raw.toLowerCase();
}

// ---------------------------------------------------------------------------
// Jurisdiction cache (state slug → UUID)
// ---------------------------------------------------------------------------

const stateJurIdCache = new Map<string, string>();

async function getStateJurisdictionId(stateAbbr: string): Promise<string | null> {
  if (stateJurIdCache.has(stateAbbr)) return stateJurIdCache.get(stateAbbr)!;

  const slug = STATE_ABBR_TO_SLUG[stateAbbr];
  if (!slug) return null;

  const { data } = await supabase
    .from('jurisdictions')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();

  if (data) {
    stateJurIdCache.set(stateAbbr, (data as { id: string }).id);
    return (data as { id: string }).id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main import
// ---------------------------------------------------------------------------

async function importSheet(
  wb: XLSX.WorkBook,
  sheetName: string,
): Promise<{ ok: number; err: number; skipped: number }> {
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    console.warn(`  Sheet "${sheetName}" not found — skipping.`);
    return { ok: 0, err: 0, skipped: 0 };
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);
  console.log(`\n--- ${sheetName}: ${rows.length} rows ---`);

  let ok = 0;
  let err = 0;
  let skipped = 0;
  const batch: JurisdictionInsert[] = [];

  for (const row of rows) {
    const gidid = String(row['CENSUS_ID_GIDID'] ?? '').trim();
    const name = String(row['UNIT_NAME'] ?? '').trim();
    const fipsState = String(row['FIPS_STATE'] ?? '').trim();
    const stateAbbr = FIPS_STATE_TO_ABBR[fipsState] ?? (row['STATE'] as string) ?? null;

    if (!name || !gidid) {
      skipped++;
      continue;
    }

    // Resolve parent state jurisdiction
    const parentId = stateAbbr ? await getStateJurisdictionId(stateAbbr) : null;

    const unitTypeRaw = parseUnitType(row['UNIT_TYPE'] as string | undefined);
    const level = mapUnitTypeToLevel(unitTypeRaw ?? undefined, sheetName);

    // Build a slug: e.g. "city-of-prattville-al" or "autauga-county-school-district-al"
    const slugBase = slugify(name);
    const slug = stateAbbr
      ? `${slugBase}-${stateAbbr.toLowerCase()}`
      : slugBase;

    const insert: JurisdictionInsert = {
      name,
      slug,
      level,
      state_abbr: stateAbbr,
      parent_id: parentId,
      fips_code: gidid, // Use Census GIDID as the fips_code for uniqueness
      metadata: {
        census_pid6: row['CENSUS_ID_PID6'] ?? null,
        census_gidid: gidid,
        unit_type: unitTypeRaw,
        function_name: row['FUNCTION_NAME'] ?? null,
        address: [row['ADDRESS1'], row['ADDRESS2']].filter(Boolean).join(', ') || null,
        city: row['CITY'] ?? null,
        zip: row['ZIP'] ?? null,
        web_address: row['WEB_ADDRESS'] ?? null,
        population: row['POPULATION'] ?? null,
        population_year: row['POPULATION_YEAR'] ?? null,
        enrollment: row['ENROLLMENT'] ?? null,
        enrollment_year: row['ENROLLMENT_YEAR'] ?? null,
        county_area: row['COUNTY_AREA_NAME'] ?? null,
        school_level: row['SCHOOL_LEVEL_DESCRIPTION'] ?? null,
      },
    };

    batch.push(insert);

    if (batch.length >= BATCH_SIZE) {
      const { error } = await supabase
        .from('jurisdictions')
        .upsert(batch, { onConflict: 'fips_code' });

      if (error) {
        console.error(`  BATCH ERROR (${batch.length}): ${error.message}`);
        err += batch.length;
      } else {
        ok += batch.length;
        process.stdout.write('.');
      }
      batch.length = 0;
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    const { error } = await supabase
      .from('jurisdictions')
      .upsert(batch, { onConflict: 'fips_code' });

    if (error) {
      console.error(`  BATCH ERROR (${batch.length}): ${error.message}`);
      err += batch.length;
    } else {
      ok += batch.length;
    }
  }

  console.log(`\n  ${sheetName}: inserted/updated ${ok}, errors ${err}, skipped ${skipped}`);
  return { ok, err, skipped };
}

async function importCensusGovernments(): Promise<void> {
  console.log('=== Import Census of Governments (2022) ===\n');

  const filePath = process.env.CENSUS_GOV_XLSX ?? '/tmp/Govt_Units_2022_Final.xlsx';
  console.log(`Reading: ${filePath}`);

  const wb = XLSX.readFile(filePath);
  console.log(`Sheets: ${wb.SheetNames.join(', ')}`);

  let totalOk = 0;
  let totalErr = 0;
  let totalSkipped = 0;

  for (const sheetName of ['General Purpose', 'Special District', 'School District', 'DEP School Dist']) {
    const { ok, err, skipped } = await importSheet(wb, sheetName);
    totalOk += ok;
    totalErr += err;
    totalSkipped += skipped;
  }

  console.log(`\n=== Completed. Inserted/updated: ${totalOk}, errors: ${totalErr}, skipped: ${totalSkipped} ===`);
}

importCensusGovernments().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
