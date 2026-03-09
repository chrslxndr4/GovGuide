import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const prerender = false;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const GET: APIRoute = async ({ url }) => {
  const officialId = url.searchParams.get('official_id');
  const ticker = url.searchParams.get('ticker');
  const party = url.searchParams.get('party');
  const chamber = url.searchParams.get('chamber');
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');
  const suspiciousOnly = url.searchParams.get('suspicious_only') === 'true';

  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const rawLimit = parseInt(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT), 10);
  const limit = isNaN(rawLimit) ? DEFAULT_LIMIT : Math.min(Math.max(1, rawLimit), MAX_LIMIT);
  const offset = (page - 1) * limit;

  let query = supabase
    .from('stock_trades')
    .select(
      `
      id,
      ticker,
      asset_name,
      trade_type,
      amount_range_low,
      amount_range_high,
      trade_date,
      disclosure_date,
      days_late,
      filing_url,
      official:official_id(
        id,
        full_name,
        party,
        state,
        chamber
      )
    `,
      { count: 'exact' }
    )
    .order('trade_date', { ascending: false })
    .range(offset, offset + limit - 1);

  if (officialId) query = query.eq('official_id', officialId);
  if (ticker) query = query.ilike('ticker', ticker);
  if (dateFrom) query = query.gte('trade_date', dateFrom);
  if (dateTo) query = query.lte('trade_date', dateTo);
  if (suspiciousOnly) query = query.gt('days_late', 0);
  if (party) query = query.eq('official.party', party);
  if (chamber) query = query.eq('official.chamber', chamber);

  const { data, error, count } = await query;

  if (error) {
    console.error('[stock-trades] Query error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to retrieve stock trades' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify({ data: data ?? [], total: count ?? 0, page }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};
