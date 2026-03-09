import { supabase } from './lib/supabase-admin';

async function importCities() {
  const apiKey = process.env.CENSUS_API_KEY;
  if (!apiKey) throw new Error('CENSUS_API_KEY not set in .env');

  console.log('Fetching incorporated places from Census Bureau...');
  const url = `https://api.census.gov/data/2020/dec/pl?get=NAME,P1_001N&for=place:*&key=${apiKey}`;
  const response = await fetch(url);

  if (!response.ok) throw new Error(`Census API error: ${response.status}`);

  const data: string[][] = await response.json();
  const rows = data.slice(1);

  // Get state jurisdictions for parent mapping
  const { data: states } = await supabase
    .from('jurisdictions')
    .select('id, fips_code')
    .eq('level', 'state');

  const stateMap = new Map(states?.map((s) => [s.fips_code, s.id]) ?? []);

  const cityRows = rows.map((row) => {
    const fullName = row[0];
    const population = parseInt(row[1], 10);
    const stateFips = row[2];
    const placeFips = row[3];
    const fips = `${stateFips}${placeFips}`;

    // Remove suffix like "city", "town", "village", "CDP" for slug
    const slug = fullName
      .toLowerCase()
      .replace(/\s+(city|town|village|cdp|borough|municipality)$/i, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    return {
      name: fullName,
      slug,
      level: 'city' as const,
      fips_code: fips,
      parent_id: stateMap.get(stateFips) ?? null,
      population: isNaN(population) ? null : population,
    };
  });

  // Insert in batches of 500
  let total = 0;
  for (let i = 0; i < cityRows.length; i += 500) {
    const batch = cityRows.slice(i, i + 500);
    const { error } = await supabase
      .from('jurisdictions')
      .upsert(batch, { onConflict: 'fips_code' });

    if (error) throw error;
    total += batch.length;
    console.log(`Imported ${total} / ${cityRows.length} places`);
  }

  console.log(`Total places imported: ${cityRows.length}`);
}

importCities().catch(console.error);
