import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const prerender = false;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export const GET: APIRoute = async ({ url }) => {
  const alertType = url.searchParams.get('alert_type');
  const severityMin = url.searchParams.get('severity_min');
  const entityId = url.searchParams.get('entity_id');
  const status = url.searchParams.get('status');
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');

  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const rawLimit = parseInt(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10);
  const limit = isNaN(rawLimit) ? DEFAULT_LIMIT : Math.min(Math.max(1, rawLimit), MAX_LIMIT);
  const offset = (page - 1) * limit;

  let query = supabase
    .from('conflict_alerts')
    .select('*', { count: 'exact' })
    .order('severity_score', { ascending: false })
    .order('detected_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (alertType) query = query.eq('alert_type', alertType);
  if (severityMin) query = query.gte('severity_score', parseFloat(severityMin));
  if (status) query = query.eq('status', status);
  if (dateFrom) query = query.gte('detected_at', dateFrom);
  if (dateTo) query = query.lte('detected_at', dateTo);
  if (entityId) query = query.contains('entity_ids', [entityId]);

  const { data: alerts, error, count } = await query;

  if (error) {
    console.error('[conflicts] Query error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to retrieve conflict alerts' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Resolve entity names for all alerts
  const allEntityIds = [...new Set((alerts ?? []).flatMap((a) => a.entity_ids ?? []))];
  let entityMap: Record<string, { name: string; type: string }> = {};

  if (allEntityIds.length > 0) {
    const { data: entities } = await supabase
      .from('entities')
      .select('id, name, entity_type')
      .in('id', allEntityIds);

    if (entities) {
      entityMap = Object.fromEntries(
        entities.map((e) => [e.id, { name: e.name, type: e.entity_type }])
      );
    }
  }

  const enriched = (alerts ?? []).map((alert) => ({
    ...alert,
    entities: (alert.entity_ids ?? [])
      .map((id: string) => entityMap[id] ? { id, ...entityMap[id] } : { id, name: id, type: 'unknown' }),
  }));

  return new Response(
    JSON.stringify({ data: enriched, total: count ?? 0, page }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};
