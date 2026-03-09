export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const GET: APIRoute = async ({ url }) => {
  const slug = url.searchParams.get('slug');
  const courtId = url.searchParams.get('court_id');
  const courtType = url.searchParams.get('court_type');
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);

  // Single judge by slug
  if (slug) {
    const { data: judge, error } = await supabase
      .from('judges')
      .select('*, court:court_id(name, court_type, circuit_number)')
      .eq('slug', slug)
      .maybeSingle();

    if (error || !judge) {
      return new Response(JSON.stringify({ error: 'Judge not found' }), { status: 404 });
    }

    // Fetch financial disclosures
    const { data: disclosures } = await supabase
      .from('judge_financial_disclosures')
      .select('*, investments:judge_investments(*)')
      .eq('judge_id', judge.id)
      .order('disclosure_year', { ascending: false });

    // Fetch recent decisions
    const { data: decisions } = await supabase
      .from('case_judges')
      .select('role, decision:decision_id(case_name, case_number, decision_date, disposition, opinion_type)')
      .eq('judge_id', judge.id)
      .order('decision.decision_date', { ascending: false })
      .limit(20);

    // Fetch conflict alerts
    const { data: conflicts } = await supabase
      .from('conflict_alerts')
      .select('*')
      .eq('alert_type', 'judicial_financial')
      .eq('status', 'active')
      .contains('evidence', { judge_name: judge.full_name });

    return new Response(JSON.stringify({
      judge, disclosures, recent_decisions: decisions, conflicts,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // List judges
  let query = supabase
    .from('judges')
    .select('*, court:court_id(name, court_type)', { count: 'exact' })
    .order('last_name')
    .range((page - 1) * limit, page * limit - 1);

  if (courtId) query = query.eq('court_id', courtId);
  if (courtType) query = query.eq('court.court_type', courtType);

  const { data, count, error } = await query;

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  return new Response(JSON.stringify({
    judges: data,
    pagination: { page, limit, total: count, pages: Math.ceil((count || 0) / limit) },
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
