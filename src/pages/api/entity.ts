import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const prerender = false;

// UUID v4 format validator
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Maps entity_type values to their detail table names.
const DETAIL_TABLE_MAP: Record<string, string> = {
  corporation: 'entity_corporations',
  pac: 'entity_pacs',
  '501c4': 'entity_501c4s',
  lobbying_firm: 'entity_lobbying_firms',
  foreign_principal: 'entity_foreign_principals',
};

export const GET: APIRoute = async ({ url }) => {
  // --- Parameter extraction & validation ---

  const id = url.searchParams.get('id');

  if (!id) {
    return new Response(
      JSON.stringify({ error: 'Missing required parameter: id' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!UUID_RE.test(id)) {
    return new Response(
      JSON.stringify({ error: 'Invalid id: must be a valid UUID' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // --- Fetch base entity ---

  const { data: entity, error: entityError } = await supabase
    .from('entities')
    .select('*')
    .eq('id', id)
    .single();

  if (entityError) {
    // PostgREST returns code PGRST116 when .single() finds no rows.
    if (entityError.code === 'PGRST116') {
      return new Response(
        JSON.stringify({ error: 'Entity not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } }
      );
    }

    console.error('[entity] Base entity fetch error:', entityError);
    return new Response(
      JSON.stringify({ error: 'Failed to retrieve entity' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!entity) {
    return new Response(
      JSON.stringify({ error: 'Entity not found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // --- Fetch type-specific detail record (if table mapping exists) ---

  const detailTable = DETAIL_TABLE_MAP[entity.entity_type as string];

  const detailPromise = detailTable
    ? supabase.from(detailTable).select('*').eq('entity_id', id).single()
    : Promise.resolve({ data: null, error: null });

  // --- Fetch top 10 relationships ordered by amount DESC ---
  // Joins entity names for both source and target via foreign key references.
  // The select uses the Supabase PostgREST relationship syntax; adjust the
  // foreign key hint if the schema uses non-standard FK names.

  const relationshipsPromise = supabase
    .from('relationships')
    .select(`
      id,
      relationship_type,
      amount,
      relationship_date,
      source_entity_id,
      target_entity_id,
      source:source_entity_id(id, name, entity_type),
      target:target_entity_id(id, name, entity_type)
    `)
    .or(`source_entity_id.eq.${id},target_entity_id.eq.${id}`)
    .order('amount', { ascending: false, nullsFirst: false })
    .limit(10);

  // Run detail + relationship fetches concurrently
  const [{ data: detail, error: detailError }, { data: relationships, error: relError }] =
    await Promise.all([detailPromise, relationshipsPromise]);

  // Detail fetch failure is non-fatal — surface it in the response rather
  // than returning a 500, so consumers can still render base entity data.
  if (detailError && detailError.code !== 'PGRST116') {
    console.error('[entity] Detail fetch error:', detailError);
  }

  if (relError) {
    console.error('[entity] Relationships fetch error:', relError);
    return new Response(
      JSON.stringify({ error: 'Failed to retrieve entity relationships' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // --- Build and return combined response ---

  return new Response(
    JSON.stringify({
      entity,
      detail: detail ?? null,
      relationships: relationships ?? [],
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
};
