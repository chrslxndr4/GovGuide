export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const GET: APIRoute = async ({ url }) => {
  const entityId = url.searchParams.get('entity_id');
  if (!entityId) {
    return new Response(JSON.stringify({ error: 'entity_id required' }), { status: 400 });
  }

  const hops = Math.min(parseInt(url.searchParams.get('hops') || '2'), 5);
  const minAmount = url.searchParams.get('min_amount')
    ? parseFloat(url.searchParams.get('min_amount')!)
    : null;
  const relTypes = url.searchParams.getAll('relationship_types');

  // Get neighborhood nodes
  const { data: nodes, error: nodesErr } = await supabase.rpc('get_entity_neighborhood', {
    p_entity_id: entityId,
    p_max_hops: hops,
    p_relationship_types: relTypes.length ? relTypes : null,
    p_min_amount: minAmount,
  });

  if (nodesErr) {
    return new Response(JSON.stringify({ error: nodesErr.message }), { status: 500 });
  }

  // Get edges between these nodes
  const nodeIds = (nodes || []).map((n: any) => n.entity_id);

  const { data: edges, error: edgesErr } = await supabase.rpc('get_edges_between', {
    p_entity_ids: nodeIds,
  });

  if (edgesErr) {
    return new Response(JSON.stringify({ error: edgesErr.message }), { status: 500 });
  }

  // Format for Cytoscape.js
  const cytoscapeNodes = (nodes || []).map((n: any) => ({
    data: {
      id: n.entity_id,
      label: n.entity_name,
      type: n.entity_type,
      hop: n.hop_distance,
    },
  }));

  const cytoscapeEdges = (edges || []).map((e: any) => ({
    data: {
      id: e.relationship_id,
      source: e.source_id,
      target: e.target_id,
      type: e.rel_type,
      amount: e.amount,
      cycle: e.cycle,
    },
  }));

  return new Response(JSON.stringify({
    elements: { nodes: cytoscapeNodes, edges: cytoscapeEdges },
    meta: { center: entityId, hops, nodeCount: cytoscapeNodes.length, edgeCount: cytoscapeEdges.length },
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
