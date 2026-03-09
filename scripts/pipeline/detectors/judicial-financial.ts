import { createClient } from '@supabase/supabase-js';

export async function detectJudicialFinancialConflicts(): Promise<number> {
  const url = process.env.PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase credentials');
  const supabase = createClient(url, key);

  // Find judges who sat on cases where a party matches one of their investments
  // Match via entity_id (direct link) or ticker (indirect link via corporation entities)

  // Step 1: Get all case_judges with their investments
  const { data: caseJudges, error: cjErr } = await supabase
    .from('case_judges')
    .select(`
      id, decision_id, judge_id, role,
      judge:judges!inner(id, full_name, entity_id, court_id)
    `);

  if (cjErr || !caseJudges?.length) {
    console.log('[judicial-financial] No case-judge data found');
    return 0;
  }

  // Build judge IDs set
  const judgeIds = [...new Set(caseJudges.map(cj => cj.judge_id))];

  // Step 2: Fetch all investments for these judges
  const { data: investments } = await supabase
    .from('judge_investments')
    .select('id, judge_id, asset_name, ticker, asset_type, value_range_low, value_range_high, entity_id')
    .in('judge_id', judgeIds);

  if (!investments?.length) {
    console.log('[judicial-financial] No judge investment data found');
    return 0;
  }

  // Index investments by judge_id
  const investmentsByJudge = new Map<string, typeof investments>();
  for (const inv of investments) {
    const existing = investmentsByJudge.get(inv.judge_id) || [];
    existing.push(inv);
    investmentsByJudge.set(inv.judge_id, existing);
  }

  // Step 3: Get all case_parties with entity links
  const decisionIds = [...new Set(caseJudges.map(cj => cj.decision_id))];

  // Batch in chunks of 500
  const allParties: Array<{
    decision_id: string;
    entity_id: string | null;
    party_name: string;
    party_role: string;
  }> = [];

  for (let i = 0; i < decisionIds.length; i += 500) {
    const batch = decisionIds.slice(i, i + 500);
    const { data: parties } = await supabase
      .from('case_parties')
      .select('decision_id, entity_id, party_name, party_role')
      .in('decision_id', batch);
    if (parties) allParties.push(...parties);
  }

  // Index parties by decision_id
  const partiesByDecision = new Map<string, typeof allParties>();
  for (const p of allParties) {
    const existing = partiesByDecision.get(p.decision_id) || [];
    existing.push(p);
    partiesByDecision.set(p.decision_id, existing);
  }

  // Step 4: Fetch decision details for descriptions
  const decisionCache = new Map<string, { case_name: string; case_number: string; decision_date: string }>();

  // Step 5: Cross-reference
  let alertCount = 0;

  for (const cj of caseJudges) {
    const judgeInvestments = investmentsByJudge.get(cj.judge_id);
    if (!judgeInvestments?.length) continue;

    const parties = partiesByDecision.get(cj.decision_id);
    if (!parties?.length) continue;

    for (const inv of judgeInvestments) {
      for (const party of parties) {
        let conflict = false;

        // Match by entity_id (strongest match)
        if (inv.entity_id && party.entity_id && inv.entity_id === party.entity_id) {
          conflict = true;
        }

        // Match by name similarity (weaker)
        if (!conflict && inv.ticker && party.party_name) {
          const tickerInName = party.party_name.toUpperCase().includes(inv.ticker.toUpperCase());
          const assetInName = inv.asset_name &&
            party.party_name.toLowerCase().includes(inv.asset_name.toLowerCase().split(' ')[0]);
          if (tickerInName || assetInName) conflict = true;
        }

        if (!conflict) continue;

        // Get decision details if not cached
        if (!decisionCache.has(cj.decision_id)) {
          const { data: decision } = await supabase
            .from('judicial_decisions')
            .select('case_name, case_number, decision_date')
            .eq('id', cj.decision_id)
            .maybeSingle();
          if (decision) decisionCache.set(cj.decision_id, decision);
        }
        const decision = decisionCache.get(cj.decision_id);

        const valueHigh = inv.value_range_high || inv.value_range_low || 0;
        const roleMultiplier = cj.role === 'author' ? 1.5 : cj.role === 'panel' ? 1.0 : 1.2;
        const baseSeverity = valueHigh > 500000 ? 9 : valueHigh > 100000 ? 7 : valueHigh > 50000 ? 6 : valueHigh > 15000 ? 5 : 4;
        const severity = Math.min(10, Math.round(baseSeverity * roleMultiplier * 10) / 10);

        const judge = (cj as any).judge;

        const { error: insertErr } = await supabase
          .from('conflict_alerts')
          .insert({
            alert_type: 'judicial_financial',
            official_id: judge?.entity_id || null,
            entity_id: inv.entity_id || party.entity_id,
            description: `Judge ${judge?.full_name || 'Unknown'} held ${inv.asset_name || inv.ticker} (up to $${valueHigh.toLocaleString()}) while ${cj.role} on ${decision?.case_name || 'case'}`,
            evidence: {
              judge_name: judge?.full_name,
              judge_role: cj.role,
              case_name: decision?.case_name,
              case_number: decision?.case_number,
              decision_date: decision?.decision_date,
              asset_name: inv.asset_name,
              ticker: inv.ticker,
              value_range_low: inv.value_range_low,
              value_range_high: inv.value_range_high,
              party_name: party.party_name,
              party_role: party.party_role,
              match_type: inv.entity_id === party.entity_id ? 'entity_id' : 'name_similarity',
            },
            severity_score: severity,
            status: 'active',
          });

        if (!insertErr) alertCount++;
      }
    }
  }

  console.log(`[judicial-financial] Created ${alertCount} conflict alerts`);
  return alertCount;
}
