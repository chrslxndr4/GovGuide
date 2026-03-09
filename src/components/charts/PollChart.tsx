import React, { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  type ChartOptions,
  type TooltipItem,
} from 'chart.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PollDataPoint {
  date: string; // ISO date
  candidates: Record<string, number>; // { "Biden": 45.2, "Trump": 44.1 }
  pollster?: string;
  sampleSize?: number;
}

interface PollChartProps {
  data: PollDataPoint[];
  title?: string;
  candidateColors?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Civic palette defaults, cycled when more candidates than entries exist. */
const DEFAULT_COLORS: string[] = [
  '#2563EB', // civic-blue
  '#DC2626', // civic-red
  '#D97706', // civic-gold
  '#1B2A4A', // civic-navy
  '#475569', // civic-slate
  '#059669', // emerald-600
  '#7C3AED', // violet-600
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a simple N-point moving average over an ordered array of values.
 * Points near the edges use whatever samples are available (no padding).
 */
function movingAverage(values: number[], window: number): number[] {
  return values.map((_, idx) => {
    const half = Math.floor(window / 2);
    const start = Math.max(0, idx - half);
    const end = Math.min(values.length - 1, idx + half);
    const slice = values.slice(start, end + 1);
    const sum = slice.reduce((acc, v) => acc + v, 0);
    return Math.round((sum / slice.length) * 10) / 10;
  });
}

/** Sort poll data chronologically and extract the full candidate name list. */
function preparePollData(data: PollDataPoint[]): {
  sorted: PollDataPoint[];
  candidates: string[];
  labels: string[];
} {
  const sorted = [...data].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  const candidateSet = new Set<string>();
  for (const point of sorted) {
    for (const name of Object.keys(point.candidates)) {
      candidateSet.add(name);
    }
  }

  const candidates = Array.from(candidateSet);
  const labels = sorted.map((p) =>
    new Date(p.date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }),
  );

  return { sorted, candidates, labels };
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

interface PollChartInnerProps {
  data: PollDataPoint[];
  title?: string;
  candidateColors: Record<string, string>;
}

function PollChartInner({ data, title, candidateColors }: PollChartInnerProps) {
  const { sorted, candidates, labels } = useMemo(
    () => preparePollData(data),
    [data],
  );

  const datasets = useMemo(() => {
    const MOVING_AVG_WINDOW = Math.max(3, Math.round(sorted.length / 5));

    return candidates.flatMap((candidate, candidateIdx) => {
      const color =
        candidateColors[candidate] ??
        DEFAULT_COLORS[candidateIdx % DEFAULT_COLORS.length];

      const rawValues: (number | null)[] = sorted.map(
        (p) => p.candidates[candidate] ?? null,
      );

      const nonNullValues = rawValues.filter(
        (v): v is number => v !== null,
      );
      const trendValues = movingAverage(nonNullValues, MOVING_AVG_WINDOW);

      // Reconstruct full-length trend array preserving null gaps
      let trendIdx = 0;
      const trend: (number | null)[] = rawValues.map((v) =>
        v !== null ? (trendValues[trendIdx++] ?? null) : null,
      );

      return [
        // Individual poll scatter points
        {
          label: `${candidate} (polls)`,
          data: rawValues,
          borderColor: color,
          backgroundColor: color,
          pointRadius: 4,
          pointHoverRadius: 6,
          showLine: false,
          spanGaps: false,
          order: 2,
        },
        // Moving average trend line
        {
          label: `${candidate} (trend)`,
          data: trend,
          borderColor: color,
          backgroundColor: `${color}20`,
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 0,
          tension: 0.4,
          spanGaps: true,
          order: 1,
        },
      ];
    });
  }, [sorted, candidates, candidateColors]);

  const chartData = useMemo(
    () => ({ labels, datasets }),
    [labels, datasets],
  );

  const options = useMemo((): ChartOptions<'line'> => {
    return {
      responsive: true,
      maintainAspectRatio: true,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            color: '#1B2A4A',
            font: { size: 12, family: 'Inter, system-ui, sans-serif' },
            usePointStyle: true,
            pointStyle: 'line',
            generateLabels: (chart) => {
              return chart.data.datasets
                .filter((ds) => ds.label?.includes('(trend)'))
                .map((ds) => ({
                  text: ds.label?.replace(' (trend)', '') ?? '',
                  fillStyle: ds.borderColor as string,
                  strokeStyle: ds.borderColor as string,
                  lineWidth: 2,
                  hidden: false,
                  datasetIndex: chart.data.datasets.indexOf(ds),
                  pointStyle: 'line' as const,
                }));
            },
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
              const idx = items[0]?.dataIndex ?? 0;
              const point = sorted[idx];
              if (!point) return '';
              const dateStr = new Date(point.date).toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              });
              const parts = [dateStr];
              if (point.pollster) parts.push(`Pollster: ${point.pollster}`);
              if (point.sampleSize)
                parts.push(`n = ${point.sampleSize.toLocaleString()}`);
              return parts;
            },
            label(item: TooltipItem<'line'>) {
              if (item.dataset.label?.includes('(trend)')) return '';
              const candidate =
                item.dataset.label?.replace(' (polls)', '') ?? '';
              const value = item.parsed.y;
              return value !== null
                ? ` ${candidate}: ${value.toFixed(1)}%`
                : '';
            },
          },
          filter(item: { dataset: { label?: string } }) {
            return item.dataset.label?.includes('(polls)') ?? false;
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
          grid: { color: '#E2E8F0' },
          ticks: {
            color: '#475569',
            font: { size: 11, family: 'Inter, system-ui, sans-serif' },
            maxTicksLimit: 8,
            maxRotation: 30,
          },
        },
        y: {
          min: 0,
          max: 100,
          grid: { color: '#E2E8F0' },
          ticks: {
            color: '#475569',
            font: { size: 11, family: 'Inter, system-ui, sans-serif' },
            callback: (value) => `${value}%`,
          },
          title: {
            display: true,
            text: 'Support (%)',
            color: '#475569',
            font: { size: 11, family: 'Inter, system-ui, sans-serif' },
          },
        },
      },
    };
  }, [title, sorted]);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-6">
      <Line data={chartData} options={options} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

const PollChart = React.memo(function PollChart({
  data,
  title,
  candidateColors = {},
}: PollChartProps) {
  if (data.length === 0) {
    return <EmptyState />;
  }

  return (
    <PollChartInner data={data} title={title} candidateColors={candidateColors} />
  );
});

export type { PollDataPoint, PollChartProps };
export default PollChart;
