import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const prerender = false;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const GET: APIRoute = async ({ url }) => {
  const action = url.searchParams.get('action') ?? 'search_judges';
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const rawLimit = parseInt(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10);
  const limit = isNaN(rawLimit) ? DEFAULT_LIMIT : Math.min(Math.max(1, rawLimit), MAX_LIMIT);
  const offset = (page - 1) * limit;

  if (action === 'search_judges') {
    const courtId = url.searchParams.get('court_id');
    const president = url.searchParams.get('appointing_president');
    const name = url.searchParams.get('name');

    let query = supabase
      .from('judges')
      .select('*, court:court_id(id, name, court_type)', { count: 'exact' })
      .order('full_name')
      .range(offset, offset + limit - 1);

    if (courtId) query = query.eq('court_id', courtId);
    if (president) query = query.ilike('metadata->>appointing_president', `%${president}%`);
    if (name) query = query.ilike('full_name', `%${name}%`);

    const { data, error, count } = await query;
    if (error) {
      return new Response(JSON.stringify({ error: 'Query failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: data ?? [], total: count ?? 0, page }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (action === 'get_cases') {
    const judgeId = url.searchParams.get('judge_id');
    if (!judgeId) {
      return new Response(JSON.stringify({ error: 'judge_id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const { data, error, count } = await supabase
      .from('case_judges')
      .select('case:case_id(id, title, case_number, decision_date, outcome)', { count: 'exact' })
      .eq('judge_id', judgeId)
      .range(offset, offset + limit - 1);

    if (error) {
      return new Response(JSON.stringify({ error: 'Query failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: data ?? [], total: count ?? 0, page }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (action === 'get_conflicts') {
    const judgeId = url.searchParams.get('judge_id');
    if (!judgeId) {
      return new Response(JSON.stringify({ error: 'judge_id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    const { data, error } = await supabase
      .from('mv_judge_conflict_flags')
      .select('*')
      .eq('judge_id', judgeId);

    if (error) {
      return new Response(JSON.stringify({ error: 'Query failed' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: data ?? [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
};
