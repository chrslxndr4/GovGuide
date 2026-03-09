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
  type Plugin,
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

interface PredictionDataPoint {
  timestamp: string; // ISO datetime
  probability: number; // 0-1
  volume?: number;
}

interface EventAnnotation {
  date: string;
  label: string;
}

interface PredictionChartProps {
  data: PredictionDataPoint[];
  title?: string;
  events?: EventAnnotation[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CIVIC_BLUE = '#2563EB';
const CIVIC_BLUE_AREA = 'rgba(37, 99, 235, 0.15)';
const CIVIC_GOLD_EVENT_COLOR = 'rgba(217, 119, 6, 0.7)';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatTimestampLong(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Returns the label-axis index whose source timestamp is closest to the given
 * ISO date string.
 */
function findClosestLabelIndex(
  isoDate: string,
  sortedTimestamps: string[],
): number {
  const target = new Date(isoDate).getTime();
  let closest = 0;
  let closestDelta = Infinity;

  for (let i = 0; i < sortedTimestamps.length; i++) {
    const delta = Math.abs(
      new Date(sortedTimestamps[i]).getTime() - target,
    );
    if (delta < closestDelta) {
      closestDelta = delta;
      closest = i;
    }
  }

  return closest;
}

// ---------------------------------------------------------------------------
// Event annotation plugin
// ---------------------------------------------------------------------------

/**
 * Inline Chart.js plugin that draws vertical dashed lines and rotated labels
 * for event annotations without requiring an external annotation library.
 */
function buildEventAnnotationPlugin(
  events: EventAnnotation[],
  sortedTimestamps: string[],
): Plugin<'line'> {
  return {
    id: 'govguide-event-annotations',
    afterDraw(chart) {
      if (events.length === 0) return;

      const { ctx, chartArea, scales } = chart;
      const xScale = scales['x'];
      if (!xScale) return;

      ctx.save();

      for (const event of events) {
        const labelIdx = findClosestLabelIndex(
          event.date,
          sortedTimestamps,
        );
        const xPos = xScale.getPixelForValue(labelIdx);

        if (xPos < chartArea.left || xPos > chartArea.right) continue;

        // Dashed vertical line
        ctx.beginPath();
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = CIVIC_GOLD_EVENT_COLOR;
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

interface PredictionChartInnerProps {
  data: PredictionDataPoint[];
  title?: string;
  events: EventAnnotation[];
}

function PredictionChartInner({
  data,
  title,
  events,
}: PredictionChartInnerProps) {
  const sorted = useMemo(
    () =>
      [...data].sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      ),
    [data],
  );

  const sortedTimestamps = useMemo(
    () => sorted.map((p) => p.timestamp),
    [sorted],
  );

  const labels = useMemo(
    () => sorted.map((p) => formatTimestamp(p.timestamp)),
    [sorted],
  );

  // Convert 0-1 probability to 0-100 percentage with one decimal place
  const probabilityValues = useMemo(
    () => sorted.map((p) => Math.round(p.probability * 1000) / 10),
    [sorted],
  );

  const eventPlugin = useMemo(
    () => buildEventAnnotationPlugin(events, sortedTimestamps),
    [events, sortedTimestamps],
  );

  const chartData = useMemo(
    () => ({
      labels,
      datasets: [
        {
          label: 'Win Probability',
          data: probabilityValues,
          borderColor: CIVIC_BLUE,
          backgroundColor: CIVIC_BLUE_AREA,
          borderWidth: 2.5,
          pointRadius: sorted.length > 60 ? 0 : 3,
          pointHoverRadius: 5,
          pointBackgroundColor: CIVIC_BLUE,
          tension: 0.35,
          fill: true,
          spanGaps: false,
        },
      ],
    }),
    [labels, probabilityValues, sorted.length],
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
          display: false,
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
              return point ? formatTimestampLong(point.timestamp) : '';
            },
            label(item: TooltipItem<'line'>) {
              return ` Probability: ${(item.parsed.y ?? 0).toFixed(1)}%`;
            },
            afterLabel(item: TooltipItem<'line'>) {
              const point = sorted[item.dataIndex];
              if (point?.volume !== undefined) {
                return ` Volume: $${point.volume.toLocaleString()}`;
              }
              return '';
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
            text: 'Win Probability (%)',
            color: '#475569',
            font: { size: 11, family: 'Inter, system-ui, sans-serif' },
          },
        },
      },
    };
  }, [title, sorted]);

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
      <Line data={chartData} options={options} plugins={[eventPlugin]} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

const PredictionChart = React.memo(function PredictionChart({
  data,
  title,
  events = [],
}: PredictionChartProps) {
  if (data.length === 0) {
    return <EmptyState />;
  }

  return (
    <PredictionChartInner data={data} title={title} events={events} />
  );
});

export type { PredictionDataPoint, EventAnnotation, PredictionChartProps };
export default PredictionChart;
