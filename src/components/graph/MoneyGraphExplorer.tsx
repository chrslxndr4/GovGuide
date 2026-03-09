import { useState, useEffect } from 'react';
import EntitySearch from '../search/EntitySearch';
import GraphControls from './GraphControls';
import MoneyGraph from './MoneyGraph';
import MoneyFlow from './MoneyFlow';

interface SearchResult {
  id: string;
  name: string;
  type: string;
  category: 'entity' | 'official' | 'bill' | 'judge';
  detail?: string;
}

interface SelectedEntity {
  id: string;
  name: string;
  type: string;
}

const DEFAULT_HOPS = 2;
const DEFAULT_RELATIONSHIP_TYPES: string[] = [];

export default function MoneyGraphExplorer() {
  const [selectedEntity, setSelectedEntity] = useState<SelectedEntity | null>(null);
  const [hops, setHops] = useState<number>(DEFAULT_HOPS);
  const [minAmount, setMinAmount] = useState<number | undefined>(undefined);
  const [relationshipTypes, setRelationshipTypes] = useState<string[]>(DEFAULT_RELATIONSHIP_TYPES);

  function handleEntitySelect(result: SearchResult) {
    setSelectedEntity({
      id: result.id,
      name: result.name,
      type: result.type,
    });
  }

  function handleNodeClick(entityId: string, entityName: string) {
    setSelectedEntity({
      id: entityId,
      name: entityName,
      type: 'entity',
    });
  }

  function handleExport() {
    if (!selectedEntity) return;
    const params = new URLSearchParams({ entity_id: selectedEntity.id, hops: String(hops) });
    if (minAmount !== undefined) params.set('min_amount', String(minAmount));
    relationshipTypes.forEach(t => params.append('relationship_types', t));
    window.open(`/api/money-graph?${params}&format=json`, '_blank');
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Main explorer layout: sidebar + graph */}
      <div className="flex gap-6 items-start">
        {/* Left sidebar */}
        <aside className="w-72 shrink-0 flex flex-col gap-4">
          {/* Search */}
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <h2 className="font-semibold text-civic-navy text-sm mb-3">Search Entity</h2>
            <EntitySearch
              onSelect={handleEntitySelect}
              placeholder="Search officials, orgs, PACs..."
              types={['entity', 'official']}
            />
            {selectedEntity && (
              <div className="mt-3 pt-3 border-t border-slate-100">
                <p className="text-xs text-slate-500 mb-0.5">Currently viewing</p>
                <p className="text-sm font-medium text-civic-navy truncate">{selectedEntity.name}</p>
                <p className="text-xs text-civic-slate capitalize">{selectedEntity.type.replace(/_/g, ' ')}</p>
              </div>
            )}
          </div>

          {/* Controls — only shown when an entity is selected */}
          {selectedEntity && (
            <GraphControls
              hops={hops}
              onHopsChange={setHops}
              minAmount={minAmount}
              onMinAmountChange={setMinAmount}
              relationshipTypes={relationshipTypes}
              onRelationshipTypesChange={setRelationshipTypes}
              onExport={handleExport}
            />
          )}

          {/* Legend */}
          {selectedEntity && (
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <h3 className="font-semibold text-slate-800 text-sm mb-3">Entity Types</h3>
              <ul className="space-y-1.5">
                {LEGEND_ITEMS.map(item => (
                  <li key={item.label} className="flex items-center gap-2">
                    <span
                      className="w-3 h-3 rounded-full shrink-0"
                      style={{ backgroundColor: item.color }}
                    />
                    <span className="text-xs text-slate-600">{item.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        {/* Graph area */}
        <div className="flex-1 min-w-0">
          {selectedEntity ? (
            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-civic-navy text-sm">
                    {selectedEntity.name}
                  </h2>
                  <p className="text-xs text-civic-slate">
                    {hops} hop{hops !== 1 ? 's' : ''} out
                    {minAmount !== undefined && ` · min $${minAmount.toLocaleString()}`}
                    {relationshipTypes.length > 0 && ` · ${relationshipTypes.length} filter${relationshipTypes.length !== 1 ? 's' : ''}`}
                  </p>
                </div>
                <button
                  onClick={() => setSelectedEntity(null)}
                  className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
                  aria-label="Clear selection"
                >
                  Clear
                </button>
              </div>
              <MoneyGraph
                entityId={selectedEntity.id}
                hops={hops}
                minAmount={minAmount}
                relationshipTypes={relationshipTypes.length > 0 ? relationshipTypes : undefined}
                onNodeClick={handleNodeClick}
                height="580px"
              />
            </div>
          ) : (
            <EmptyState />
          )}
        </div>
      </div>

      {/* Sankey diagram — only shown when entity selected */}
      {selectedEntity && (
        <section>
          <div className="mb-3">
            <h2 className="text-lg font-display text-civic-navy">Money Flow</h2>
            <p className="text-sm text-civic-slate">
              Proportional flow of funds through {selectedEntity.name}'s financial network.
            </p>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-4 overflow-x-auto">
            <MoneyFlowConnected entityId={selectedEntity.id} hops={hops} />
          </div>
        </section>
      )}
    </div>
  );
}

// Fetches graph data and extracts nodes/links for the Sankey diagram.
// Kept as a sub-component so the fetch is collocated with the render that needs it.
function MoneyFlowConnected({ entityId, hops }: { entityId: string; hops: number }) {
  const [flowData, setFlowData] = useState<FlowData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch whenever entityId or hops changes
  useEffect(() => {
    let cancelled = false;

    async function fetchFlow() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ entity_id: entityId, hops: String(hops) });
        const res = await fetch(`/api/money-graph?${params}`);
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setFlowData(extractFlowData(data));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load flow data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchFlow();
    return () => { cancelled = true; };
  }, [entityId, hops]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40 text-slate-500 text-sm">
        Loading flow data...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-40 text-red-600 text-sm">
        {error}
      </div>
    );
  }

  if (!flowData || flowData.nodes.length === 0 || flowData.links.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-slate-400 text-sm">
        No flow data available for this entity.
      </div>
    );
  }

  return (
    <MoneyFlow
      nodes={flowData.nodes}
      links={flowData.links}
      width={1200}
      height={420}
    />
  );
}

interface FlowNode {
  id: string;
  name: string;
  type: string;
}

interface FlowLink {
  source: string;
  target: string;
  amount: number;
  type: string;
}

interface FlowData {
  nodes: FlowNode[];
  links: FlowLink[];
}

interface GraphApiNode {
  data: {
    id: string;
    label: string;
    type: string;
  };
}

interface GraphApiEdge {
  data: {
    source: string;
    target: string;
    amount?: number;
    type: string;
  };
}

interface GraphApiResponse {
  elements: {
    nodes: GraphApiNode[];
    edges: GraphApiEdge[];
  };
}

function extractFlowData(apiResponse: GraphApiResponse): FlowData {
  const nodes: FlowNode[] = apiResponse.elements.nodes.map(n => ({
    id: n.data.id,
    name: n.data.label,
    type: n.data.type,
  }));

  const links: FlowLink[] = apiResponse.elements.edges
    .filter(e => e.data.amount !== undefined && e.data.amount > 0)
    .map(e => ({
      source: e.data.source,
      target: e.data.target,
      amount: e.data.amount ?? 0,
      type: e.data.type,
    }));

  return { nodes, links };
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-[580px] bg-white border border-slate-200 rounded-lg text-center px-8">
      <div className="w-16 h-16 rounded-full bg-civic-light border-2 border-slate-200 flex items-center justify-center mb-4">
        <NetworkIcon />
      </div>
      <h3 className="text-lg font-display text-civic-navy mb-2">Search to explore</h3>
      <p className="text-sm text-civic-slate max-w-xs">
        Enter a politician, organization, PAC, or donor in the search box to map their
        financial relationships across the political landscape.
      </p>
      <ul className="mt-6 text-xs text-slate-400 space-y-1 text-left">
        <li>- Donations and contributions</li>
        <li>- Lobbying expenditures</li>
        <li>- Federal grants and contracts</li>
        <li>- Organizational affiliations</li>
      </ul>
    </div>
  );
}

function NetworkIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="#2563EB"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="5" r="2" />
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="19" r="2" />
      <line x1="12" y1="7" x2="5" y2="17" />
      <line x1="12" y1="7" x2="19" y2="17" />
      <line x1="5" y1="19" x2="19" y2="19" />
    </svg>
  );
}

const LEGEND_ITEMS: { label: string; color: string }[] = [
  { label: 'Person', color: '#1a365d' },
  { label: 'Corporation', color: '#742a2a' },
  { label: 'PAC', color: '#2c5282' },
  { label: 'Super PAC', color: '#e53e3e' },
  { label: 'Hybrid PAC', color: '#d69e2e' },
  { label: '501(c)(4)', color: '#9b2c2c' },
  { label: 'Lobbying Firm', color: '#553c9a' },
  { label: 'Labor Union', color: '#276749' },
  { label: 'Political Party', color: '#2b6cb0' },
  { label: 'Other', color: '#718096' },
];
