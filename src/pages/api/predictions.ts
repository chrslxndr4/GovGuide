import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const prerender = false;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const GET: APIRoute = async ({ url }) => {
  const action = url.searchParams.get('action') ?? 'contracts';
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const rawLimit = parseInt(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10);
  const limit = isNaN(rawLimit) ? DEFAULT_LIMIT : Math.min(Math.max(1, rawLimit), MAX_LIMIT);
  const offset = (page - 1) * limit;

  if (action === 'polls') {
    const raceType = url.searchParams.get('race_type');
    const geography = url.searchParams.get('geography');
    const dateFrom = url.searchParams.get('date_from');
    const dateTo = url.searchParams.get('date_to');

    let query = supabase
      .from('polls')
      .select('*', { count: 'exact' })
      .order('date_conducted', { ascending: false })
      .range(offset, offset + limit - 1);

    if (raceType) query = query.eq('race_type', raceType);
    if (geography) query = query.eq('geography', geography);
    if (dateFrom) query = query.gte('date_conducted', dateFrom);
    if (dateTo) query = query.lte('date_conducted', dateTo);

    const { data, error, count } = await query;
    if (error) {
      return new Response(JSON.stringify({ error: 'Query failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: data ?? [], total: count ?? 0, page }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (action === 'contracts') {
    const platform = url.searchParams.get('platform');
    const category = url.searchParams.get('category');
    const activeOnly = url.searchParams.get('active_only') === 'true';

    // Select contract columns plus the highest-severity active anomaly per contract
    // via a left join expressed as an embedded select on the related table.
    let query = supabase
      .from('prediction_contracts')
      .select(
        `*,
        prediction_anomalies!left(
          anomaly_type,
          severity_score,
          description,
          status
        )`,
        { count: 'exact' }
      )
      .eq('prediction_anomalies.status', 'active')
      .order('volume_total', { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1);

    if (platform) query = query.eq('platform', platform);
    if (category) query = query.eq('category', category);
    if (activeOnly) query = query.eq('resolved', false);

    const { data, error, count } = await query;
    if (error) {
      return new Response(JSON.stringify({ error: 'Query failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }

    // Flatten: keep only the single highest-severity anomaly per contract
    interface RawAnomaly {
      anomaly_type: string;
      severity_score: number;
      description: string;
      status: string;
    }

    interface RawContract {
      prediction_anomalies: RawAnomaly[] | RawAnomaly | null;
      [key: string]: unknown;
    }

    interface FlatContract {
      anomaly_type: string | null;
      anomaly_severity: number | null;
      anomaly_description: string | null;
      [key: string]: unknown;
    }

    const flattened: FlatContract[] = (data ?? []).map((row: RawContract) => {
      const { prediction_anomalies, ...rest } = row;
      const anomalies: RawAnomaly[] = Array.isArray(prediction_anomalies)
        ? prediction_anomalies
        : prediction_anomalies
          ? [prediction_anomalies]
          : [];

      const top = anomalies.reduce<RawAnomaly | null>((best, a) => {
        if (!best || a.severity_score > best.severity_score) return a;
        return best;
      }, null);

      return {
        ...rest,
        anomaly_type: top?.anomaly_type ?? null,
        anomaly_severity: top?.severity_score ?? null,
        anomaly_description: top?.description ?? null,
      };
    });

    return new Response(JSON.stringify({ data: flattened, total: count ?? 0, page }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (action === 'anomalies') {
    const contractId = url.searchParams.get('contract_id');
    const anomalyType = url.searchParams.get('anomaly_type');
    const severityMin = url.searchParams.get('severity_min');

    let query = supabase
      .from('prediction_anomalies')
      .select('*', { count: 'exact' })
      .order('severity_score', { ascending: false })
      .range(offset, offset + limit - 1);

    if (contractId) query = query.eq('contract_id', contractId);
    if (anomalyType) query = query.eq('anomaly_type', anomalyType);
    if (severityMin) query = query.gte('severity_score', parseFloat(severityMin));

    const { data, error, count } = await query;
    if (error) {
      return new Response(JSON.stringify({ error: 'Query failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: data ?? [], total: count ?? 0, page }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (action === 'pollster_ratings') {
    const { data, error } = await supabase
      .from('pollster_ratings')
      .select('*')
      .order('accuracy_score', { ascending: false })
      .limit(50);

    if (error) {
      return new Response(JSON.stringify({ error: 'Query failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: data ?? [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
};
