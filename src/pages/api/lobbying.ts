export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const GET: APIRoute = async ({ url }) => {
  const firmId = url.searchParams.get('firm_id');
  const clientId = url.searchParams.get('client_id');
  const year = url.searchParams.get('year');
  const quarter = url.searchParams.get('quarter');
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);

  let query = supabase
    .from('lobbying_registrations')
    .select(`
      *,
      firm:firm_entity_id(id, name),
      client:client_entity_id(id, name),
      activities:lobbying_activities(*)
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (firmId) query = query.eq('firm_entity_id', firmId);
  if (clientId) query = query.eq('client_entity_id', clientId);

  const { data, count, error } = await query;

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  // Filter activities by year/quarter in-memory if specified
  let filtered = data || [];
  if (year || quarter) {
    filtered = filtered.map(reg => ({
      ...reg,
      activities: (reg.activities || []).filter((a: any) =>
        (!year || a.report_year === parseInt(year)) &&
        (!quarter || a.report_quarter === parseInt(quarter))
      ),
    }));
  }

  return new Response(JSON.stringify({
    registrations: filtered,
    pagination: { page, limit, total: count, pages: Math.ceil((count || 0) / limit) },
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
