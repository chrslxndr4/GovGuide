import { createClient } from '@supabase/supabase-js';

export async function detectPredictionAnomalies(): Promise<number> {
  const url = process.env.PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase credentials');
  const supabase = createClient(url, key);

  // Fetch all active contracts with snapshots
  const { data: contracts } = await supabase
    .from('prediction_contracts')
    .select('id, platform, platform_id, question, category')
    .eq('resolved', false);

  if (!contracts?.length) {
    console.log('[prediction-anomaly] No active prediction contracts found');
    return 0;
  }

  let anomalyCount = 0;

  for (const contract of contracts) {
    const { data: snapshots } = await supabase
      .from('prediction_snapshots')
      .select('id, snapshot_time, prices, volume_24h, liquidity')
      .eq('contract_id', contract.id)
      .order('snapshot_time', { ascending: true });

    if (!snapshots || snapshots.length < 3) continue;

    // Volume spike detection: volume > 3x rolling average
    const volumes = snapshots.map(s => s.volume_24h || 0);
    const rollingWindow = 5;

    for (let i = rollingWindow; i < snapshots.length; i++) {
      const windowVolumes = volumes.slice(i - rollingWindow, i);
      const avgVolume = windowVolumes.reduce((a, b) => a + b, 0) / windowVolumes.length;

      if (avgVolume > 0 && volumes[i] > avgVolume * 3) {
        const ratio = volumes[i] / avgVolume;
        const severity = Math.min(10, Math.round((5 + (ratio - 3) * 1.67) * 10) / 10);

        // Check for correlated government actions within ±48 hours
        const snapshotTime = new Date(snapshots[i].snapshot_time);
        const windowStart = new Date(snapshotTime.getTime() - 48 * 3600000).toISOString();
        const windowEnd = new Date(snapshotTime.getTime() + 48 * 3600000).toISOString();

        const correlatedEvents = await findCorrelatedEvents(supabase, windowStart, windowEnd);

        const adjustedSeverity = correlatedEvents.length > 0
          ? Math.min(10, severity + 2)
          : severity;

        const anomalyType = correlatedEvents.length > 0
          ? 'correlated_government_action'
          : 'volume_spike';

        const { error } = await supabase
          .from('prediction_anomalies')
          .insert({
            contract_id: contract.id,
            anomaly_type: anomalyType,
            detected_at: new Date().toISOString(),
            description: `Volume spike of ${ratio.toFixed(1)}x average on "${contract.question}" (${contract.platform})${correlatedEvents.length ? ` — correlated with ${correlatedEvents.length} government action(s)` : ''}`,
            evidence: {
              contract_question: contract.question,
              platform: contract.platform,
              snapshot_time: snapshots[i].snapshot_time,
              volume_24h: volumes[i],
              average_volume: avgVolume,
              volume_ratio: ratio,
              correlated_events: correlatedEvents,
            },
            severity_score: adjustedSeverity,
            wallet_addresses: [],
          });

        if (!error) anomalyCount++;
      }
    }

    // Rapid price move detection: >20% change between consecutive snapshots
    for (let i = 1; i < snapshots.length; i++) {
      const prevPrices = snapshots[i - 1].prices as Record<string, number> | null;
      const currPrices = snapshots[i].prices as Record<string, number> | null;
      if (!prevPrices || !currPrices) continue;

      for (const outcome of Object.keys(currPrices)) {
        const prev = prevPrices[outcome];
        const curr = currPrices[outcome];
        if (prev == null || curr == null || prev === 0) continue;

        const changePct = Math.abs(curr - prev) / prev;
        if (changePct < 0.20) continue;

        const severity = Math.min(10, Math.round((5 + (changePct - 0.20) * 25) * 10) / 10);

        const snapshotTime = new Date(snapshots[i].snapshot_time);
        const windowStart = new Date(snapshotTime.getTime() - 48 * 3600000).toISOString();
        const windowEnd = new Date(snapshotTime.getTime() + 48 * 3600000).toISOString();
        const correlatedEvents = await findCorrelatedEvents(supabase, windowStart, windowEnd);

        const adjustedSeverity = correlatedEvents.length > 0
          ? Math.min(10, severity + 2)
          : severity;

        const anomalyType = correlatedEvents.length > 0
          ? 'correlated_government_action'
          : 'rapid_price_move';

        const { error } = await supabase
          .from('prediction_anomalies')
          .insert({
            contract_id: contract.id,
            anomaly_type: anomalyType,
            detected_at: new Date().toISOString(),
            description: `${(changePct * 100).toFixed(1)}% price move on "${contract.question}" outcome "${outcome}" (${contract.platform})${correlatedEvents.length ? ` — correlated with ${correlatedEvents.length} government action(s)` : ''}`,
            evidence: {
              contract_question: contract.question,
              platform: contract.platform,
              outcome,
              price_before: prev,
              price_after: curr,
              price_change_pct: changePct,
              snapshot_before: snapshots[i - 1].snapshot_time,
              snapshot_after: snapshots[i].snapshot_time,
              correlated_events: correlatedEvents,
            },
            severity_score: adjustedSeverity,
            wallet_addresses: [],
          });

        if (!error) anomalyCount++;
      }
    }
  }

  console.log(`[prediction-anomaly] Created ${anomalyCount} anomaly alerts`);
  return anomalyCount;
}

async function findCorrelatedEvents(
  supabase: ReturnType<typeof createClient>,
  windowStart: string,
  windowEnd: string
): Promise<Array<{ type: string; description: string; date: string }>> {
  const events: Array<{ type: string; description: string; date: string }> = [];

  // Check for roll call votes in window
  const { data: votes } = await supabase
    .from('roll_call_votes')
    .select('vote_id, question, vote_date, result')
    .gte('vote_date', windowStart.split('T')[0])
    .lte('vote_date', windowEnd.split('T')[0])
    .limit(10);

  if (votes) {
    for (const v of votes) {
      events.push({
        type: 'roll_call_vote',
        description: `${v.question} — ${v.result}`,
        date: v.vote_date,
      });
    }
  }

  // Check for new rules/EOs in window
  const { data: laws } = await supabase
    .from('law_sources')
    .select('title, law_type, metadata')
    .gte('created_at', windowStart)
    .lte('created_at', windowEnd)
    .in('law_type', ['executive_order', 'regulation'])
    .limit(10);

  if (laws) {
    for (const l of laws) {
      events.push({
        type: l.law_type,
        description: l.title,
        date: (l.metadata as any)?.publication_date || '',
      });
    }
  }

  return events;
}
