import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const prerender = false;

const RESULTS_PER_TYPE = 10;

export const GET: APIRoute = async ({ url }) => {
  const q = url.searchParams.get('q');

  // Require at least 2 characters to prevent overly broad queries
  if (!q || q.trim().length < 2) {
    return new Response(
      JSON.stringify({ error: 'Query parameter "q" must be at least 2 characters' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  const term = q.trim();
  // Build the ilike pattern once — Supabase parameterizes the value, so
  // special characters in `term` will not escape the SQL pattern.
  const pattern = `%${term}%`;

  // Run all three searches concurrently for lower latency
  const [jurisdictionsResult, officialsResult, agenciesResult] = await Promise.all([
    // Jurisdictions — match on name
    supabase
      .from('jurisdictions')
      .select('id, name, slug, jurisdiction_type')
      .ilike('name', pattern)
      .limit(RESULTS_PER_TYPE),

    // Officials — match on full_name
    supabase
      .from('officials')
      .select(`
        id,
        full_name,
        party,
        photo_url,
        office:office_id(id, title, branch, chamber),
        jurisdiction:jurisdiction_id(id, name, slug)
      `)
      .ilike('full_name', pattern)
      .limit(RESULTS_PER_TYPE),

    // Agencies — match on name OR abbreviation
    supabase
      .from('agencies')
      .select('id, name, abbreviation, slug, jurisdiction_id')
      .or(`name.ilike.${pattern},abbreviation.ilike.${pattern}`)
      .limit(RESULTS_PER_TYPE),
  ]);

  // Surface a 500 only if every sub-query failed; partial failures still
  // return whatever data is available so the UI degrades gracefully.
  const allFailed =
    jurisdictionsResult.error && officialsResult.error && agenciesResult.error;

  if (allFailed) {
    return new Response(
      JSON.stringify({ error: 'Search failed' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  return new Response(
    JSON.stringify({
      query: term,
      jurisdictions: jurisdictionsResult.data ?? [],
      officials: officialsResult.data ?? [],
      agencies: agenciesResult.data ?? [],
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
};
