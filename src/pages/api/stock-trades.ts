export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const GET: APIRoute = async ({ url }) => {
  const officialId = url.searchParams.get('official_id');
  const ticker = url.searchParams.get('ticker');
  const tradeType = url.searchParams.get('trade_type');
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');
  const lateOnly = url.searchParams.get('late_only') === 'true';
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);

  let query = supabase
    .from('stock_trades')
    .select('*, official:official_id(full_name, slug, party)', { count: 'exact' })
    .order('trade_date', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (officialId) query = query.eq('official_id', officialId);
  if (ticker) query = query.ilike('ticker', ticker);
  if (tradeType) query = query.eq('trade_type', tradeType);
  if (dateFrom) query = query.gte('trade_date', dateFrom);
  if (dateTo) query = query.lte('trade_date', dateTo);
  if (lateOnly) query = query.gt('days_late', 0);

  const { data, count, error } = await query;

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  return new Response(JSON.stringify({
    trades: data,
    pagination: { page, limit, total: count, pages: Math.ceil((count || 0) / limit) },
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
