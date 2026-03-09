import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const zip = url.searchParams.get('zip');

  if (!zip || !/^\d{5}$/.test(zip)) {
    return new Response(JSON.stringify({ error: 'Invalid ZIP code' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Query zip_jurisdictions with joined jurisdiction data
  const { data, error } = await supabase
    .from('zip_jurisdictions')
    .select(`
      zip_code,
      congressional_district,
      state:state_id(id, name, slug),
      county:county_id(id, name, slug),
      city:city_id(id, name, slug)
    `)
    .eq('zip_code', zip);

  if (error) {
    return new Response(JSON.stringify({ error: 'Lookup failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Get election services for the state derived from the first jurisdiction match
  const stateId = (data?.[0]?.state as { id?: string } | null)?.id;
  let electionServices = null;

  if (stateId) {
    const { data: services } = await supabase
      .from('election_services')
      .select('*')
      .eq('jurisdiction_id', stateId)
      .single();
    electionServices = services;
  }

  return new Response(
    JSON.stringify({
      zip_code: zip,
      jurisdictions: data,
      election_services: electionServices,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
};
