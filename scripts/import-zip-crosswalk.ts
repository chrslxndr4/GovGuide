import { supabase } from './lib/supabase-admin';
import { readFileSync, existsSync } from 'fs';

interface HudCrosswalkEntry {
  zip: string;
  geoid: string; // County FIPS
  tot_ratio: number;
  bus_ratio: number;
  oth_ratio: number;
  res_ratio: number;
}

interface CsvRow {
  zip: string;
  county_fips: string;
}

async function importFromHudApi() {
  const token = process.env.HUD_API_TOKEN;
  if (!token) throw new Error('HUD_API_TOKEN not set in .env');

  console.log('Fetching ZIP-county crosswalk from HUD API...');
  const url = `https://www.huduser.gov/hudapi/public/usps?type=2&query=All`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) throw new Error(`HUD API error: ${response.status}`);

  const json = await response.json();
  return (json.data?.results ?? json) as HudCrosswalkEntry[];
}

function importFromCsv(): CsvRow[] {
  const csvPath = 'data/zip-county-crosswalk.csv';
  if (!existsSync(csvPath)) {
    throw new Error(
      `No HUD_API_TOKEN and no CSV fallback found at ${csvPath}. ` +
        'Either set HUD_API_TOKEN in .env or provide a CSV with columns: zip,county_fips'
    );
  }

  console.log('Reading ZIP-county crosswalk from CSV fallback...');
  const csv = readFileSync(csvPath, 'utf-8');
  const lines = csv.trim().split('\n');
  const headers = lines[0].split(',');
  const zipIdx = headers.indexOf('zip');
  const fipsIdx = headers.findIndex((h) =>
    ['county_fips', 'geoid', 'county'].includes(h.trim().toLowerCase())
  );

  if (zipIdx === -1 || fipsIdx === -1) {
    throw new Error('CSV must have "zip" and "county_fips" (or "geoid") columns');
  }

  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    return {
      zip: cols[zipIdx].trim().padStart(5, '0'),
      county_fips: cols[fipsIdx].trim(),
    };
  });
}

async function importZipCrosswalk() {
  // Get jurisdiction lookup maps
  const { data: stateJurisdictions } = await supabase
    .from('jurisdictions')
    .select('id, fips_code')
    .eq('level', 'state');

  const { data: countyJurisdictions } = await supabase
    .from('jurisdictions')
    .select('id, fips_code')
    .eq('level', 'county');

  const stateMap = new Map(stateJurisdictions?.map((s) => [s.fips_code, s.id]) ?? []);
  const countyMap = new Map(countyJurisdictions?.map((c) => [c.fips_code, c.id]) ?? []);

  // Try HUD API first, fall back to CSV
  let zipCountyPairs: { zip: string; countyFips: string }[];

  try {
    const hudData = await importFromHudApi();
    zipCountyPairs = hudData.map((entry) => ({
      zip: entry.zip.padStart(5, '0'),
      countyFips: entry.geoid,
    }));
  } catch {
    console.log('HUD API unavailable, trying CSV fallback...');
    const csvData = importFromCsv();
    zipCountyPairs = csvData.map((row) => ({
      zip: row.zip,
      countyFips: row.county_fips,
    }));
  }

  console.log(`Processing ${zipCountyPairs.length} ZIP-county mappings...`);

  const rows = zipCountyPairs.map((pair) => {
    const stateFips = pair.countyFips.substring(0, 2);
    return {
      zip_code: pair.zip,
      state_id: stateMap.get(stateFips) ?? null,
      county_id: countyMap.get(pair.countyFips) ?? null,
    };
  });

  // Insert in batches of 1000
  let total = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const batch = rows.slice(i, i + 1000);
    const { error } = await supabase.from('zip_jurisdictions').upsert(batch);

    if (error) throw error;
    total += batch.length;
    console.log(`Imported ${total} / ${rows.length} ZIP mappings`);
  }

  console.log(`Total ZIP mappings imported: ${rows.length}`);
}

importZipCrosswalk().catch(console.error);
