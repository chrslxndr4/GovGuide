import { useEffect, useRef, useState } from 'react';
import type { Core, ElementDefinition } from 'cytoscape';

interface MoneyGraphProps {
  entityId: string;
  hops?: number;
  minAmount?: number;
  relationshipTypes?: string[];
  onNodeClick?: (entityId: string, entityName: string) => void;
  height?: string;
}

const ENTITY_COLORS: Record<string, string> = {
  person: '#1a365d',
  corporation: '#742a2a',
  pac: '#2c5282',
  super_pac: '#e53e3e',
  hybrid_pac: '#d69e2e',
  '501c4': '#9b2c2c',
  lobbying_firm: '#553c9a',
  labor_union: '#276749',
  political_party: '#2b6cb0',
};

export default function MoneyGraph({
  entityId,
  hops = 2,
  minAmount,
  relationshipTypes,
  onNodeClick,
  height = '600px',
}: MoneyGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nodeCount, setNodeCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function loadGraph() {
      setLoading(true);
      setError(null);

      try {
        // Build API URL
        const params = new URLSearchParams({ entity_id: entityId, hops: String(hops) });
        if (minAmount) params.set('min_amount', String(minAmount));
        if (relationshipTypes) {
          relationshipTypes.forEach(t => params.append('relationship_types', t));
        }

        const res = await fetch(`/api/money-graph?${params}`);
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const data = await res.json();

        if (cancelled) return;

        // Dynamically import cytoscape
        const cytoscape = (await import('cytoscape')).default;

        if (!containerRef.current) return;

        // Destroy previous instance
        if (cyRef.current) cyRef.current.destroy();

        const elements: ElementDefinition[] = [
          ...data.elements.nodes.map((n: any) => ({
            data: {
              ...n.data,
              color: ENTITY_COLORS[n.data.type] || '#718096',
              size: n.data.id === entityId ? 60 : Math.max(20, 40 - n.data.hop * 10),
            },
          })),
          ...data.elements.edges.map((e: any) => ({
            data: {
              ...e.data,
              width: e.data.amount ? Math.min(10, Math.max(1, Math.log10(e.data.amount) - 2)) : 1,
              label: e.data.amount ? `$${formatAmount(e.data.amount)}` : e.data.type,
            },
          })),
        ];

        const cy = cytoscape({
          container: containerRef.current,
          elements,
          style: [
            {
              selector: 'node',
              style: {
                'background-color': 'data(color)',
                label: 'data(label)',
                width: 'data(size)',
                height: 'data(size)',
                'font-size': '10px',
                'text-wrap': 'ellipsis',
                'text-max-width': '80px',
                'text-valign': 'bottom',
                'text-margin-y': 5,
                color: '#1a202c',
              },
            },
            {
              selector: 'edge',
              style: {
                width: 'data(width)',
                'line-color': '#a0aec0',
                'target-arrow-color': '#a0aec0',
                'target-arrow-shape': 'triangle',
                'curve-style': 'bezier',
                label: 'data(label)',
                'font-size': '8px',
                'text-rotation': 'autorotate',
                color: '#718096',
              },
            },
            {
              selector: 'node:selected',
              style: {
                'border-width': 3,
                'border-color': '#3182ce',
              },
            },
          ],
          layout: {
            name: 'cose',
            animate: true,
            animationDuration: 500,
            nodeRepulsion: () => 8000,
            idealEdgeLength: () => 100,
            gravity: 0.25,
          } as any,
        });

        cy.on('tap', 'node', (evt) => {
          const node = evt.target;
          if (onNodeClick) {
            onNodeClick(node.data('id'), node.data('label'));
          }
        });

        cyRef.current = cy;
        setNodeCount(data.meta.nodeCount);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load graph');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadGraph();
    return () => { cancelled = true; };
  }, [entityId, hops, minAmount, relationshipTypes]);

  return (
    <div className="relative" style={{ height }}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
          <div className="text-slate-600">Loading graph...</div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
          <div className="text-red-600">{error}</div>
        </div>
      )}
      <div ref={containerRef} className="w-full h-full bg-slate-50 rounded-lg border border-slate-200" />
      {!loading && (
        <div className="absolute bottom-2 left-2 text-xs text-slate-500">
          {nodeCount} entities
        </div>
      )}
    </div>
  );
}

function formatAmount(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(0)}K`;
  return amount.toFixed(0);
}
