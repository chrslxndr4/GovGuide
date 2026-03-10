import { useEffect, useRef, useState } from 'react';
import {
  Chart as ChartJS,
  LinearScale,
  PointElement,
  Tooltip,
  Legend,
} from 'chart.js';
import { Scatter } from 'react-chartjs-2';

ChartJS.register(LinearScale, PointElement, Tooltip, Legend);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AlertType =
  | 'donor_vote'
  | 'stock_committee'
  | 'trade_timing'
  | 'judicial_financial'
  | 'prediction_anomaly'
  | 'prediction_insider'
  | 'dark_money_chain'
  | 'contract_donor'
  | 'revolving_door';

interface TimelinePoint {
  id: string;
  alert_type: AlertType;
  severity: number;
  description: string;
  official_name: string | null;
  detected_at: string;
}

interface TimelineApiResponse {
  points: TimelinePoint[];
}

interface ConflictTimelineProps {
  dateFrom?: string;
  dateTo?: string;
  alertType?: string;
}

// ---------------------------------------------------------------------------
// Color config — mirrors ALERT_TYPE_BADGE colors from the feed
// ---------------------------------------------------------------------------

const ALERT_TYPE_COLORS: Record<AlertType, { bg: string; border: string; label: string }> = {
  donor_vote:          { bg: 'rgba(168, 85, 247, 0.7)',  border: 'rgba(168, 85, 247, 1)',  label: 'Donor / Vote' },
  stock_committee:     { bg: 'rgba(245, 158, 11, 0.7)',  border: 'rgba(245, 158, 11, 1)',  label: 'Stock / Committee' },
  trade_timing:        { bg: 'rgba(249, 115, 22, 0.7)',  border: 'rgba(249, 115, 22, 1)',  label: 'Trade Timing' },
  judicial_financial:  { bg: 'rgba(59, 130, 246, 0.7)',  border: 'rgba(59, 130, 246, 1)',  label: 'Judicial Financial' },
  prediction_anomaly:  { bg: 'rgba(236, 72, 153, 0.7)',  border: 'rgba(236, 72, 153, 1)',  label: 'Prediction Anomaly' },
  prediction_insider:  { bg: 'rgba(220, 38, 38, 0.7)',   border: 'rgba(220, 38, 38, 1)',   label: 'Prediction Insider' },
  dark_money_chain:    { bg: 'rgba(75, 85, 99, 0.7)',    border: 'rgba(75, 85, 99, 1)',    label: 'Dark Money Chain' },
  contract_donor:      { bg: 'rgba(16, 185, 129, 0.7)',  border: 'rgba(16, 185, 129, 1)',  label: 'Contract / Donor' },
  revolving_door:      { bg: 'rgba(99, 102, 241, 0.7)',  border: 'rgba(99, 102, 241, 1)',  label: 'Revolving Door' },
};

const FALLBACK_COLOR = { bg: 'rgba(100, 116, 139, 0.7)', border: 'rgba(100, 116, 139, 1)', label: 'Unknown' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert ISO date string to a numeric day-offset from the earliest date. */
function datesToNumericAxis(points: TimelinePoint[]): { minTs: number; maxTs: number } {
  if (points.length === 0) return { minTs: 0, maxTs: 1 };
  const timestamps = points.map((p) => new Date(p.detected_at).getTime());
  return {
    minTs: Math.min(...timestamps),
    maxTs: Math.max(...timestamps),
  };
}

/** Format a timestamp (ms) as a short date string for axis labels. */
function formatTimestampLabel(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatTooltipDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Point radius: scale severity 1-10 to radius 4-18px. */
function severityToRadius(severity: number): number {
  return 4 + ((severity - 1) / 9) * 14;
}

// ---------------------------------------------------------------------------
// Build Chart.js datasets — one dataset per alert type so legend works
// ---------------------------------------------------------------------------

interface ChartDataPoint {
  x: number;
  y: number;
  _meta: TimelinePoint;
}

function buildDatasets(points: TimelinePoint[], minTs: number) {
  const byType = new Map<AlertType, ChartDataPoint[]>();

  for (const p of points) {
    const xMs = new Date(p.detected_at).getTime();
    // x = days offset from earliest date, for a readable linear axis
    const x = (xMs - minTs) / (1000 * 60 * 60 * 24);
    const y = p.severity;
    const bucket = byType.get(p.alert_type) ?? [];
    bucket.push({ x, y, _meta: p });
    byType.set(p.alert_type, bucket);
  }

  return Array.from(byType.entries()).map(([type, data]) => {
    const color = ALERT_TYPE_COLORS[type] ?? FALLBACK_COLOR;
    return {
      label: color.label,
      data,
      backgroundColor: color.bg,
      borderColor: color.border,
      borderWidth: 1.5,
      pointRadius: data.map((point) => severityToRadius(point._meta.severity)),
      pointHoverRadius: data.map((point) => severityToRadius(point._meta.severity) + 3),
    };
  });
}

// ---------------------------------------------------------------------------
// Loading / Error / Empty states
// ---------------------------------------------------------------------------

function TimelineSkeleton() {
  return (
    <div
      className="w-full h-[400px] bg-slate-50 border border-slate-200 rounded-lg animate-pulse flex items-center justify-center"
      aria-busy="true"
      aria-label="Loading timeline chart"
    >
      <span className="text-slate-400 text-sm font-medium">Loading timeline...</span>
    </div>
  );
}

function TimelineError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="w-full bg-red-50 border border-red-200 rounded-lg p-6 text-center" role="alert">
      <p className="text-sm font-semibold text-red-700 mb-1">Failed to load timeline</p>
      <p className="text-sm text-red-600 mb-3">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="px-4 py-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 transition-colors"
      >
        Retry
      </button>
    </div>
  );
}

