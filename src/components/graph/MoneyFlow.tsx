import { useEffect, useRef } from 'react';

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

interface MoneyFlowProps {
  nodes: FlowNode[];
  links: FlowLink[];
  width?: number;
  height?: number;
}

export default function MoneyFlow({ nodes, links, width = 800, height = 500 }: MoneyFlowProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || !nodes.length || !links.length) return;

    async function render() {
      const d3 = await import('d3');
      const { sankey, sankeyLinkHorizontal } = await import('d3-sankey');

      const svg = d3.select(svgRef.current);
      svg.selectAll('*').remove();

      // Build sankey data
      const nodeIndex = new Map(nodes.map((n, i) => [n.id, i]));
      const sankeyData = {
        nodes: nodes.map(n => ({ ...n })),
        links: links
          .filter(l => nodeIndex.has(l.source) && nodeIndex.has(l.target))
          .map(l => ({
            source: nodeIndex.get(l.source)!,
            target: nodeIndex.get(l.target)!,
            value: l.amount || 1,
            type: l.type,
          })),
      };

      if (!sankeyData.links.length) return;

      const sankeyLayout = sankey<any, any>()
        .nodeWidth(15)
        .nodePadding(10)
        .extent([[1, 5], [width - 1, height - 5]]);

      const { nodes: sNodes, links: sLinks } = sankeyLayout(sankeyData);

      const color = d3.scaleOrdinal<string>()
        .domain(['person', 'corporation', 'pac', 'super_pac', 'lobbying_firm'])
        .range(['#1a365d', '#742a2a', '#2c5282', '#e53e3e', '#553c9a']);

      // Draw links
      svg.append('g')
        .selectAll('path')
        .data(sLinks)
        .join('path')
        .attr('d', sankeyLinkHorizontal())
        .attr('stroke-width', (d: any) => Math.max(1, d.width))
        .attr('stroke', '#a0aec0')
        .attr('stroke-opacity', 0.5)
        .attr('fill', 'none')
        .append('title')
        .text((d: any) => `${d.source.name} → ${d.target.name}\n$${d.value.toLocaleString()}`);

      // Draw nodes
      svg.append('g')
        .selectAll('rect')
        .data(sNodes)
        .join('rect')
        .attr('x', (d: any) => d.x0)
        .attr('y', (d: any) => d.y0)
        .attr('height', (d: any) => Math.max(1, d.y1 - d.y0))
        .attr('width', (d: any) => d.x1 - d.x0)
        .attr('fill', (d: any) => color(d.type) || '#718096')
        .append('title')
        .text((d: any) => `${d.name}\n${d.type}`);

      // Labels
      svg.append('g')
        .selectAll('text')
        .data(sNodes)
        .join('text')
        .attr('x', (d: any) => d.x0 < width / 2 ? d.x1 + 6 : d.x0 - 6)
        .attr('y', (d: any) => (d.y1 + d.y0) / 2)
        .attr('dy', '0.35em')
        .attr('text-anchor', (d: any) => d.x0 < width / 2 ? 'start' : 'end')
        .attr('font-size', '10px')
        .attr('fill', '#1a202c')
        .text((d: any) => d.name.length > 25 ? d.name.slice(0, 22) + '...' : d.name);
    }

    render();
  }, [nodes, links, width, height]);

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      className="bg-white rounded-lg border border-slate-200"
    />
  );
}
