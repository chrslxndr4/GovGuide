export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const GET: APIRoute = async ({ url }) => {
  const officialId = url.searchParams.get('official_id');
  const ticker = url.searchParams.get('ticker');
  const tradeType = url.searchParams.get('trade_type');
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');
  const party = url.searchParams.get('party');
  const lateOnly = url.searchParams.get('late_only') === 'true';
  const flaggedOnly = url.searchParams.get('flagged_only') === 'true';
  const sort = url.searchParams.get('sort') ?? 'date';
  const page = parseInt(url.searchParams.get('page') || '1');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);

  // Determine sort column and direction from the `sort` param.
  // Client-side sort within the page handles secondary sorts; API sort orders the page correctly.
  let orderColumn: string;
  let orderAscending: boolean;

  if (sort === 'severity') {
    orderColumn = 'conflict_severity';
    orderAscending = false;
  } else if (sort === 'amount') {
    orderColumn = 'amount_min';
    orderAscending = false;
  } else {
    // default: date descending
    orderColumn = 'trade_date';
    orderAscending = false;
  }

  let query = supabase
    .from('mv_trade_conflicts')
    .select(
      `id, trade_date, filing_date, official_id, official_name, official_slug, official_party,
       ticker, asset_description, trade_type, amount_min, amount_max, days_late,
       conflict_severity, sector, committee_overlap, committee_names, donor_overlap, regulatory_overlap`,
      { count: 'exact' }
    )
    .order(orderColumn, { ascending: orderAscending })
    .range((page - 1) * limit, page * limit - 1);

  if (officialId) query = query.eq('official_id', officialId);
  if (ticker) query = query.ilike('ticker', ticker);
  if (tradeType) query = query.eq('trade_type', tradeType);
  if (dateFrom) query = query.gte('trade_date', dateFrom);
  if (dateTo) query = query.lte('trade_date', dateTo);
  if (party) query = query.eq('official_party', party);
  if (lateOnly) query = query.gt('days_late', 0);
  if (flaggedOnly) query = query.gt('conflict_severity', 0);

  const { data, count, error } = await query;

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  // Reshape rows so the React component receives the same `official` sub-object shape
  // it already depends on, while also exposing the new conflict fields at the top level.
  const trades = (data ?? []).map((row) => ({
    id: row.id,
    trade_date: row.trade_date,
    filing_date: row.filing_date,
    official_id: row.official_id,
    official: {
      full_name: row.official_name,
      slug: row.official_slug,
      party: row.official_party,
    },
    ticker: row.ticker,
    asset_description: row.asset_description,
    trade_type: row.trade_type,
    amount_min: row.amount_min,
    amount_max: row.amount_max,
    days_late: row.days_late,
    conflict_severity: row.conflict_severity ?? 0,
    sector: row.sector ?? null,
    committee_overlap: row.committee_overlap ?? false,
    committee_names: row.committee_names ?? [],
    donor_overlap: row.donor_overlap ?? false,
    regulatory_overlap: row.regulatory_overlap ?? false,
  }));

  return new Response(
    JSON.stringify({
      trades,
      pagination: { page, limit, total: count, pages: Math.ceil((count || 0) / limit) },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  );
};
