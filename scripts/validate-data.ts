import { supabase } from './lib/supabase-admin';

interface ValidationResult {
  check: string;
  expected: string;
  actual: number | string;
  pass: boolean;
}

async function validateData() {
  const results: ValidationResult[] = [];

  // Check states
  const { count: stateCount } = await supabase
    .from('jurisdictions')
    .select('id', { count: 'exact', head: true })
    .eq('level', 'state');

  results.push({
    check: 'State jurisdictions',
    expected: '≥ 50',
    actual: stateCount ?? 0,
    pass: (stateCount ?? 0) >= 50,
  });

  // Check counties
  const { count: countyCount } = await supabase
    .from('jurisdictions')
    .select('id', { count: 'exact', head: true })
    .eq('level', 'county');

  results.push({
    check: 'County jurisdictions',
    expected: '≥ 3000',
    actual: countyCount ?? 0,
    pass: (countyCount ?? 0) >= 3000,
  });

  // Check cities
  const { count: cityCount } = await supabase
    .from('jurisdictions')
    .select('id', { count: 'exact', head: true })
    .eq('level', 'city');

  results.push({
    check: 'City jurisdictions',
    expected: '≥ 1000',
    actual: cityCount ?? 0,
    pass: (cityCount ?? 0) >= 1000,
  });

  // Check federal jurisdiction exists
  const { data: federal } = await supabase
    .from('jurisdictions')
    .select('id')
    .eq('slug', 'usa')
    .single();

  results.push({
    check: 'Federal jurisdiction',
    expected: 'exists',
    actual: federal ? 'exists' : 'missing',
    pass: !!federal,
  });

  // Check agencies
  const { count: agencyCount } = await supabase
    .from('agencies')
    .select('id', { count: 'exact', head: true });

  results.push({
    check: 'Federal agencies',
    expected: '≥ 10',
    actual: agencyCount ?? 0,
    pass: (agencyCount ?? 0) >= 10,
  });

  // Check officials
  const { count: officialCount } = await supabase
    .from('officials')
    .select('id', { count: 'exact', head: true })
    .eq('is_current', true);

  results.push({
    check: 'Current officials',
    expected: '≥ 100',
    actual: officialCount ?? 0,
    pass: (officialCount ?? 0) >= 100,
  });

  // Check ZIP crosswalk
  const { count: zipCount } = await supabase
    .from('zip_jurisdictions')
    .select('id', { count: 'exact', head: true });

  results.push({
    check: 'ZIP code mappings',
    expected: '≥ 30000',
    actual: zipCount ?? 0,
    pass: (zipCount ?? 0) >= 30000,
  });

  // Check election services
  const { count: electionServiceCount } = await supabase
    .from('election_services')
    .select('id', { count: 'exact', head: true });

  results.push({
    check: 'Election services entries',
    expected: '≥ 50',
    actual: electionServiceCount ?? 0,
    pass: (electionServiceCount ?? 0) >= 50,
  });

  // Check law sources
  const { count: lawCount } = await supabase
    .from('law_sources')
    .select('id', { count: 'exact', head: true });

  results.push({
    check: 'Law sources',
    expected: '≥ 4',
    actual: lawCount ?? 0,
    pass: (lawCount ?? 0) >= 4,
  });

  // Print results
  console.log('\n=== GovGuide Data Validation ===\n');

  let allPassed = true;
  for (const r of results) {
    const status = r.pass ? '✓' : '✗';
    console.log(`${status} ${r.check}: ${r.actual} (expected ${r.expected})`);
    if (!r.pass) allPassed = false;
  }

  console.log(`\n${allPassed ? 'All checks passed!' : 'Some checks failed.'}\n`);

  if (!allPassed) {
    process.exit(1);
  }
}

validateData().catch((err) => {
  console.error('Validation error:', err);
  process.exit(1);
});
