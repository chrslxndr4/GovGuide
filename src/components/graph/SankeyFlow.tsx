import { useEffect, useRef, useState, useCallback } from 'react';
import * as d3 from 'd3';
import {
  sankey,
  sankeyLinkHorizontal,
  sankeyJustify,
  type SankeyNode as D3SankeyNode,
  type SankeyLink as D3SankeyLink,
} from 'd3-sankey';

// ─── Public interfaces ──────────────────────────────────────────────────────

export interface SankeyNode {
  id: string;
  name: string;
  type: 'donor' | 'pac' | 'candidate' | 'corporation' | 'lobbying_firm' | 'bill';
}

export interface SankeyLink {
  source: string;
  target: string;
  value: number;
  type: 'donation' | 'lobbying' | 'expenditure';
}

export interface SankeyFlowProps {
  nodes: SankeyNode[];
  links: SankeyLink[];
  width?: number;
  height?: number;
  title?: string;
}

// ─── Internal D3 node / link shapes ────────────────────────────────────────

interface NodeExtra {
  id: string;
  name: string;
  type: SankeyNode['type'];
}

interface LinkExtra {
  type: SankeyLink['type'];
  /** Original string ids kept for lookup before D3 resolves them to objects */
  sourceId: string;
  targetId: string;
}

type LayoutNode = D3SankeyNode<NodeExtra, LinkExtra>;
type LayoutLink = D3SankeyLink<NodeExtra, LinkExtra>;

// ─── Constants ──────────────────────────────────────────────────────────────

const NODE_COLOR: Record<SankeyNode['type'], string> = {
  donor: '#2563EB',
  pac: '#D97706',
  candidate: '#1B2A4A',
  corporation: '#475569',
  lobbying_firm: '#D97706',
  bill: '#059669',
};

const MIN_HEIGHT = 400;
const NODE_WIDTH = 20;
const NODE_PADDING = 24;
const LABEL_PADDING = 8;
const MARGIN = { top: 24, right: 160, bottom: 24, left: 160 };

// ─── Utility helpers ────────────────────────────────────────────────────────

