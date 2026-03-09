import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const prerender = false;

// UUID v4 format validator
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Shape returned by the get_entity_network RPC function.
// Columns are snake_case as defined in the DB function.
interface NetworkRow {
  entity_id: string;
  entity_name: string;
  entity_type: string;
  entity_metadata: Record<string, string | number | boolean | null> | null;
  relationship_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: string;
  amount: number | null;
  relationship_date: string | null;
  depth: number;
}

interface GraphNode {
  id: string;
  name: string;
  type: string;
  metadata: Record<string, string | number | boolean | null>;
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  amount: number | null;
  date: string | null;
}

interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const GET: APIRoute = async ({ url }) => {
  // --- Parameter extraction & validation ---

  const entityId = url.searchParams.get('entity_id');

  if (!entityId) {
    return new Response(
      JSON.stringify({ error: 'Missing required parameter: entity_id' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!UUID_RE.test(entityId)) {
    return new Response(
      JSON.stringify({ error: 'Invalid entity_id: must be a valid UUID' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const rawDepth = url.searchParams.get('depth');
  let depth = 2;
  if (rawDepth !== null) {
    const parsed = parseInt(rawDepth, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 5) {
      return new Response(
        JSON.stringify({ error: 'Invalid depth: must be an integer between 1 and 5' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    depth = parsed;
  }

  const rawMinAmount = url.searchParams.get('min_amount');
  let minAmount = 0;
  if (rawMinAmount !== null) {
    const parsed = parseFloat(rawMinAmount);
    if (isNaN(parsed) || parsed < 0) {
      return new Response(
        JSON.stringify({ error: 'Invalid min_amount: must be a non-negative number' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
    minAmount = parsed;
  }

  const rawTypes = url.searchParams.get('types');
  const typeFilter: string[] | null = rawTypes
    ? rawTypes.split(',').map((t) => t.trim()).filter(Boolean)
    : null;

  // --- Supabase RPC call ---

  const { data, error } = await supabase.rpc('get_entity_network', {
    center_id: entityId,
    max_depth: depth,
    min_amount: minAmount,
  });

  if (error) {
    console.error('[money-graph] RPC error:', error);
    return new Response(
      JSON.stringify({ error: 'Failed to retrieve entity network' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const rows: NetworkRow[] = (data as NetworkRow[]) ?? [];

  // --- Optional type filter ---

  const filteredRows = typeFilter
    ? rows.filter((row) => typeFilter.includes(row.relationship_type))
    : rows;

  // --- Transform to Cytoscape-compatible graph ---

  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();

  for (const row of filteredRows) {
    // De-duplicate nodes — first occurrence wins; deeper traversals may
    // revisit the same entity with identical data.
    if (!nodeMap.has(row.entity_id)) {
      nodeMap.set(row.entity_id, {
        id: row.entity_id,
        name: row.entity_name,
        type: row.entity_type,
        metadata: row.entity_metadata ?? {},
      });
    }

    // De-duplicate edges by relationship_id
    if (row.relationship_id && !edgeMap.has(row.relationship_id)) {
      edgeMap.set(row.relationship_id, {
        id: row.relationship_id,
        source: row.source_entity_id,
        target: row.target_entity_id,
        type: row.relationship_type,
        amount: row.amount ?? null,
        date: row.relationship_date ?? null,
      });
    }
  }

  const graph: GraphResponse = {
    nodes: Array.from(nodeMap.values()),
    edges: Array.from(edgeMap.values()),
  };

  return new Response(JSON.stringify(graph), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
