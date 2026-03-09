export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const GET: APIRoute = async ({ url }) => {
  const jurisdictionId = url.searchParams.get('jurisdiction_id');
  const slug = url.searchParams.get('slug');
  const chamber = url.searchParams.get('chamber');
  const party = url.searchParams.get('party');
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);

  // Single official by slug
  if (slug) {
    const { data: official, error } = await supabase
      .from('officials')
      .select('*, office:office_id(*)')
      .eq('slug', slug)
      .maybeSingle();

    if (error || !official) {
      return new Response(JSON.stringify({ error: 'Official not found' }), { status: 404 });
    }

    // Fetch top donors
    const { data: donors } = await supabase
      .from('mv_official_top_donors')
      .select('*')
      .eq('official_id', official.id)
      .order('rank')
      .limit(20);

    // Fetch transparency score
    const { data: score } = await supabase
      .from('transparency_scores')
      .select('*')
      .eq('official_id', official.id)
      .order('score_date', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Fetch recent stock trades
    const { data: trades } = await supabase
      .from('stock_trades')
      .select('*')
      .eq('official_id', official.id)
      .order('trade_date', { ascending: false })
      .limit(10);

    // Fetch conflict alerts
    const { data: conflicts } = await supabase
      .from('conflict_alerts')
      .select('*')
      .eq('official_id', official.id)
      .eq('status', 'active')
      .order('severity_score', { ascending: false })
      .limit(10);

    return new Response(JSON.stringify({
      official, donors, transparency_score: score, recent_trades: trades, conflicts,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // List officials
  let query = supabase
    .from('officials')
    .select('*, office:office_id(title, branch, chamber, jurisdiction_id)', { count: 'exact' })
    .eq('is_current', true)
    .order('last_name')
    .range((page - 1) * limit, page * limit - 1);

  if (jurisdictionId) query = query.eq('office.jurisdiction_id', jurisdictionId);
  if (chamber) query = query.eq('office.chamber', chamber);
  if (party) query = query.eq('party', party);

  const { data, count, error } = await query;

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  return new Response(JSON.stringify({
    officials: data,
    pagination: { page, limit, total: count, pages: Math.ceil((count || 0) / limit) },
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
