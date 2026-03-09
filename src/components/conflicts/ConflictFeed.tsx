import { useState, useEffect, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AlertType =
  | 'all'
  | 'donor_vote'
  | 'stock_committee'
  | 'trade_timing'
  | 'judicial_financial'
  | 'prediction_anomaly';

interface ConflictAlert {
  id: string;
  alert_type: Exclude<AlertType, 'all'>;
  severity: number;
  description: string;
  evidence_summary: string;
  detected_at: string;
  official_id: string | null;
  official_name: string | null;
  official_slug: string | null;
  source_url: string | null;
  tags: string[];
}

interface Pagination {
  limit: number;
  offset: number;
  total: number;
  has_more: boolean;
}

interface ApiResponse {
  alerts: ConflictAlert[];
  pagination: Pagination;
}

interface FilterState {
  alertType: AlertType;
  minSeverity: number;
}

const INITIAL_FILTERS: FilterState = {
  alertType: 'all',
  minSeverity: 1,
};

const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  all: 'All Types',
  donor_vote: 'Donor / Vote',
  stock_committee: 'Stock / Committee',
  trade_timing: 'Trade Timing',
  judicial_financial: 'Judicial Financial',
  prediction_anomaly: 'Prediction Anomaly',
};

const ALERT_TYPE_BADGE: Record<Exclude<AlertType, 'all'>, string> = {
  donor_vote: 'bg-purple-100 text-purple-800 border-purple-200',
  stock_committee: 'bg-amber-100 text-amber-800 border-amber-200',
  trade_timing: 'bg-orange-100 text-orange-800 border-orange-200',
  judicial_financial: 'bg-blue-100 text-blue-800 border-blue-200',
  prediction_anomaly: 'bg-pink-100 text-pink-800 border-pink-200',
};

const PAGE_LIMIT = 20;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function severityLabel(s: number): string {
  if (s >= 8) return 'Critical';
  if (s >= 6) return 'High';
  if (s >= 4) return 'Medium';
  return 'Low';
}

function severityBadgeClass(s: number): string {
  if (s >= 8) return 'bg-red-600 text-white';
  if (s >= 6) return 'bg-orange-500 text-white';
  if (s >= 4) return 'bg-amber-400 text-amber-900';
  return 'bg-blue-500 text-white';
}

function severityBarClass(s: number): string {
  if (s >= 8) return 'bg-red-500';
  if (s >= 6) return 'bg-orange-400';
  if (s >= 4) return 'bg-amber-400';
  return 'bg-blue-400';
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SeverityBadge({ severity }: { severity: number }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold tabular-nums ${severityBadgeClass(severity)}`}
      aria-label={`Severity ${severity} — ${severityLabel(severity)}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full bg-current opacity-70`}
        aria-hidden="true"
      />
      {severity}/10 {severityLabel(severity)}
    </span>
  );
}

function AlertTypeBadge({ type }: { type: Exclude<AlertType, 'all'> }) {
  const cls = ALERT_TYPE_BADGE[type] ?? 'bg-slate-100 text-slate-700 border-slate-200';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${cls}`}>
      {ALERT_TYPE_LABELS[type]}
    </span>
  );
}

