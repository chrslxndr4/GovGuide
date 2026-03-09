import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const jurisdictionId = url.searchParams.get('jurisdiction_id');
  const upcomingParam = url.searchParams.get('upcoming');

  // jurisdiction_id is required
  if (!jurisdictionId || jurisdictionId.trim() === '') {
    return new Response(
      JSON.stringify({ error: 'Missing required parameter: jurisdiction_id' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // upcoming must be explicitly "true" or "false" if provided
  const filterUpcoming = upcomingParam === 'true';

  let query = supabase
    .from('elections')
    .select(`
      id,
      name,
      election_date,
      election_type,
      jurisdiction_id,
      candidates(
        id,
        full_name,
        party,
        incumbent,
        office:office_id(
          id,
          title,
          branch,
          chamber
        )
      ),
      office:office_id(
        id,
        title,
        branch,
        chamber
      )
    `)
    .eq('jurisdiction_id', jurisdictionId)
    .order('election_date', { ascending: true });

  if (filterUpcoming) {
    // Use today's date in ISO format (YYYY-MM-DD) for date comparison
    const today = new Date().toISOString().split('T')[0];
    query = query.gte('election_date', today);
  }

  const { data, error } = await query;

  if (error) {
    return new Response(
      JSON.stringify({ error: 'Failed to retrieve elections' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  return new Response(
    JSON.stringify({ elections: data ?? [] }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
};
