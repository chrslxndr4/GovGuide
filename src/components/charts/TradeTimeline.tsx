import React, { useMemo } from 'react';
import { Scatter } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  type ChartOptions,
  type Plugin,
  type TooltipItem,
  type ChartDataset,
  type ScatterDataPoint,
} from 'chart.js';

ChartJS.register(
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TradeType = 'purchase' | 'sale' | 'exchange';

interface TradeDataPoint {
  date: string;
  ticker: string;
  tradeType: TradeType;
  amountLow: number;
  amountHigh: number;
  officialName: string;
  daysLate?: number;
}

interface EventAnnotation {
  date: string;
  label: string;
}

interface TradeTimelineProps {
  trades: TradeDataPoint[];
  title?: string;
  events?: EventAnnotation[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRADE_COLORS: Record<TradeType, string> = {
  purchase: '#059669', // emerald-600
  sale: '#DC2626',    // civic-red
  exchange: '#D97706', // civic-gold
};

const TRADE_COLORS_ALPHA: Record<TradeType, string> = {
  purchase: 'rgba(5, 150, 105, 0.75)',
  sale: 'rgba(220, 38, 38, 0.75)',
  exchange: 'rgba(217, 119, 6, 0.75)',
};

const LATE_RING_COLOR = 'rgba(220, 38, 38, 0.35)';

/** Point radius bounds in pixels. Largest amount maps to MAX_R. */
const MIN_R = 5;
const MAX_R = 22;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function midpoint(low: number, high: number): number {
  return (low + high) / 2;
}

function formatAmount(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toLocaleString()}`;
}

function formatDateLong(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Maps `value` linearly into [MIN_R, MAX_R].
 * Falls back to midpoint radius when all values are identical.
 */
function scaleRadius(value: number, min: number, max: number): number {
  if (max === min) return (MIN_R + MAX_R) / 2;
  const normalized = (value - min) / (max - min);
  return MIN_R + normalized * (MAX_R - MIN_R);
}

/**
 * Converts an ISO date string to milliseconds since epoch.
 * Used as the numeric X value on the LinearScale X axis, since chart.js v4
 * requires an external date adapter for the TimeScale.
 */
function dateToX(iso: string): number {
  return new Date(iso).getTime();
}

// ---------------------------------------------------------------------------
// Scatter point type extended with source trade index
// ---------------------------------------------------------------------------

interface EnrichedScatterPoint extends ScatterDataPoint {
  tradeIdx: number;
}

// ---------------------------------------------------------------------------
// Extended dataset type carrying per-point late metadata
// ---------------------------------------------------------------------------

interface TradeDataset extends ChartDataset<'scatter', EnrichedScatterPoint[]> {
  lateMeta: boolean[];
}

// ---------------------------------------------------------------------------
// Event annotation plugin
// ---------------------------------------------------------------------------

function buildEventAnnotationPlugin(
  events: EventAnnotation[],
): Plugin<'scatter'> {
  return {
    id: 'govguide-trade-event-annotations',
    afterDraw(chart) {
      if (events.length === 0) return;

      const { ctx, chartArea, scales } = chart;
      const xScale = scales['x'];
      if (!xScale) return;

      ctx.save();

      for (const event of events) {
        const xMs = dateToX(event.date);
        const xPos = xScale.getPixelForValue(xMs);

        if (xPos < chartArea.left || xPos > chartArea.right) continue;

        // Dashed vertical line
        ctx.beginPath();
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(217, 119, 6, 0.7)';
        ctx.moveTo(xPos, chartArea.top);
        ctx.lineTo(xPos, chartArea.bottom);
        ctx.stroke();

        // Rotated label
        ctx.save();
        ctx.translate(xPos - 4, chartArea.top + 6);
        ctx.rotate(-Math.PI / 2);
        ctx.font = '10px Inter, system-ui, sans-serif';
        ctx.fillStyle = '#D97706';
        ctx.textAlign = 'left';
        ctx.fillText(event.label, 0, 0);
        ctx.restore();
      }

      ctx.restore();
    },
  };
}

// ---------------------------------------------------------------------------
// Late-trade warning ring plugin
// ---------------------------------------------------------------------------

/**
 * Draws a second semi-transparent ring around points whose trade was filed
 * late. The `lateMeta` boolean array is stored on each dataset object and
 * indexed in sync with that dataset's `data` array.
 */
const lateRingPlugin: Plugin<'scatter'> = {
  id: 'govguide-late-ring',
  afterDraw(chart) {
    const { ctx, data } = chart;

    ctx.save();

    data.datasets.forEach((dataset, datasetIdx) => {
      const meta = chart.getDatasetMeta(datasetIdx);
      const extended = dataset as TradeDataset;
      const lateMeta = extended.lateMeta;
      if (!lateMeta) return;

      meta.data.forEach((element, pointIdx) => {
        if (!lateMeta[pointIdx]) return;

        const props = element.getProps(['x', 'y'], true) as {
          x: number;
          y: number;
        };

        const baseRadius =
          (element.options as { radius?: number }).radius ?? 6;
        const ringRadius = baseRadius + 5;

        ctx.beginPath();
        ctx.arc(props.x, props.y, ringRadius, 0, Math.PI * 2);
        ctx.strokeStyle = LATE_RING_COLOR;
        ctx.lineWidth = 3;
        ctx.stroke();
      });
    });

    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
// Dataset builder
// ---------------------------------------------------------------------------

function buildDatasets(
  trades: TradeDataPoint[],
  allMidpoints: number[],
  minMid: number,
  maxMid: number,
): TradeDataset[] {
  const groups: Record<
    TradeType,
    { points: EnrichedScatterPoint[]; late: boolean[]; radii: number[] }
  > = {
    purchase: { points: [], late: [], radii: [] },
    sale: { points: [], late: [], radii: [] },
    exchange: { points: [], late: [], radii: [] },
  };

  trades.forEach((trade, idx) => {
    const mid = allMidpoints[idx];
    const radius = scaleRadius(mid, minMid, maxMid);
    const group = groups[trade.tradeType];

    group.points.push({ x: dateToX(trade.date), y: mid, tradeIdx: idx });
    group.late.push((trade.daysLate ?? 0) > 0);
    group.radii.push(radius);
  });

  return (
    Object.entries(groups) as [
      TradeType,
      (typeof groups)[TradeType],
    ][]
  ).map(([type, group]) => {
    const dataset: TradeDataset = {
      label:
        type.charAt(0).toUpperCase() + type.slice(1),
      data: group.points,
      backgroundColor: TRADE_COLORS_ALPHA[type],
      borderColor: TRADE_COLORS[type],
      borderWidth: 1.5,
      pointRadius: group.radii,
      pointHoverRadius: group.radii.map((r) => r + 3),
      lateMeta: group.late,
    };
    return dataset;
  });
}

// ---------------------------------------------------------------------------
// Empty-state sub-component
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex items-center justify-center rounded-lg border border-slate-200 bg-[#F8FAFC] p-10 text-sm text-[#475569]">
      No data available
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inner chart — only rendered when data is non-empty
// ---------------------------------------------------------------------------

interface TradeTimelineInnerProps {
  trades: TradeDataPoint[];
  title?: string;
  events: EventAnnotation[];
}

function TradeTimelineInner({
  trades,
  title,
  events,
}: TradeTimelineInnerProps) {
  const sorted = useMemo(
    () =>
      [...trades].sort(
        (a, b) =>
          new Date(a.date).getTime() - new Date(b.date).getTime(),
      ),
    [trades],
  );

  const allMidpoints = useMemo(
    () => sorted.map((t) => midpoint(t.amountLow, t.amountHigh)),
    [sorted],
  );

  const { minMid, maxMid } = useMemo(() => {
    const min = Math.min(...allMidpoints);
    const max = Math.max(...allMidpoints);
    return { minMid: min, maxMid: max };
  }, [allMidpoints]);

  const datasets = useMemo(
    () => buildDatasets(sorted, allMidpoints, minMid, maxMid),
    [sorted, allMidpoints, minMid, maxMid],
  );

  const eventPlugin = useMemo(
    () => buildEventAnnotationPlugin(events),
    [events],
  );

  const chartData = useMemo(
    () => ({ datasets } as { datasets: TradeDataset[] }),
    [datasets],
  );

  const xBounds = useMemo(() => {
    if (sorted.length === 0) return { min: 0, max: Date.now() };
    const first = dateToX(sorted[0].date);
    const last = dateToX(sorted[sorted.length - 1].date);
    // Pad by 5% of the range, with a minimum of 7 days on each side
    const padding = Math.max(
      (last - first) * 0.05,
      7 * 24 * 60 * 60 * 1000,
    );
    return { min: first - padding, max: last + padding };
  }, [sorted]);

  const hasLate = useMemo(
    () => sorted.some((t) => (t.daysLate ?? 0) > 0),
    [sorted],
  );

  const options = useMemo((): ChartOptions<'scatter'> => {
    return {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          position: 'top',
          labels: {
            usePointStyle: true,
            pointStyle: 'circle',
            color: '#1B2A4A',
            font: { size: 12, family: 'Inter, system-ui, sans-serif' },
          },
        },
        title: title
          ? {
              display: true,
              text: title,
              color: '#1B2A4A',
              font: {
                size: 15,
                weight: 'bold',
                family: 'Inter, system-ui, sans-serif',
              },
              padding: { bottom: 16 },
            }
          : { display: false },
        tooltip: {
          callbacks: {
            title(items) {
              const item = items[0];
              if (!item) return '';
              const pt = item.raw as EnrichedScatterPoint;
              const trade = sorted[pt.tradeIdx];
              return trade ? formatDateLong(trade.date) : '';
            },
            label(item: TooltipItem<'scatter'>) {
              const pt = item.raw as EnrichedScatterPoint;
              const trade = sorted[pt.tradeIdx];
              if (!trade) return '';

              const lines: string[] = [
                ` ${trade.officialName}`,
                ` ${trade.ticker} — ${
                  trade.tradeType.charAt(0).toUpperCase() +
                  trade.tradeType.slice(1)
                }`,
                ` Range: ${formatAmount(trade.amountLow)} – ${formatAmount(
                  trade.amountHigh,
                )}`,
              ];

              if ((trade.daysLate ?? 0) > 0) {
                lines.push(
                  ` Filed ${trade.daysLate} day${
                    trade.daysLate === 1 ? '' : 's'
                  } late`,
                );
              }

              return lines;
            },
          },
          backgroundColor: '#1B2A4A',
          titleColor: '#F8FAFC',
          bodyColor: '#F8FAFC',
          padding: 12,
          cornerRadius: 8,
          titleFont: { size: 12, family: 'Inter, system-ui, sans-serif' },
          bodyFont: { size: 12, family: 'Inter, system-ui, sans-serif' },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: xBounds.min,
          max: xBounds.max,
          grid: { color: '#E2E8F0' },
          ticks: {
            color: '#475569',
            font: { size: 11, family: 'Inter, system-ui, sans-serif' },
            maxTicksLimit: 8,
            callback(value) {
              return new Date(value as number).toLocaleDateString('en-US', {
                month: 'short',
                year: '2-digit',
              });
            },
          },
          title: {
            display: true,
            text: 'Trade Date',
            color: '#475569',
            font: { size: 11, family: 'Inter, system-ui, sans-serif' },
          },
        },
        y: {
          grid: { color: '#E2E8F0' },
          ticks: {
            color: '#475569',
            font: { size: 11, family: 'Inter, system-ui, sans-serif' },
            callback: (value) => formatAmount(value as number),
          },
          title: {
            display: true,
            text: 'Estimated Amount (midpoint)',
            color: '#475569',
            font: { size: 11, family: 'Inter, system-ui, sans-serif' },
          },
        },
      },
    };
  }, [title, sorted, xBounds]);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-6">
      {events.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {events.map((event) => (
            <span
              key={`${event.date}-${event.label}`}
              className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 border border-amber-200"
            >
              <span
                className="inline-block h-2.5 w-0.5 rounded-full bg-amber-500"
                aria-hidden="true"
              />
              {event.label}
            </span>
          ))}
        </div>
      )}
      {hasLate && (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-[#DC2626]">
          <span
            className="inline-block h-3 w-3 rounded-full border-2 border-red-400 bg-transparent"
            aria-hidden="true"
          />
          Outer ring indicates late disclosure filing
        </p>
      )}
      <Scatter
        data={chartData}
        options={options}
        plugins={[lateRingPlugin, eventPlugin]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

const TradeTimeline = React.memo(function TradeTimeline({
  trades,
  title,
  events = [],
}: TradeTimelineProps) {
  if (trades.length === 0) {
    return <EmptyState />;
  }

  return (
    <TradeTimelineInner trades={trades} title={title} events={events} />
  );
});

export type { TradeDataPoint, TradeType, EventAnnotation, TradeTimelineProps };
export default TradeTimeline;