function SeverityBar({ severity }: { severity: number }) {
  const pct = (severity / 10) * 100;
  return (
    <div
      className="w-16 h-1.5 bg-slate-200 rounded-full overflow-hidden"
      aria-hidden="true"
      title={`Severity ${severity}/10`}
    >
      <div
        className={`h-full rounded-full ${severityBarClass(severity)}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function AlertCard({ alert }: { alert: ConflictAlert }) {
  const borderAccent =
    alert.severity >= 8
      ? 'border-l-red-500'
      : alert.severity >= 6
      ? 'border-l-orange-400'
      : alert.severity >= 4
      ? 'border-l-amber-400'
      : 'border-l-blue-400';

  return (
    <article
      className={`bg-white border border-slate-200 border-l-4 ${borderAccent} rounded-lg rounded-l-none p-5 hover:shadow-sm transition-shadow`}
    >
      {/* Header row */}
      <div className="flex flex-wrap items-start gap-2 mb-3">
        <SeverityBadge severity={alert.severity} />
        <AlertTypeBadge type={alert.alert_type} />
        <SeverityBar severity={alert.severity} />
        <div className="ml-auto flex items-center gap-1.5">
          <time
            dateTime={alert.detected_at}
            className="text-xs font-mono text-slate-400"
          >
            {formatDate(alert.detected_at)}
          </time>
        </div>
      </div>

      {/* Description */}
      <p className="text-sm font-medium text-civic-navy leading-snug mb-2">
        {alert.description}
      </p>

      {/* Official link if available */}
      {alert.official_name && alert.official_slug && (
        <p className="text-xs text-civic-slate mb-2">
          Re:{' '}
          <a
            href={`/officials/${alert.official_slug}`}
            className="text-civic-blue hover:underline font-medium"
          >
            {alert.official_name}
          </a>
        </p>
      )}

      {/* Evidence summary */}
      <div className="bg-slate-50 border border-slate-100 rounded p-3 mt-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">
          Evidence Summary
        </p>
        <p className="text-sm text-slate-700 leading-relaxed">{alert.evidence_summary}</p>
      </div>

      {/* Footer: tags + source */}
      {(alert.tags.length > 0 || alert.source_url) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {alert.tags.map(tag => (
            <span
              key={tag}
              className="text-[11px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded font-mono"
            >
              #{tag}
            </span>
          ))}
          {alert.source_url && (
            <a
              href={alert.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-xs text-civic-blue hover:underline flex items-center gap-1"
            >
              Source
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="w-3 h-3"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5z"
                  clipRule="evenodd"
                />
                <path
                  fillRule="evenodd"
                  d="M6.194 12.753a.75.75 0 001.06.053L16.5 4.44v2.81a.75.75 0 001.5 0v-4.5a.75.75 0 00-.75-.75h-4.5a.75.75 0 000 1.5h2.553l-9.056 8.194a.75.75 0 00-.053 1.06z"
                  clipRule="evenodd"
                />
              </svg>
            </a>
          )}
        </div>
      )}
    </article>
  );
}

function AlertCardSkeleton() {
  return (
    <div className="bg-white border border-slate-200 border-l-4 border-l-slate-200 rounded-lg rounded-l-none p-5 animate-pulse">
      <div className="flex gap-2 mb-3">
        <div className="h-6 w-28 bg-slate-100 rounded-full" />
        <div className="h-6 w-24 bg-slate-100 rounded" />
      </div>
      <div className="h-4 bg-slate-100 rounded w-3/4 mb-2" />
      <div className="h-4 bg-slate-100 rounded w-1/2 mb-3" />
      <div className="bg-slate-50 border border-slate-100 rounded p-3">
        <div className="h-3 bg-slate-100 rounded w-1/3 mb-2" />
        <div className="h-3 bg-slate-100 rounded w-full mb-1" />
        <div className="h-3 bg-slate-100 rounded w-5/6" />
      </div>
    </div>
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="py-16 text-center">
      <div className="text-4xl mb-4" aria-hidden="true">
        &#128270;
      </div>
      <p className="text-civic-slate font-medium text-base">
        {hasFilters ? 'No alerts match your filters.' : 'No conflict alerts found.'}
      </p>
      {hasFilters && (
        <p className="text-sm text-slate-400 mt-1">
          Try adjusting the type or severity threshold.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ConflictFeed() {
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
  const [alerts, setAlerts] = useState<ConflictAlert[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    limit: PAGE_LIMIT,
    offset: 0,
    total: 0,
    has_more: false,
  });
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const buildParams = useCallback(
    (overrideOffset?: number): URLSearchParams => {
      const params = new URLSearchParams();
      if (filters.alertType !== 'all') params.set('type', filters.alertType);
      if (filters.minSeverity > 1) params.set('min_severity', String(filters.minSeverity));
      params.set('limit', String(PAGE_LIMIT));
      params.set('offset', String(overrideOffset ?? offset));
      return params;
    },
    [filters, offset]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function fetchAlerts() {
      try {
        const res = await fetch(`/api/conflicts?${buildParams()}`);
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const data: ApiResponse = await res.json();
        if (cancelled) return;
        setAlerts(data.alerts ?? []);
        setPagination(data.pagination);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load alerts');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchAlerts();
    return () => {
      cancelled = true;
    };
  }, [buildParams]);

  function handleFilterChange(partial: Partial<FilterState>) {
    setFilters(f => ({ ...f, ...partial }));
    setOffset(0);
  }

  function handlePrevPage() {
    setOffset(o => Math.max(0, o - PAGE_LIMIT));
  }

  function handleNextPage() {
    setOffset(o => o + PAGE_LIMIT);
  }

  const hasActiveFilters =
    filters.alertType !== 'all' || filters.minSeverity > 1;

  const currentPage = Math.floor(offset / PAGE_LIMIT) + 1;
  const totalPages = Math.ceil(pagination.total / PAGE_LIMIT);

  return (
    <div className="flex flex-col gap-6">

      {/* RSS link + meta bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-civic-slate">
          {!loading && (
            <>
              <span className="font-semibold text-civic-navy">
                {pagination.total.toLocaleString()}
              </span>{' '}
              conflict alert{pagination.total !== 1 ? 's' : ''} detected
            </>
          )}
        </p>
        <a
          href="/api/feeds/all"
          className="inline-flex items-center gap-1.5 text-sm text-civic-blue hover:underline font-medium"
          aria-label="Subscribe to RSS feed of all conflict alerts"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4 text-orange-500"
            aria-hidden="true"
          >
            <path d="M3.75 3a.75.75 0 00-.75.75v.5c0 .414.336.75.75.75H4c6.075 0 11 4.925 11 11v.25c0 .414.336.75.75.75h.5a.75.75 0 00.75-.75V16C17 8.82 11.18 3 4 3h-.25z" />
            <path d="M3 8.75A.75.75 0 013.75 8H4a8 8 0 018 8v.25a.75.75 0 01-.75.75h-.5a.75.75 0 01-.75-.75V16a6 6 0 00-6-6h-.25A.75.75 0 013 9.25v-.5zM7 15a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
          RSS Feed
        </a>
      </div>

      {/* Filter controls */}
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <div className="flex flex-wrap gap-4 items-end">

          {/* Alert type filter */}
          <div className="flex flex-col gap-1 min-w-[180px]">
            <label htmlFor="filter-alert-type" className="text-xs font-medium text-slate-600">
              Alert Type
            </label>
            <select
              id="filter-alert-type"
              value={filters.alertType}
              onChange={e => handleFilterChange({ alertType: e.target.value as AlertType })}
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
            >
              {(Object.entries(ALERT_TYPE_LABELS) as [AlertType, string][]).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {/* Min severity slider */}
          <div className="flex flex-col gap-1 min-w-[200px]">
            <label htmlFor="filter-min-severity" className="text-xs font-medium text-slate-600">
              Min Severity:{' '}
              <span
                className={`font-bold ${
                  filters.minSeverity >= 8
                    ? 'text-red-600'
                    : filters.minSeverity >= 6
                    ? 'text-orange-500'
                    : filters.minSeverity >= 4
                    ? 'text-amber-600'
                    : 'text-blue-600'
                }`}
              >
                {filters.minSeverity}/10
              </span>
            </label>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">1</span>
              <input
                id="filter-min-severity"
                type="range"
                min={1}
                max={10}
                step={1}
                value={filters.minSeverity}
                onChange={e => handleFilterChange({ minSeverity: Number(e.target.value) })}
                className="flex-1 accent-civic-blue"
              />
              <span className="text-xs text-slate-400">10</span>
            </div>
          </div>

          {/* Severity legend */}
          <div className="flex flex-wrap gap-3 self-end pb-[9px]">
            {[
              { label: 'Low (1–3)', cls: 'bg-blue-500' },
              { label: 'Medium (4–5)', cls: 'bg-amber-400' },
              { label: 'High (6–7)', cls: 'bg-orange-400' },
              { label: 'Critical (8–10)', cls: 'bg-red-500' },
            ].map(({ label, cls }) => (
              <span key={label} className="flex items-center gap-1.5 text-xs text-slate-500">
                <span className={`w-2.5 h-2.5 rounded-full ${cls} inline-block`} aria-hidden="true" />
                {label}
              </span>
            ))}
          </div>

          {/* Reset */}
          {hasActiveFilters && (
            <button
              onClick={() => handleFilterChange({ alertType: 'all', minSeverity: 1 })}
              className="self-end border border-slate-300 text-slate-600 px-4 py-[7px] rounded-md text-sm font-medium hover:bg-slate-50 transition-colors focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 text-civic-red rounded-lg px-4 py-3 text-sm"
        >
          Failed to load conflict alerts: {error}
        </div>
      )}

      {/* Feed */}
      <div className="flex flex-col gap-4">
        {loading ? (
          Array.from({ length: 6 }).map((_, i) => <AlertCardSkeleton key={i} />)
        ) : alerts.length === 0 ? (
          <EmptyState hasFilters={hasActiveFilters} />
        ) : (
          alerts.map(alert => <AlertCard key={alert.id} alert={alert} />)
        )}
      </div>

      {/* Pagination */}
      {!loading && totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <p className="text-xs text-civic-slate">
            Page {currentPage} of {totalPages} ({pagination.total.toLocaleString()} alerts)
          </p>
          <div className="flex gap-2">
            <button
              onClick={handlePrevPage}
              disabled={offset === 0}
              className="px-3 py-1.5 text-xs border border-slate-300 rounded-md disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 transition-colors focus:outline-none focus:ring-2 focus:ring-civic-blue focus:ring-offset-1"
            >
              Previous
            </button>
            <button
              onClick={handleNextPage}
              disabled={!pagination.has_more}
              className="px-3 py-1.5 text-xs border border-slate-300 rounded-md disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 transition-colors focus:outline-none focus:ring-2 focus:ring-civic-blue focus:ring-offset-1"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Disclosure */}
      <p className="text-xs text-slate-400">
        Conflict alerts are algorithmically generated from public disclosure data including FEC filings,
        STOCK Act reports, court financial disclosures, and prediction market feeds. Alerts represent
        potential conflicts of interest and do not constitute proof of wrongdoing.
      </p>
    </div>
  );
}
