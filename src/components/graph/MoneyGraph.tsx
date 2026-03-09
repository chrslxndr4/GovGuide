import { useEffect, useRef, useState, useCallback } from 'react';
import type cytoscape from 'cytoscape';
import GraphSidebar from './GraphSidebar';
import GraphControls from './GraphControls';

// ─── Domain types ────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  name: string;
  type: 'official' | 'pac' | 'corporation' | 'individual';
  metadata: Record<string, string | number | boolean | null>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: 'donation' | 'lobbying' | 'contract';
  amount: number;
  date: string;
}

interface GraphApiResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface MoneyGraphProps {
  initialEntityId?: string;
  initialQuery?: string;
}

// ─── Style constants ─────────────────────────────────────────────────────────

const NODE_COLORS: Record<GraphNode['type'], string> = {
  official: '#1B2A4A',
  pac: '#D97706',
  corporation: '#475569',
  individual: '#2563EB',
};

const EDGE_COLORS: Record<GraphEdge['type'], string> = {
  donation: '#059669',
  lobbying: '#D97706',
  contract: '#DC2626',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatCurrency(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount.toLocaleString()}`;
}

function buildApiUrl(entityId: string | undefined, depth: number, minAmount: number): string {
  const params = new URLSearchParams({ depth: String(depth), min_amount: String(minAmount) });
  if (entityId) params.set('entity_id', entityId);
  return `/api/money-graph?${params.toString()}`;
}

function computeNodeSize(nodeId: string, edges: GraphEdge[]): number {
  const total = edges
    .filter((e) => e.source === nodeId || e.target === nodeId)
    .reduce((sum, e) => sum + e.amount, 0);
  // Clamp between 24 and 72 px radius equivalent
  return Math.min(72, Math.max(24, 24 + Math.log10(total + 1) * 12));
}

function computeEdgeWidth(amount: number, maxAmount: number): number {
  if (maxAmount === 0) return 2;
  return Math.min(10, Math.max(1, (amount / maxAmount) * 10));
}

function buildCytoscapeElements(
  nodes: GraphNode[],
  edges: GraphEdge[],
  activeTypes: string[],
): cytoscape.ElementDefinition[] {
  const maxAmount = edges.reduce((m, e) => Math.max(m, e.amount), 0);

  const nodeElements: cytoscape.ElementDefinition[] = nodes.map((n) => ({
    group: 'nodes' as const,
    data: {
      id: n.id,
      label: n.name,
      type: n.type,
      size: computeNodeSize(n.id, edges),
      color: NODE_COLORS[n.type],
      raw: n,
    },
  }));

  const edgeElements: cytoscape.ElementDefinition[] = edges
    .filter((e) => activeTypes.length === 0 || activeTypes.includes(e.type))
    .map((e) => ({
      group: 'edges' as const,
      data: {
        id: e.id,
        source: e.source,
        target: e.target,
        label: formatCurrency(e.amount),
        type: e.type,
        width: computeEdgeWidth(e.amount, maxAmount),
        color: EDGE_COLORS[e.type],
        raw: e,
      },
    }));

  return [...nodeElements, ...edgeElements];
}

function buildStylesheet(): cytoscape.StylesheetStyle[] {
  return [
    {
      selector: 'node',
      style: {
        'background-color': 'data(color)',
        'label': 'data(label)',
        'width': 'data(size)',
        'height': 'data(size)',
        'color': '#ffffff',
        'font-size': 10,
        'font-family': 'Inter, system-ui, sans-serif',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'ellipsis',
        'text-max-width': '60px',
        'border-width': 2,
        'border-color': '#ffffff',
        'text-outline-width': 1,
        'text-outline-color': 'data(color)',
      } as cytoscape.Css.Node,
    },
    {
      selector: 'node:selected',
      style: {
        'border-width': 3,
        'border-color': '#F8FAFC',
        'border-opacity': 1,
        'overlay-color': '#ffffff',
        'overlay-opacity': 0.15,
        'overlay-padding': 4,
      } as cytoscape.Css.Node,
    },
    {
      selector: 'node:active',
      style: {
        'overlay-opacity': 0.1,
      } as cytoscape.Css.Node,
    },
    {
      selector: 'edge',
      style: {
        'width': 'data(width)',
        'line-color': 'data(color)',
        'target-arrow-color': 'data(color)',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'label': 'data(label)',
        'font-size': 9,
        'font-family': 'Inter, system-ui, sans-serif',
        'color': '#334155',
        'text-background-color': '#ffffff',
        'text-background-opacity': 0.8,
        'text-background-padding': '2px',
        'text-rotation': 'autorotate',
        'opacity': 0.8,
      } as cytoscape.Css.Edge,
    },
    {
      selector: 'edge:selected',
      style: {
        'opacity': 1,
        'overlay-color': '#1B2A4A',
        'overlay-opacity': 0.1,
      } as cytoscape.Css.Edge,
    },
  ];
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MoneyGraph({ initialEntityId, initialQuery }: MoneyGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);

  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  const [depth, setDepth] = useState<number>(2);
  const [minAmount, setMinAmount] = useState<number>(0);
  const [activeTypes, setActiveTypes] = useState<string[]>(['donation', 'lobbying', 'contract']);
  const [layout, setLayout] = useState<string>('cose');

  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [graphData, setGraphData] = useState<GraphApiResponse | null>(null);

  // ── Fetch data ──────────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const url = buildApiUrl(initialEntityId, depth, minAmount);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText}`);
      const data: GraphApiResponse = await res.json() as GraphApiResponse;
      setGraphData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load graph data');
    } finally {
      setIsLoading(false);
    }
  }, [initialEntityId, depth, minAmount]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // ── Initialize / update Cytoscape ───────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || !graphData) return;

    let cy: cytoscape.Core;

    // Lazily import Cytoscape so the heavy bundle is only loaded client-side
    void (async () => {
      const Cytoscape = (await import('cytoscape')).default;

      const elements = buildCytoscapeElements(graphData.nodes, graphData.edges, activeTypes);

      if (cyRef.current) {
        // Reuse existing instance: update elements and re-run layout
        cyRef.current.elements().remove();
        cyRef.current.add(elements);
        cyRef.current
          .layout({ name: layout, animate: true, animationDuration: 500 } as cytoscape.LayoutOptions)
          .run();
        return;
      }

      cy = Cytoscape({
        container: containerRef.current,
        elements,
        style: buildStylesheet(),
        layout: { name: layout } as cytoscape.LayoutOptions,
        minZoom: 0.2,
        maxZoom: 4,
        wheelSensitivity: 0.3,
      });

      // ── Event handlers ────────────────────────────────────────────────────
      cy.on('tap', 'node', (evt) => {
        const raw = evt.target.data('raw') as GraphNode;
        setSelectedNode(raw);
        setSelectedEdge(null);
      });

      cy.on('tap', 'edge', (evt) => {
        const raw = evt.target.data('raw') as GraphEdge;
        setSelectedEdge(raw);
        setSelectedNode(null);
      });

      cy.on('tap', (evt) => {
        // Tap on background deselects
        if (evt.target === cy) {
          setSelectedNode(null);
          setSelectedEdge(null);
        }
      });

      cy.on('dbltap', 'node', (evt) => {
        cy.animate(
          { center: { eles: evt.target }, zoom: 1.5 },
          { duration: 400, easing: 'ease-in-out-cubic' }
        );
      });

      cy.on('mouseover', 'node', (evt) => {
        evt.target.style('cursor', 'pointer');
      });

      cyRef.current = cy;
    })();

    return () => {
      if (cyRef.current) {
        cyRef.current.destroy();
        cyRef.current = null;
      }
    };
    // We intentionally exclude activeTypes and layout here — they are handled
    // by their own effects below so we don't re-mount the whole instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphData]);

  // ── React to activeTypes filter changes ─────────────────────────────────────
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || !graphData) return;
    cy.edges().forEach((edge) => {
      const type = edge.data('type') as string;
      if (activeTypes.includes(type)) {
        edge.style('display', 'element');
      } else {
        edge.style('display', 'none');
      }
    });
  }, [activeTypes, graphData]);

  // ── React to layout changes ──────────────────────────────────────────────────
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.layout({ name: layout, animate: true, animationDuration: 500 } as cytoscape.LayoutOptions).run();
  }, [layout]);

  // ── Public API exposed via callbacks ────────────────────────────────────────
  const handleCenterNode = useCallback((nodeId: string) => {
    const cy = cyRef.current;
    if (!cy) return;
    const node = cy.getElementById(nodeId);
    if (node.length) {
      cy.animate({ center: { eles: node }, zoom: 1.5 }, { duration: 400, easing: 'ease-in-out-cubic' });
    }
  }, []);

  const handleToggleType = useCallback((type: string) => {
    setActiveTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]
    );
  }, []);

  return (
    <div className="flex flex-col h-full min-h-[600px] bg-civic-light rounded-xl overflow-hidden border border-slate-200">
      {/* Controls bar */}
      <div className="flex-none border-b border-slate-200 bg-white">
        <GraphControls
          depth={depth}
          onDepthChange={setDepth}
          minAmount={minAmount}
          onMinAmountChange={setMinAmount}
          relationshipTypes={['donation', 'lobbying', 'contract']}
          activeTypes={activeTypes}
          onToggleType={handleToggleType}
          layout={layout}
          onLayoutChange={setLayout}
        />
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Graph canvas */}
        <div className="relative flex-1 bg-[#F8FAFC]">
          {/* Loading overlay */}
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-10">
              <div className="flex flex-col items-center gap-3">
                <div className="w-8 h-8 border-4 border-civic-blue border-t-transparent rounded-full animate-spin" />
                <p className="text-sm text-civic-slate font-medium">Loading graph data…</p>
              </div>
            </div>
          )}

          {/* Error overlay */}
          {error && !isLoading && (
            <div className="absolute inset-0 flex items-center justify-center z-10 p-6">
              <div className="bg-white border border-red-200 rounded-xl p-6 max-w-sm w-full shadow-md text-center">
                <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-3">
                  <svg className="w-5 h-5 text-civic-red" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <p className="text-sm font-semibold text-civic-navy mb-1">Unable to load graph</p>
                <p className="text-xs text-civic-slate mb-4">{error}</p>
                <button
                  onClick={() => void fetchData()}
                  className="px-4 py-2 bg-civic-navy text-white text-sm font-medium rounded-lg hover:bg-blue-900 transition-colors"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {/* Empty state */}
          {!isLoading && !error && graphData && graphData.nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center z-10 p-6">
              <div className="text-center">
                <p className="text-sm font-semibold text-civic-navy mb-1">No relationships found</p>
                <p className="text-xs text-civic-slate">Try increasing the depth or lowering the minimum amount.</p>
              </div>
            </div>
          )}

          {/* Cytoscape container */}
          <div ref={containerRef} className="w-full h-full" aria-label="Money relationship graph" />

          {/* Legend */}
          <div className="absolute bottom-4 left-4 bg-white/90 backdrop-blur rounded-lg p-3 shadow border border-slate-200 text-xs space-y-2">
            <p className="font-semibold text-civic-navy uppercase tracking-wide text-[10px]">Legend</p>
            <div className="space-y-1">
              <p className="font-medium text-civic-slate text-[10px] uppercase tracking-wide">Entities</p>
              {(Object.entries(NODE_COLORS) as [GraphNode['type'], string][]).map(([type, color]) => (
                <div key={type} className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full flex-none" style={{ backgroundColor: color }} />
                  <span className="text-civic-slate capitalize">{type}</span>
                </div>
              ))}
            </div>
            <div className="space-y-1 pt-1 border-t border-slate-100">
              <p className="font-medium text-civic-slate text-[10px] uppercase tracking-wide">Relationships</p>
              {(Object.entries(EDGE_COLORS) as [GraphEdge['type'], string][]).map(([type, color]) => (
                <div key={type} className="flex items-center gap-2">
                  <span className="w-6 h-0.5 flex-none" style={{ backgroundColor: color }} />
                  <span className="text-civic-slate capitalize">{type}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Zoom hint */}
          <p className="absolute bottom-4 right-4 text-[10px] text-civic-slate bg-white/80 backdrop-blur px-2 py-1 rounded">
            Scroll to zoom · Drag to pan · Double-click to center
          </p>
        </div>

        {/* Sidebar */}
        {(selectedNode ?? selectedEdge) && (
          <div className="flex-none w-72 border-l border-slate-200 bg-white overflow-y-auto">
            <GraphSidebar
              selectedNode={selectedNode}
              selectedEdge={selectedEdge}
              onCenterNode={handleCenterNode}
            />
          </div>
        )}
      </div>

      {/* Search context chip */}
      {initialQuery && (
        <div className="flex-none border-t border-slate-100 bg-white px-4 py-2 flex items-center gap-2">
          <span className="text-xs text-civic-slate">Query:</span>
          <span className="text-xs font-medium bg-civic-navy/10 text-civic-navy px-2 py-0.5 rounded">{initialQuery}</span>
        </div>
      )}
    </div>
  );
}

