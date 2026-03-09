import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const prerender = false;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const GET: APIRoute = async ({ url }) => {
  // --- Optional filter params ---
  const billId = url.searchParams.get('bill_id');
  const officialId = url.searchParams.get('official_id');
  const industry = url.searchParams.get('industry');
  const firmId = url.searchParams.get('firm_id');
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');

  // --- Pagination params ---
  const pageParam = url.searchParams.get('page');
  const limitParam = url.searchParams.get('limit');

  const page = Math.max(1, parseInt(pageParam ?? '1', 10) || 1);
  const rawLimit = parseInt(limitParam ?? String(DEFAULT_LIMIT), 10);
  const limit = isNaN(rawLimit)
    ? DEFAULT_LIMIT
    : Math.min(Math.max(1, rawLimit), MAX_LIMIT);
  const offset = (page - 1) * limit;

  // Build base query: lobbying_registrations joined with lobbying_activities,
  // firm entity, and client entity for display names.
  let query = supabase
    .from('lobbying_registrations')
    .select(
      `
      id,
      filing_period,
      filing_date,
      amount,
      status,
      bills_lobbied,
      agencies_contacted,
      issues,
      firm:firm_entity_id(
        id,
        name
      ),
      client:client_entity_id(
        id,
        name,
        entity_corporations(sector)
      ),
      lobbying_activities(
        id,
        description,
        specific_issues,
        official_id
      )
    `,
      { count: 'exact' }
    )
    .order('filing_date', { ascending: false })
    .range(offset, offset + limit - 1);

  // --- Apply filters ---

  // Filter by specific firm entity
  if (firmId) {
    query = query.eq('firm_entity_id', firmId);
  }

  // Filter by date range on filing_date
  if (dateFrom) {
    query = query.gte('filing_date', dateFrom);
  }
  if (dateTo) {
    query = query.lte('filing_date', dateTo);
  }

  // Filter by bill: bills_lobbied is an array column — use the @> (contains)
  // PostgREST operator via .contains()
  if (billId) {
    query = query.contains('bills_lobbied', [billId]);
  }

  // Filter by official targeted — any lobbying_activity row linking to this
  // official means the registration is relevant; use the embedded filter syntax.
  if (officialId) {
    query = query.eq('lobbying_activities.official_id', officialId);
  }

  // Filter by industry/sector via the nested entity_corporations relation on
  // the client entity. PostgREST embedded filters target the joined relation.
  if (industry) {
    query = query.eq('client.entity_corporations.sector', industry);
  }

  const { data, error, count } = await query;

  if (error) {
    return new Response(
      JSON.stringify({ error: 'Failed to retrieve lobbying records' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  return new Response(
    JSON.stringify({
      data: data ?? [],
      total: count ?? 0,
      page,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
};
