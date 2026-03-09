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

  // --- Pillar 2: Follow the Money ---

  const { count: entityCount } = await supabase
    .from('entities')
    .select('id', { count: 'exact', head: true });

  results.push({
    check: 'Graph entities',
    expected: '≥ 1',
    actual: entityCount ?? 0,
    pass: (entityCount ?? 0) >= 1,
  });

  const { count: relationshipCount } = await supabase
    .from('relationships')
    .select('id', { count: 'exact', head: true });

  results.push({
    check: 'Graph relationships',
    expected: '≥ 1',
    actual: relationshipCount ?? 0,
    pass: (relationshipCount ?? 0) >= 1,
  });

  const { count: contributionCount } = await supabase
    .from('contributions')
    .select('id', { count: 'exact', head: true });

  results.push({
    check: 'FEC contributions',
    expected: '≥ 0',
    actual: contributionCount ?? 0,
    pass: true,
  });

  const { count: billCount } = await supabase
    .from('bills')
    .select('id', { count: 'exact', head: true });

  results.push({
    check: 'Bills',
    expected: '≥ 0',
    actual: billCount ?? 0,
    pass: true,
  });

  const { count: tradeCount } = await supabase
    .from('stock_trades')
    .select('id', { count: 'exact', head: true });

  results.push({
    check: 'Stock trades',
    expected: '≥ 0',
    actual: tradeCount ?? 0,
    pass: true,
  });

  const { count: judgeCount } = await supabase
    .from('judges')
    .select('id', { count: 'exact', head: true });

  results.push({
    check: 'Judges',
    expected: '≥ 0',
    actual: judgeCount ?? 0,
    pass: true,
  });

  const { count: conflictCount } = await supabase
    .from('conflict_alerts')
    .select('id', { count: 'exact', head: true });

  results.push({
    check: 'Conflict alerts',
    expected: '≥ 0',
    actual: conflictCount ?? 0,
    pass: true,
  });

  const { count: pollCount } = await supabase
    .from('polls')
    .select('id', { count: 'exact', head: true });

  results.push({
    check: 'Polls',
    expected: '≥ 0',
    actual: pollCount ?? 0,
    pass: true,
  });

  const { count: predictionCount } = await supabase
    .from('prediction_contracts')
    .select('id', { count: 'exact', head: true });

  results.push({
    check: 'Prediction contracts',
    expected: '≥ 0',
    actual: predictionCount ?? 0,
    pass: true,
  });

  // Print results
  console.log('\n=== GovGuide Data Validation ===\n');
  console.log('--- Pillar 1: Navigate ---');

  let allPassed = true;
  const pillar1Checks = results.slice(0, 9);
  const pillar2Checks = results.slice(9);

  for (const r of pillar1Checks) {
    const status = r.pass ? '✓' : '✗';
    console.log(`${status} ${r.check}: ${r.actual} (expected ${r.expected})`);
    if (!r.pass) allPassed = false;
  }

  console.log('\n--- Pillar 2 & 3: Follow the Money / Connect the Dots ---');
  for (const r of pillar2Checks) {
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
