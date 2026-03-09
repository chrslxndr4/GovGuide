export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const GET: APIRoute = async ({ url }) => {
  const jurisdictionId = url.searchParams.get('jurisdiction_id');
  const upcoming = url.searchParams.get('upcoming') === 'true';
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '25'), 100);

  let query = supabase
    .from('elections')
    .select(`
      *,
      jurisdiction:jurisdiction_id(id, name, slug),
      candidates(*, official:official_id(full_name, slug)),
      ballot_measures(*)
    `, { count: 'exact' })
    .order('election_date', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (jurisdictionId) query = query.eq('jurisdiction_id', jurisdictionId);
  if (upcoming) query = query.gte('election_date', new Date().toISOString().split('T')[0]);

  const { data: elections, count, error } = await query;

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  // Fetch prediction market contracts for political races
  const { data: predictions } = await supabase
    .from('prediction_contracts')
    .select('*')
    .eq('category', 'Politics')
    .eq('resolved', false)
    .order('volume', { ascending: false })
    .limit(20);

  // Fetch recent polls
  const { data: polls } = await supabase
    .from('polls')
    .select('*')
    .order('poll_date', { ascending: false })
    .limit(20);

  // Fetch election services for jurisdictions
  const jurisdictionIds = (elections || []).map(e => e.jurisdiction_id);
  const { data: services } = await supabase
    .from('election_services')
    .select('*')
    .in('jurisdiction_id', jurisdictionIds);

  return new Response(JSON.stringify({
    elections,
    predictions,
    recent_polls: polls,
    election_services: services,
    pagination: { page, limit, total: count, pages: Math.ceil((count || 0) / limit) },
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
