import type { GraphNode, GraphEdge } from './MoneyGraph';

// ─── Types ────────────────────────────────────────────────────────────────────

interface GraphSidebarProps {
  selectedNode?: GraphNode | null;
  selectedEdge?: GraphEdge | null;
  onCenterNode?: (nodeId: string) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatCurrency(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  return `$${amount.toLocaleString()}`;
}

function formatDate(isoDate: string): string {
  const d = new Date(isoDate);
  if (isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

const NODE_TYPE_LABELS: Record<GraphNode['type'], string> = {
  official: 'Government Official',
  pac: 'Political Action Committee',
  corporation: 'Corporation',
  individual: 'Individual',
};

const NODE_TYPE_COLORS: Record<GraphNode['type'], string> = {
  official: '#1B2A4A',
  pac: '#D97706',
  corporation: '#475569',
  individual: '#2563EB',
};

const EDGE_TYPE_LABELS: Record<GraphEdge['type'], string> = {
  donation: 'Campaign Donation',
  lobbying: 'Lobbying Expenditure',
  contract: 'Government Contract',
};

const EDGE_TYPE_COLORS: Record<GraphEdge['type'], string> = {
  donation: '#059669',
  lobbying: '#D97706',
  contract: '#DC2626',
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-[10px] font-semibold text-civic-slate uppercase tracking-widest mb-2">
      {children}
    </h4>
  );
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="py-1.5 border-b border-slate-100 last:border-0">
      <dt className="text-[10px] font-medium text-civic-slate uppercase tracking-wider">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-800">{value}</dd>
    </div>
  );
}

// ─── Node panel ───────────────────────────────────────────────────────────────

function NodePanel({
  node,
  onCenterNode,
}: {
  node: GraphNode;
  onCenterNode?: (nodeId: string) => void;
}) {
  const color = NODE_TYPE_COLORS[node.type];
  const typeLabel = NODE_TYPE_LABELS[node.type];

  // Pull well-known metadata fields; display all remaining as generic rows
  const { total_amount, transaction_count, state, party, filing_url, ...rest } = node.metadata as Record<
    string,
    string | number | boolean | null
  >;

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div
          className="mt-0.5 flex-none w-8 h-8 rounded-full flex items-center justify-center"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        >
          <span className="text-white text-xs font-bold uppercase">{node.name.charAt(0)}</span>
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-civic-navy leading-tight break-words">{node.name}</h3>
          <span
            className="inline-block mt-1 text-[10px] font-medium px-2 py-0.5 rounded"
            style={{ backgroundColor: `${color}20`, color }}
          >
            {typeLabel}
          </span>
        </div>
      </div>

      {/* Key stats */}
      {(total_amount != null || transaction_count != null) && (
        <div className="grid grid-cols-2 gap-2">
          {total_amount != null && (
            <div className="bg-slate-50 rounded-lg p-2 text-center">
              <p className="text-xs font-bold text-civic-navy">{formatCurrency(Number(total_amount))}</p>
              <p className="text-[10px] text-civic-slate mt-0.5">Total Flow</p>
            </div>
          )}
          {transaction_count != null && (
            <div className="bg-slate-50 rounded-lg p-2 text-center">
              <p className="text-xs font-bold text-civic-navy">{Number(transaction_count).toLocaleString()}</p>
              <p className="text-[10px] text-civic-slate mt-0.5">Transactions</p>
            </div>
          )}
        </div>
      )}

      {/* Details */}
      <div>
        <SectionHeading>Details</SectionHeading>
        <dl>
          {state != null && <MetaRow label="State" value={String(state)} />}
          {party != null && <MetaRow label="Party" value={String(party)} />}
          {Object.entries(rest)
            .filter(([, v]) => v != null)
            .slice(0, 6)
            .map(([key, value]) => (
              <MetaRow
                key={key}
                label={key.replace(/_/g, ' ')}
                value={String(value)}
              />
            ))}
        </dl>
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-2">
        {onCenterNode && (
          <button
            onClick={() => onCenterNode(node.id)}
            className="w-full px-3 py-2 bg-civic-navy text-white text-xs font-medium rounded-lg hover:bg-blue-900 transition-colors text-center"
          >
            Make Center
          </button>
        )}
        <a
          href={`/entities/${node.id}`}
          className="w-full px-3 py-2 bg-white border border-civic-blue text-civic-blue text-xs font-medium rounded-lg hover:bg-civic-blue/5 transition-colors text-center block"
        >
          View Full Profile
        </a>
        {typeof filing_url === 'string' && filing_url && (
          <a
            href={filing_url}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full px-3 py-2 bg-white border border-slate-200 text-civic-slate text-xs font-medium rounded-lg hover:border-civic-blue hover:text-civic-blue transition-colors text-center block"
          >
            View Filing Source
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Edge panel ───────────────────────────────────────────────────────────────

function EdgePanel({ edge }: { edge: GraphEdge }) {
  const color = EDGE_TYPE_COLORS[edge.type];
  const typeLabel = EDGE_TYPE_LABELS[edge.type];
  const filingUrl = (edge as GraphEdge & { filing_url?: string }).filing_url;

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div>
        <span
          className="inline-block text-[10px] font-semibold px-2 py-1 rounded uppercase tracking-wider"
          style={{ backgroundColor: `${color}20`, color }}
        >
          {typeLabel}
        </span>
        <h3 className="mt-2 text-sm font-bold text-civic-navy">{formatCurrency(edge.amount)}</h3>
      </div>

      {/* Details */}
      <div>
        <SectionHeading>Transaction Details</SectionHeading>
        <dl>
          <MetaRow label="Amount" value={<span className="font-semibold">{formatCurrency(edge.amount)}</span>} />
          <MetaRow label="Date" value={formatDate(edge.date)} />
          <MetaRow label="Type" value={typeLabel} />
          <MetaRow label="From (ID)" value={<span className="font-mono text-[11px]">{edge.source}</span>} />
          <MetaRow label="To (ID)" value={<span className="font-mono text-[11px]">{edge.target}</span>} />
        </dl>
      </div>

      {/* Actions */}
      {filingUrl && (
        <a
          href={filingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="w-full px-3 py-2 bg-white border border-slate-200 text-civic-slate text-xs font-medium rounded-lg hover:border-civic-blue hover:text-civic-blue transition-colors text-center block"
        >
          View Filing
        </a>
      )}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyPanel() {
  return (
    <div className="p-6 flex flex-col items-center justify-center h-full text-center">
      <div className="w-10 h-10 rounded-full bg-slate-100 flex items-center justify-center mb-3">
        <svg className="w-5 h-5 text-civic-slate" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 110 20A10 10 0 0112 2z" />
        </svg>
      </div>
      <p className="text-xs font-medium text-civic-navy mb-1">Nothing selected</p>
      <p className="text-[11px] text-civic-slate">Click a node or edge in the graph to see details here.</p>
    </div>
  );
}

// ─── GraphSidebar ─────────────────────────────────────────────────────────────

export default function GraphSidebar({ selectedNode, selectedEdge, onCenterNode }: GraphSidebarProps) {
  return (
    <aside className="flex flex-col h-full" aria-label="Graph details">
      {/* Panel header */}
      <div className="flex-none px-4 py-3 border-b border-slate-200 bg-slate-50">
        <h3 className="text-xs font-semibold text-civic-navy uppercase tracking-wider">
          {selectedNode ? 'Entity Details' : selectedEdge ? 'Relationship Details' : 'Details'}
        </h3>
      </div>

      {/* Panel body */}
      <div className="flex-1 overflow-y-auto">
        {selectedNode ? (
          <NodePanel node={selectedNode} onCenterNode={onCenterNode} />
        ) : selectedEdge ? (
          <EdgePanel edge={selectedEdge} />
        ) : (
          <EmptyPanel />
        )}
      </div>
    </aside>
  );
}
