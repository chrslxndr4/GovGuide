export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const GET: APIRoute = async ({ url }) => {
  const zip = url.searchParams.get('zip');
  if (!zip || !/^\d{5}$/.test(zip)) {
    return new Response(JSON.stringify({ error: 'Valid 5-digit ZIP required' }), { status: 400 });
  }

  const { data: jurisdictions } = await supabase
    .from('zip_jurisdictions')
    .select(`
      *,
      state:state_id(id, name, slug),
      county:county_id(id, name, slug),
      city:city_id(id, name, slug)
    `)
    .eq('zip_code', zip);

  const jurisdictionIds = [
    ...new Set(
      (jurisdictions || []).flatMap(j => [j.state_id, j.county_id, j.city_id].filter(Boolean))
    ),
  ];

  const { data: officials } = await supabase
    .from('officials')
    .select('*, office:office_id(title, branch, chamber, jurisdiction_id)')
    .in('office.jurisdiction_id', jurisdictionIds)
    .eq('is_current', true);

  return new Response(JSON.stringify({ jurisdictions, officials }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