function TimelineEmpty() {
  return (
    <div className="w-full bg-slate-50 border border-slate-200 rounded-lg p-10 text-center">
      <div className="text-3xl mb-3 select-none" aria-hidden="true">&#128202;</div>
      <p className="text-sm font-semibold text-[#1B2A4A] mb-1">No timeline data</p>
      <p className="text-sm text-[#475569]">
        No conflict alerts match the current filters in the selected date range.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ConflictTimeline({ dateFrom, dateTo, alertType }: ConflictTimelineProps) {
  const [points, setPoints] = useState<TimelinePoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  function buildUrl(): string {
    const params = new URLSearchParams({ view: 'timeline' });
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    if (alertType) params.set('type', alertType);
    return `/api/conflicts?${params.toString()}`;
  }

  async function fetchTimeline() {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(buildUrl(), { signal: abortRef.current.signal });
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data: TimelineApiResponse = await res.json() as TimelineApiResponse;
      setPoints(data.points ?? []);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Failed to load timeline data');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchTimeline();
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo, alertType]);

  if (loading) return <TimelineSkeleton />;
  if (error) return <TimelineError message={error} onRetry={fetchTimeline} />;
  if (points.length === 0) return <TimelineEmpty />;

  const { minTs, maxTs } = datesToNumericAxis(points);
  const datasets = buildDatasets(points, minTs);

  // Build readable tick labels at minTs and maxTs
  const dayRange = (maxTs - minTs) / (1000 * 60 * 60 * 24);
  const labelStart = formatTimestampLabel(minTs);
  const labelEnd = formatTimestampLabel(maxTs);

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 400 },
    plugins: {
      legend: {
        position: 'bottom' as const,
        labels: {
          boxWidth: 12,
          padding: 16,
          font: { size: 11 },
        },
      },
      tooltip: {
        callbacks: {
          label(context: { raw: unknown }) {
            const raw = context.raw as ChartDataPoint;
            const meta = raw._meta;
            const dateLabel = formatTooltipDate(meta.detected_at);
            const official = meta.official_name ? ` — ${meta.official_name}` : '';
            return [
              `Severity: ${meta.severity}/10`,
              `Date: ${dateLabel}${official}`,
              `${meta.description}`,
            ];
          },
          title() {
            return '';
          },
        },
        displayColors: true,
        padding: 10,
        boxPadding: 4,
      },
    },
    scales: {
      x: {
        type: 'linear' as const,
        title: {
          display: true,
          text: `Date (days — ${labelStart} to ${labelEnd})`,
          font: { size: 11 },
          color: '#475569',
        },
        min: 0,
        max: Math.max(dayRange, 1),
        ticks: {
          maxTicksLimit: 8,
          callback(value: number | string) {
            const days = typeof value === 'string' ? parseFloat(value) : value;
            const ts = minTs + days * 24 * 60 * 60 * 1000;
            return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          },
          font: { size: 11 },
          color: '#64748b',
        },
        grid: { color: 'rgba(226, 232, 240, 0.8)' },
      },
      y: {
        title: {
          display: true,
          text: 'Severity Score (0–10)',
          font: { size: 11 },
          color: '#475569',
        },
        min: 0,
        max: 10,
        ticks: {
          stepSize: 2,
          font: { size: 11 },
          color: '#64748b',
        },
        grid: { color: 'rgba(226, 232, 240, 0.8)' },
      },
    },
  };

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-[#1B2A4A]">Conflict Timeline</h3>
          <p className="text-xs text-[#475569] mt-0.5">
            {points.length} alert{points.length !== 1 ? 's' : ''} — point size reflects severity
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-[#475569]">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-blue-400 inline-block" aria-hidden="true" />
            Small = Low
          </span>
          <span className="flex items-center gap-1">
            <span className="w-4 h-4 rounded-full bg-red-500 inline-block" aria-hidden="true" />
            Large = Critical
          </span>
        </div>
      </div>
      <div className="relative h-[380px]">
        <Scatter data={{ datasets }} options={chartOptions} aria-label="Conflict alerts timeline scatter chart" />
      </div>
    </div>
  );
}
