export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const GET: APIRoute = async ({ url }) => {
  const q = url.searchParams.get('q')?.trim();
  if (!q || q.length < 2) {
    return new Response(JSON.stringify({ error: 'Query must be at least 2 characters' }), { status: 400 });
  }

  const type = url.searchParams.get('type'); // entity, official, bill, judge
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
  const pattern = `%${q}%`;

  const results: Record<string, any[]> = {};

  // Search entities (uses pg_trgm GIN index)
  if (!type || type === 'entity') {
    const { data: entities } = await supabase
      .from('entities')
      .select('id, name, entity_type, description')
      .ilike('name', pattern)
      .limit(limit);
    results.entities = entities || [];
  }

  // Search officials
  if (!type || type === 'official') {
    const { data: officials } = await supabase
      .from('officials')
      .select('id, full_name, slug, party, office:office_id(title, chamber)')
      .or(`full_name.ilike.${pattern},last_name.ilike.${pattern}`)
      .eq('is_current', true)
      .limit(limit);
    results.officials = officials || [];
  }

  // Search bills
  if (!type || type === 'bill') {
    const { data: bills } = await supabase
      .from('bills')
      .select('id, bill_id, title, status, introduced_date')
      .or(`title.ilike.${pattern},bill_id.ilike.${pattern}`)
      .order('introduced_date', { ascending: false })
      .limit(limit);
    results.bills = bills || [];
  }

  // Search judges
  if (!type || type === 'judge') {
    const { data: judges } = await supabase
      .from('judges')
      .select('id, full_name, slug, court:court_id(name, court_type)')
      .ilike('full_name', pattern)
      .limit(limit);
    results.judges = judges || [];
  }

  const totalResults = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);

  return new Response(JSON.stringify({
    query: q,
    total: totalResults,
    results,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
