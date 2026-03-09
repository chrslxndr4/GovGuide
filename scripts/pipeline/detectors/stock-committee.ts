import { createClient } from '@supabase/supabase-js';

export async function detectStockCommitteeConflicts(): Promise<number> {
  const url = process.env.PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase credentials');
  const supabase = createClient(url, key);

  // Committee-to-industry mapping (NAICS prefixes by committee)
  const COMMITTEE_INDUSTRIES: Record<string, { name: string; naics_prefixes: string[] }> = {
    'armed-services': { name: 'Armed Services', naics_prefixes: ['3364', '9271', '5415'] },
    'banking': { name: 'Banking', naics_prefixes: ['522', '523', '524', '5211'] },
    'commerce': { name: 'Commerce', naics_prefixes: ['51', '48', '49', '33'] },
    'energy': { name: 'Energy', naics_prefixes: ['211', '213', '2211', '3241'] },
    'finance': { name: 'Finance', naics_prefixes: ['522', '523', '524', '525'] },
    'health': { name: 'Health', naics_prefixes: ['621', '622', '623', '3254', '5417'] },
    'agriculture': { name: 'Agriculture', naics_prefixes: ['111', '112', '311', '3253'] },
    'technology': { name: 'Technology', naics_prefixes: ['5112', '5182', '5191', '3341', '3342'] },
    'transportation': { name: 'Transportation', naics_prefixes: ['481', '482', '483', '484', '485'] },
  };

  // Sector-to-committee rough mapping for ticker-based matching
  const SECTOR_COMMITTEES: Record<string, string[]> = {
    'Technology': ['commerce', 'technology'],
    'Healthcare': ['health'],
    'Financial Services': ['banking', 'finance'],
    'Energy': ['energy'],
    'Defense': ['armed-services'],
    'Industrials': ['transportation', 'commerce'],
  };

  // Fetch all officials with holdings
  const { data: holdings, error: holdingsErr } = await supabase
    .from('official_holdings')
    .select(`
      id, official_id, ticker, asset_name, asset_type,
      value_range_low, value_range_high, disclosure_year,
      entity_id
    `)
    .not('ticker', 'is', null);

  if (holdingsErr || !holdings?.length) {
    console.log('[stock-committee] No holdings data found');
    return 0;
  }

  // Fetch officials with their metadata (committee assignments stored there)
  const officialIds = [...new Set(holdings.map(h => h.official_id))];
  const { data: officials } = await supabase
    .from('officials')
    .select('id, full_name, metadata')
    .in('id', officialIds);

  const officialMap = new Map(
    (officials || []).map(o => [o.id, o])
  );

  let alertCount = 0;

  for (const holding of holdings) {
    const official = officialMap.get(holding.official_id);
    if (!official) continue;

    const committees: string[] = official.metadata?.committees || [];
    if (!committees.length) continue;

    // Check if holding's sector overlaps with committee jurisdiction
    for (const committee of committees) {
      const committeeKey = committee.toLowerCase().replace(/[^a-z]/g, '-');
      const industryInfo = COMMITTEE_INDUSTRIES[committeeKey];
      if (!industryInfo) continue;

      // If entity_id exists, check its sector
      let hasOverlap = false;
      let overlapReason = '';

      if (holding.entity_id) {
        const { data: entity } = await supabase
          .from('entity_corporations')
          .select('sector, industry, naics_code')
          .eq('entity_id', holding.entity_id)
          .maybeSingle();

        if (entity?.naics_code) {
          hasOverlap = industryInfo.naics_prefixes.some(p =>
            entity.naics_code.startsWith(p)
          );
          overlapReason = `NAICS ${entity.naics_code} in ${entity.sector}/${entity.industry}`;
        } else if (entity?.sector) {
          const sectorCommittees = SECTOR_COMMITTEES[entity.sector] || [];
          hasOverlap = sectorCommittees.includes(committeeKey);
          overlapReason = `Sector ${entity.sector} overseen by ${committeeKey}`;
        }
      }

      if (!hasOverlap) continue;

      const valueHigh = holding.value_range_high || holding.value_range_low || 0;
      const severity = Math.min(10, Math.max(1,
        valueHigh > 1000000 ? 9 :
        valueHigh > 500000 ? 8 :
        valueHigh > 250000 ? 7 :
        valueHigh > 100000 ? 6 :
        valueHigh > 50000 ? 5 :
        valueHigh > 15000 ? 4 : 3
      ));

      const { error: insertErr } = await supabase
        .from('conflict_alerts')
        .insert({
          alert_type: 'stock_committee',
          official_id: holding.official_id,
          entity_id: holding.entity_id,
          description: `${official.full_name} holds ${holding.ticker} (${holding.asset_name}) worth up to $${valueHigh.toLocaleString()} while serving on ${committee}`,
          evidence: {
            ticker: holding.ticker,
            asset_name: holding.asset_name,
            value_range_low: holding.value_range_low,
            value_range_high: holding.value_range_high,
            committee_name: committee,
            industry_overlap: overlapReason,
            disclosure_year: holding.disclosure_year,
          },
          severity_score: severity,
          status: 'active',
        });

      if (!insertErr) alertCount++;
    }
  }

  console.log(`[stock-committee] Created ${alertCount} conflict alerts`);
  return alertCount;
}
