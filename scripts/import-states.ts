import { supabase } from './lib/supabase-admin';

const states = [
  { name: 'Alabama', abbr: 'AL', fips: '01' },
  { name: 'Alaska', abbr: 'AK', fips: '02' },
  { name: 'Arizona', abbr: 'AZ', fips: '04' },
  { name: 'Arkansas', abbr: 'AR', fips: '05' },
  { name: 'California', abbr: 'CA', fips: '06' },
  { name: 'Colorado', abbr: 'CO', fips: '08' },
  { name: 'Connecticut', abbr: 'CT', fips: '09' },
  { name: 'Delaware', abbr: 'DE', fips: '10' },
  { name: 'District of Columbia', abbr: 'DC', fips: '11' },
  { name: 'Florida', abbr: 'FL', fips: '12' },
  { name: 'Georgia', abbr: 'GA', fips: '13' },
  { name: 'Hawaii', abbr: 'HI', fips: '15' },
  { name: 'Idaho', abbr: 'ID', fips: '16' },
  { name: 'Illinois', abbr: 'IL', fips: '17' },
  { name: 'Indiana', abbr: 'IN', fips: '18' },
  { name: 'Iowa', abbr: 'IA', fips: '19' },
  { name: 'Kansas', abbr: 'KS', fips: '20' },
  { name: 'Kentucky', abbr: 'KY', fips: '21' },
  { name: 'Louisiana', abbr: 'LA', fips: '22' },
  { name: 'Maine', abbr: 'ME', fips: '23' },
  { name: 'Maryland', abbr: 'MD', fips: '24' },
  { name: 'Massachusetts', abbr: 'MA', fips: '25' },
  { name: 'Michigan', abbr: 'MI', fips: '26' },
  { name: 'Minnesota', abbr: 'MN', fips: '27' },
  { name: 'Mississippi', abbr: 'MS', fips: '28' },
  { name: 'Missouri', abbr: 'MO', fips: '29' },
  { name: 'Montana', abbr: 'MT', fips: '30' },
  { name: 'Nebraska', abbr: 'NE', fips: '31' },
  { name: 'Nevada', abbr: 'NV', fips: '32' },
  { name: 'New Hampshire', abbr: 'NH', fips: '33' },
  { name: 'New Jersey', abbr: 'NJ', fips: '34' },
  { name: 'New Mexico', abbr: 'NM', fips: '35' },
  { name: 'New York', abbr: 'NY', fips: '36' },
  { name: 'North Carolina', abbr: 'NC', fips: '37' },
  { name: 'North Dakota', abbr: 'ND', fips: '38' },
  { name: 'Ohio', abbr: 'OH', fips: '39' },
  { name: 'Oklahoma', abbr: 'OK', fips: '40' },
  { name: 'Oregon', abbr: 'OR', fips: '41' },
  { name: 'Pennsylvania', abbr: 'PA', fips: '42' },
  { name: 'Rhode Island', abbr: 'RI', fips: '44' },
  { name: 'South Carolina', abbr: 'SC', fips: '45' },
  { name: 'South Dakota', abbr: 'SD', fips: '46' },
  { name: 'Tennessee', abbr: 'TN', fips: '47' },
  { name: 'Texas', abbr: 'TX', fips: '48' },
  { name: 'Utah', abbr: 'UT', fips: '49' },
  { name: 'Vermont', abbr: 'VT', fips: '50' },
  { name: 'Virginia', abbr: 'VA', fips: '51' },
  { name: 'Washington', abbr: 'WA', fips: '53' },
  { name: 'West Virginia', abbr: 'WV', fips: '54' },
  { name: 'Wisconsin', abbr: 'WI', fips: '55' },
  { name: 'Wyoming', abbr: 'WY', fips: '56' },
];

async function importStates() {
  const { data: federal } = await supabase
    .from('jurisdictions')
    .select('id')
    .eq('slug', 'usa')
    .single();

  if (!federal) throw new Error('Federal jurisdiction not found. Run migrations first.');

  const rows = states.map((s) => ({
    name: s.name,
    slug: s.name.toLowerCase().replace(/\s+/g, '-'),
    level: 'state' as const,
    fips_code: s.fips,
    state_abbr: s.abbr,
    parent_id: federal.id,
    website: `https://${s.abbr.toLowerCase()}.gov`,
  }));

  const { data, error } = await supabase
    .from('jurisdictions')
    .upsert(rows, { onConflict: 'fips_code' })
    .select();

  if (error) throw error;
  console.log(`Imported ${data.length} states + DC`);
}

importStates().catch(console.error);