function formatAmount(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toLocaleString()}`;
}

function nodeLabel(node: LayoutNode): string {
  return node.name;
}

function nodeTotalFlow(node: LayoutNode): number {
  const incoming = (node.targetLinks ?? []).reduce((sum, l) => sum + (l.value ?? 0), 0);
  const outgoing = (node.sourceLinks ?? []).reduce((sum, l) => sum + (l.value ?? 0), 0);
  return Math.max(incoming, outgoing);
}

// ─── Tooltip state ───────────────────────────────────────────────────────────

interface TooltipState {
  visible: boolean;
  x: number;
  y: number;
  content: string;
  subContent: string;
}

const TOOLTIP_HIDDEN: TooltipState = {
  visible: false,
  x: 0,
  y: 0,
  content: '',
  subContent: '',
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function SankeyFlow({
  nodes: propNodes,
  links: propLinks,
  width: propWidth,
  height: propHeight,
  title,
}: SankeyFlowProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState>(TOOLTIP_HIDDEN);
  const [dimensions, setDimensions] = useState<{ width: number; height: number }>({
    width: propWidth ?? 0,
    height: propHeight ?? MIN_HEIGHT,
  });

  // ── Resize observer ────────────────────────────────────────────────────────
  useEffect(() => {
    if (propWidth && propHeight) {
      setDimensions({ width: propWidth, height: Math.max(propHeight, MIN_HEIGHT) });
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = propWidth ?? entry.contentRect.width;
      const h = propHeight ?? Math.max(entry.contentRect.height, MIN_HEIGHT);
      setDimensions({ width: w, height: h });
    });

    observer.observe(container);
    // Seed with current size so first render is not 0×0
    setDimensions({
      width: propWidth ?? container.clientWidth,
      height: propHeight ?? Math.max(container.clientHeight, MIN_HEIGHT),
    });

    return () => observer.disconnect();
  }, [propWidth, propHeight]);

  // ── Tooltip helpers ────────────────────────────────────────────────────────
  const showTooltip = useCallback((x: number, y: number, content: string, subContent: string) => {
    setTooltip({ visible: true, x, y, content, subContent });
  }, []);

  const hideTooltip = useCallback(() => {
    setTooltip(TOOLTIP_HIDDEN);
  }, []);

  // ── D3 render ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || dimensions.width === 0) return;

    const innerWidth = dimensions.width - MARGIN.left - MARGIN.right;
    const innerHeight = dimensions.height - MARGIN.top - MARGIN.bottom;

    if (innerWidth <= 0 || innerHeight <= 0) return;

    // Clear previous render
    d3.select(svg).selectAll('*').remove();

    // ── Build layout data ──────────────────────────────────────────────────

    const layoutNodes: LayoutNode[] = propNodes.map((n) => ({
      id: n.id,
      name: n.name,
      type: n.type,
    }));

    const nodeIndex = new Map<string, number>(layoutNodes.map((n, i) => [n.id, i]));

    const layoutLinks: LayoutLink[] = propLinks
      .filter((l) => nodeIndex.has(l.source) && nodeIndex.has(l.target))
      .map((l) => ({
        source: nodeIndex.get(l.source) as number,
        target: nodeIndex.get(l.target) as number,
        value: l.value,
        type: l.type,
        sourceId: l.source,
        targetId: l.target,
      }));

    // ── Run Sankey layout ─────────────────────────────────────────────────

    const sankeyGenerator = sankey<NodeExtra, LinkExtra>()
      .nodeId((d) => d.id)
      .nodeAlign(sankeyJustify)
      .nodeWidth(NODE_WIDTH)
      .nodePadding(NODE_PADDING)
      .extent([
        [0, 0],
        [innerWidth, innerHeight],
      ]);

    const { nodes: computedNodes, links: computedLinks } = sankeyGenerator({
      nodes: layoutNodes,
      links: layoutLinks,
    });

    const linkPath = sankeyLinkHorizontal<NodeExtra, LinkExtra>();

    // ── SVG root ──────────────────────────────────────────────────────────

    const root = d3
      .select(svg)
      .attr('width', dimensions.width)
      .attr('height', dimensions.height)
      .append('g')
      .attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

    // ── Links ──────────────────────────────────────────────────────────────

    const linkGroup = root.append('g').attr('fill', 'none');

    const linkSelection = linkGroup
      .selectAll<SVGPathElement, LayoutLink>('path')
      .data(computedLinks)
      .join('path')
      .attr('d', (d) => linkPath(d) ?? '')
      .attr('stroke', (d) => {
        const sourceNode = d.source as LayoutNode;
        return NODE_COLOR[sourceNode.type] ?? '#94a3b8';
      })
      .attr('stroke-width', (d) => Math.max(1, d.width ?? 1))
      .attr('stroke-opacity', 0.3)
      .style('cursor', 'pointer');

    // ── Nodes ─────────────────────────────────────────────────────────────

    const nodeGroup = root.append('g');

    const nodeSelection = nodeGroup
      .selectAll<SVGRectElement, LayoutNode>('rect')
      .data(computedNodes)
      .join('rect')
      .attr('x', (d) => d.x0 ?? 0)
      .attr('y', (d) => d.y0 ?? 0)
      .attr('width', (d) => (d.x1 ?? 0) - (d.x0 ?? 0))
      .attr('height', (d) => Math.max(1, (d.y1 ?? 0) - (d.y0 ?? 0)))
      .attr('fill', (d) => NODE_COLOR[d.type] ?? '#94a3b8')
      .attr('rx', 3)
      .attr('ry', 3)
      .style('cursor', 'pointer');

    // ── Node labels ────────────────────────────────────────────────────────

    root
      .append('g')
      .selectAll<SVGTextElement, LayoutNode>('text')
      .data(computedNodes)
      .join('text')
      .attr('x', (d) => {
        const x0 = d.x0 ?? 0;
        const x1 = d.x1 ?? 0;
        return x0 < innerWidth / 2 ? x1 + LABEL_PADDING : x0 - LABEL_PADDING;
      })
      .attr('y', (d) => ((d.y0 ?? 0) + (d.y1 ?? 0)) / 2)
      .attr('dy', '0.35em')
      .attr('text-anchor', (d) => ((d.x0 ?? 0) < innerWidth / 2 ? 'start' : 'end'))
      .attr('font-size', 12)
      .attr('font-family', 'Inter, system-ui, sans-serif')
      .attr('fill', '#1B2A4A')
      .attr('pointer-events', 'none')
      .text((d) => nodeLabel(d));

    // ── Node interaction ──────────────────────────────────────────────────

    nodeSelection
      .on('mouseenter', function (event: MouseEvent, d: LayoutNode) {
        const connectedLinks = new Set<LayoutLink>();
        (d.sourceLinks ?? []).forEach((l) => connectedLinks.add(l as LayoutLink));
        (d.targetLinks ?? []).forEach((l) => connectedLinks.add(l as LayoutLink));

        linkSelection.attr('stroke-opacity', (l) =>
          connectedLinks.has(l) ? 0.7 : 0.1,
        );

        const total = nodeTotalFlow(d);
        const svgRect = svg.getBoundingClientRect();
        showTooltip(
          event.clientX - svgRect.left,
          event.clientY - svgRect.top,
          d.name,
          `Total flow: ${formatAmount(total)}`,
        );
      })
      .on('mousemove', function (event: MouseEvent) {
        const svgRect = svg.getBoundingClientRect();
        setTooltip((prev) => ({
          ...prev,
          x: event.clientX - svgRect.left,
          y: event.clientY - svgRect.top,
        }));
      })
      .on('mouseleave', function () {
        linkSelection.attr('stroke-opacity', 0.3);
        hideTooltip();
      });

    // ── Link interaction ───────────────────────────────────────────────────

    linkSelection
      .on('mouseenter', function (event: MouseEvent, d: LayoutLink) {
        d3.select(this).attr('stroke-opacity', 0.7);

        const sourceNode = d.source as LayoutNode;
        const targetNode = d.target as LayoutNode;
        const svgRect = svg.getBoundingClientRect();
        showTooltip(
          event.clientX - svgRect.left,
          event.clientY - svgRect.top,
          `${sourceNode.name} → ${targetNode.name}`,
          formatAmount(d.value),
        );
      })
      .on('mousemove', function (event: MouseEvent) {
        const svgRect = svg.getBoundingClientRect();
        setTooltip((prev) => ({
          ...prev,
          x: event.clientX - svgRect.left,
          y: event.clientY - svgRect.top,
        }));
      })
      .on('mouseleave', function () {
        d3.select(this).attr('stroke-opacity', 0.3);
        hideTooltip();
      });
  }, [dimensions, propNodes, propLinks, showTooltip, hideTooltip]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      {title && (
        <div className="px-6 py-4 border-b border-slate-200">
          <h3 className="text-base font-semibold text-[#1B2A4A]">{title}</h3>
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap gap-x-5 gap-y-2 px-6 pt-4 pb-2">
        {(
          [
            ['donor', 'Donor'],
            ['pac', 'PAC'],
            ['candidate', 'Candidate'],
            ['corporation', 'Corporation'],
            ['lobbying_firm', 'Lobbying Firm'],
            ['bill', 'Bill'],
          ] as [SankeyNode['type'], string][]
        ).map(([type, label]) => (
          <span key={type} className="flex items-center gap-1.5 text-xs text-[#475569]">
            <span
              className="inline-block w-3 h-3 rounded-sm flex-shrink-0"
              style={{ backgroundColor: NODE_COLOR[type] }}
            />
            {label}
          </span>
        ))}
      </div>

      {/* Chart area */}
      <div
        ref={containerRef}
        className="relative w-full"
        style={{ minHeight: `${MIN_HEIGHT}px`, height: propHeight ? `${propHeight}px` : undefined }}
      >
        <svg ref={svgRef} className="w-full h-full" />

        {/* Tooltip */}
        {tooltip.visible && (
          <div
            className="pointer-events-none absolute z-20 max-w-[220px] rounded-lg bg-[#1B2A4A] px-3 py-2 shadow-lg"
            style={{
              left: tooltip.x + 12,
              top: tooltip.y - 10,
              transform:
                tooltip.x > (dimensions.width ?? 0) / 2
                  ? 'translateX(calc(-100% - 24px))'
                  : undefined,
            }}
          >
            <p className="text-xs font-semibold text-white leading-snug">{tooltip.content}</p>
            {tooltip.subContent && (
              <p className="mt-0.5 text-xs text-[#D97706] font-mono">{tooltip.subContent}</p>
            )}
          </div>
        )}

        {/* Empty state */}
        {propNodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-sm text-[#475569]">No flow data to display.</p>
          </div>
        )}
      </div>
    </div>
  );
}
