import { useState } from 'react';

interface GraphNode {
  id: string;
  name: string;
  type: string;
}

interface GraphEdge {
  source: string;
  target: string;
  label?: string;
  amount?: number;
}

interface GraphFallbackProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  caption: string;
}

function formatAmount(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount.toFixed(0)}`;
}

function resolveNodeName(id: string, nodes: GraphNode[]): string {
  return nodes.find((n) => n.id === id)?.name ?? id;
}

export default function GraphFallback({ nodes, edges, caption }: GraphFallbackProps) {
  const [tableVisible, setTableVisible] = useState(false);

  return (
    <>
      {/* Visually hidden table always available to screen readers */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        role="region"
        aria-label={`${caption} — data table`}
      >
        <figure>
          <figcaption>{caption}</figcaption>

          <table>
            <caption>Entities</caption>
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node) => (
                <tr key={node.id}>
                  <td>{node.id}</td>
                  <td>{node.name}</td>
                  <td>{node.type}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <table>
            <caption>Relationships</caption>
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Target</th>
                <th scope="col">Relationship</th>
                <th scope="col">Amount</th>
              </tr>
            </thead>
            <tbody>
              {edges.map((edge, index) => (
                <tr key={`${edge.source}-${edge.target}-${index}`}>
                  <td>{resolveNodeName(edge.source, nodes)}</td>
                  <td>{resolveNodeName(edge.target, nodes)}</td>
                  <td>{edge.label ?? '—'}</td>
                  <td>{edge.amount != null ? formatAmount(edge.amount) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </figure>
      </div>

      {/* Toggle button visible to all sighted users */}
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={() => setTableVisible((v) => !v)}
          className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 underline underline-offset-2 transition-colors focus:outline-none focus:ring-2 focus:ring-civic-blue focus:ring-offset-1 rounded"
          aria-expanded={tableVisible}
          aria-controls="graph-fallback-table"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
          </svg>
          {tableVisible ? 'Hide table view' : 'View as table'}
        </button>
      </div>

      {/* Visible table panel toggled by sighted users */}
      {tableVisible && (
        <div
          id="graph-fallback-table"
          className="mt-3 rounded-lg border border-slate-200 bg-white overflow-x-auto text-sm"
        >
          <div className="px-4 pt-3 pb-1 text-xs font-semibold text-slate-500 uppercase tracking-wide border-b border-slate-100">
            {caption}
          </div>

          <div className="px-4 py-3">
            <p className="text-xs font-semibold text-slate-600 mb-1">Entities ({nodes.length})</p>
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="pb-1 pr-4 text-xs font-medium text-slate-500">Name</th>
                  <th className="pb-1 text-xs font-medium text-slate-500">Type</th>
                </tr>
              </thead>
              <tbody>
                {nodes.map((node) => (
                  <tr key={node.id} className="border-b border-slate-50 last:border-0">
                    <td className="py-1 pr-4 text-slate-800">{node.name}</td>
                    <td className="py-1 text-slate-500 capitalize">{node.type.replace(/_/g, ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {edges.length > 0 && (
            <div className="px-4 py-3 border-t border-slate-100">
              <p className="text-xs font-semibold text-slate-600 mb-1">
                Relationships ({edges.length})
              </p>
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="pb-1 pr-4 text-xs font-medium text-slate-500">Source</th>
                    <th className="pb-1 pr-4 text-xs font-medium text-slate-500">Target</th>
                    <th className="pb-1 pr-4 text-xs font-medium text-slate-500">Relationship</th>
                    <th className="pb-1 text-xs font-medium text-slate-500">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {edges.map((edge, index) => (
                    <tr
                      key={`${edge.source}-${edge.target}-${index}`}
                      className="border-b border-slate-50 last:border-0"
                    >
                      <td className="py-1 pr-4 text-slate-800">
                        {resolveNodeName(edge.source, nodes)}
                      </td>
                      <td className="py-1 pr-4 text-slate-800">
                        {resolveNodeName(edge.target, nodes)}
                      </td>
                      <td className="py-1 pr-4 text-slate-500">{edge.label ?? '—'}</td>
                      <td className="py-1 text-slate-800 font-mono">
                        {edge.amount != null ? formatAmount(edge.amount) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  );
}
