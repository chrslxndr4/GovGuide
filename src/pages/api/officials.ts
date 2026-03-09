import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const prerender = false;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const GET: APIRoute = async ({ url }) => {
  // --- Optional filter params ---
  const jurisdictionId = url.searchParams.get('jurisdiction_id');
  const branch = url.searchParams.get('branch');
  const chamber = url.searchParams.get('chamber');
  const party = url.searchParams.get('party');
  const state = url.searchParams.get('state');

  // --- Pagination params ---
  const pageParam = url.searchParams.get('page');
  const limitParam = url.searchParams.get('limit');

  const page = Math.max(1, parseInt(pageParam ?? '1', 10) || 1);
  const rawLimit = parseInt(limitParam ?? String(DEFAULT_LIMIT), 10);
  const limit = isNaN(rawLimit)
    ? DEFAULT_LIMIT
    : Math.min(Math.max(1, rawLimit), MAX_LIMIT);
  const offset = (page - 1) * limit;

  // Build base query with joins
  let query = supabase
    .from('officials')
    .select(
      `
      id,
      full_name,
      party,
      photo_url,
      bio_url,
      contact_url,
      office:office_id(
        id,
        title,
        branch,
        chamber
      ),
      jurisdiction:jurisdiction_id(
        id,
        name,
        slug,
        jurisdiction_type
      )
    `,
      { count: 'exact' }
    )
    .order('full_name', { ascending: true })
    .range(offset, offset + limit - 1);

  // Apply optional filters — all are passed directly to Supabase as
  // parameterized values, so there is no risk of SQL injection.
  if (jurisdictionId) {
    query = query.eq('jurisdiction_id', jurisdictionId);
  }

  if (party) {
    query = query.eq('party', party);
  }

  // branch and chamber live on the offices relation; filter via the FK column
  // on officials if a denormalised column exists, otherwise filter post-join.
  // The safest approach without knowing the exact schema is to filter on the
  // joined relation using the embedded resource syntax.
  if (branch) {
    query = query.eq('office.branch', branch);
  }

  if (chamber) {
    query = query.eq('office.chamber', chamber);
  }

  // state can be a slug or an id stored on the jurisdiction relation
  if (state) {
    query = query.eq('jurisdiction.slug', state);
  }

  const { data, error, count } = await query;

  if (error) {
    return new Response(
      JSON.stringify({ error: 'Failed to retrieve officials' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  return new Response(
    JSON.stringify({
      officials: data ?? [],
      total: count ?? 0,
      page,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
};
