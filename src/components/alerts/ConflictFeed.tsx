import { useState, useEffect, useCallback } from 'react';
import ConflictCard from './ConflictCard';
import type { ConflictAlert } from './ConflictCard';

interface FeedStats {
  total: number;
  critical: number;
  active: number;
}

interface AlertsApiResponse {
  alerts: ConflictAlert[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

interface FilterState {
  alertType: string;
  minSeverity: number;
  dateFrom: string;
  dateTo: string;
  sortBy: 'severity' | 'date';
}

interface ConflictFeedProps {
  initialAlerts?: ConflictAlert[];
  apiEndpoint?: string;
}

const ALERT_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All Types' },
  { value: 'donor_vote', label: 'Donor-Vote Conflict' },
  { value: 'stock_committee', label: 'Stock-Committee Conflict' },
  { value: 'trade_timing', label: 'Trade Timing' },
  { value: 'judicial_financial', label: 'Judicial Financial' },
  { value: 'contract_donor', label: 'Contract-Donor Conflict' },
  { value: 'revolving_door', label: 'Revolving Door' },
  { value: 'dark_money_chain', label: 'Dark Money' },
  { value: 'prediction_insider', label: 'Insider Trading' },
];

const PAGE_SIZE = 10;

function computeStats(alerts: ConflictAlert[]): FeedStats {
  return {
    total: alerts.length,
    critical: alerts.filter((a) => a.severity_score >= 8).length,
    active: alerts.filter((a) => a.status === 'active').length,
  };
}

function buildQueryString(filters: FilterState, page: number): string {
  const params = new URLSearchParams();
  if (filters.alertType) params.set('alert_type', filters.alertType);
  if (filters.minSeverity > 0) params.set('min_severity', String(filters.minSeverity));
  if (filters.dateFrom) params.set('date_from', filters.dateFrom);
  if (filters.dateTo) params.set('date_to', filters.dateTo);
  params.set('sort_by', filters.sortBy);
  params.set('page', String(page));
  params.set('page_size', String(PAGE_SIZE));
  return params.toString();
}

function StatCard({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 px-5 py-4 flex flex-col gap-0.5">
      <span
        className={`text-2xl font-bold font-mono ${highlight ? 'text-[#DC2626]' : 'text-[#1B2A4A]'}`}
      >
        {value.toLocaleString()}
      </span>
      <span className="text-xs text-[#475569] uppercase tracking-wider font-medium">{label}</span>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-12" aria-live="polite" aria-busy="true">
      <span
        className="inline-block w-8 h-8 rounded-full border-4 border-slate-200 border-t-[#2563EB] animate-spin"
        role="status"
        aria-label="Loading alerts"
      />
    </div>
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div className="bg-[#F8FAFC] border border-slate-200 rounded-lg p-10 text-center">
      <div className="text-4xl mb-3 select-none" aria-hidden="true">&#128269;</div>
      <p className="text-base font-semibold text-[#1B2A4A] mb-1">No alerts found</p>
      <p className="text-sm text-[#475569] max-w-sm mx-auto">
        {hasFilters
          ? 'No conflict alerts match your current filters. Try adjusting the severity threshold or date range.'
          : 'There are no conflict alerts to display at this time.'}
      </p>
    </div>
  );
}

export default function ConflictFeed({
  initialAlerts = [],
  apiEndpoint = '/api/conflicts',
}: ConflictFeedProps) {
  const [alerts, setAlerts] = useState<ConflictAlert[]>(initialAlerts);
  const [stats, setStats] = useState<FeedStats>(computeStats(initialAlerts));
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(initialAlerts.length === 0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>({
    alertType: '',
    minSeverity: 0,
    dateFrom: '',
    dateTo: '',
    sortBy: 'severity',
  });

  const hasActiveFilters =
    filters.alertType !== '' ||
    filters.minSeverity > 0 ||
    filters.dateFrom !== '' ||
    filters.dateTo !== '';

  const fetchAlerts = useCallback(
    async (currentFilters: FilterState, currentPage: number, append: boolean) => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setError(null);
      }

      try {
        const qs = buildQueryString(currentFilters, currentPage);
        const response = await fetch(`${apiEndpoint}?${qs}`);

        if (!response.ok) {
          throw new Error(`Failed to load alerts (${response.status})`);
        }

        const data: AlertsApiResponse = await response.json() as AlertsApiResponse;

        if (append) {
          setAlerts((prev) => {
            const combined = [...prev, ...data.alerts];
            setStats(computeStats(combined));
            return combined;
          });
        } else {
          setAlerts(data.alerts);
          setStats(computeStats(data.alerts));
        }

        setHasMore(data.hasMore);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'An unexpected error occurred.';
        setError(message);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [apiEndpoint]
  );

  // Initial fetch only when no initialAlerts were provided
  useEffect(() => {
    if (initialAlerts.length === 0) {
      fetchAlerts(filters, 1, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch when filters change, resetting to page 1
  const applyFilters = useCallback(
    (nextFilters: FilterState) => {
      setFilters(nextFilters);
      setPage(1);
      fetchAlerts(nextFilters, 1, false);
    },
    [fetchAlerts]
  );

  const handleLoadMore = () => {
    const nextPage = page + 1;
    setPage(nextPage);
    fetchAlerts(filters, nextPage, true);
  };

  const handleFilterChange = <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    applyFilters({ ...filters, [key]: value });
  };

  return (
    <div className="space-y-6">
      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3 sm:gap-4">
        <StatCard label="Total Alerts" value={stats.total} />
        <StatCard label="Critical" value={stats.critical} highlight />
        <StatCard label="Active" value={stats.active} />
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg border border-slate-200 p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Alert type */}
          <div className="flex flex-col gap-1">
            <label
              htmlFor="filter-alert-type"
              className="text-xs font-medium text-[#1B2A4A] uppercase tracking-wider"
            >
              Alert Type
            </label>
            <select
              id="filter-alert-type"
              value={filters.alertType}
              onChange={(e) => handleFilterChange('alertType', e.target.value)}
              className="px-3 py-2 rounded-md border border-slate-300 text-sm text-[#1B2A4A] bg-white focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent"
            >
              {ALERT_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Minimum severity */}
          <div className="flex flex-col gap-1">
            <label
              htmlFor="filter-min-severity"
              className="text-xs font-medium text-[#1B2A4A] uppercase tracking-wider"
            >
              Min Severity
              <span className="ml-1 font-mono text-[#2563EB]">{filters.minSeverity.toFixed(1)}</span>
            </label>
            <input
              id="filter-min-severity"
              type="range"
              min={0}
              max={10}
              step={0.5}
              value={filters.minSeverity}
              onChange={(e) => handleFilterChange('minSeverity', parseFloat(e.target.value))}
              className="w-full accent-[#2563EB] mt-1"
              aria-valuemin={0}
              aria-valuemax={10}
              aria-valuenow={filters.minSeverity}
            />
          </div>

          {/* Date from */}
          <div className="flex flex-col gap-1">
            <label
              htmlFor="filter-date-from"
              className="text-xs font-medium text-[#1B2A4A] uppercase tracking-wider"
            >
              From Date
            </label>
            <input
              id="filter-date-from"
              type="date"
              value={filters.dateFrom}
              onChange={(e) => handleFilterChange('dateFrom', e.target.value)}
              className="px-3 py-2 rounded-md border border-slate-300 text-sm text-[#1B2A4A] bg-white focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent"
            />
          </div>

          {/* Date to */}
          <div className="flex flex-col gap-1">
            <label
              htmlFor="filter-date-to"
              className="text-xs font-medium text-[#1B2A4A] uppercase tracking-wider"
            >
              To Date
            </label>
            <input
              id="filter-date-to"
              type="date"
              value={filters.dateTo}
              onChange={(e) => handleFilterChange('dateTo', e.target.value)}
              className="px-3 py-2 rounded-md border border-slate-300 text-sm text-[#1B2A4A] bg-white focus:outline-none focus:ring-2 focus:ring-[#2563EB] focus:border-transparent"
            />
          </div>
        </div>

        {/* Sort controls */}
        <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-3">
          <span className="text-xs font-medium text-[#475569] uppercase tracking-wider">Sort by:</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => handleFilterChange('sortBy', 'severity')}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                filters.sortBy === 'severity'
                  ? 'bg-[#1B2A4A] text-white'
                  : 'bg-slate-100 text-[#475569] hover:bg-slate-200'
              }`}
            >
              Severity
            </button>
            <button
              type="button"
              onClick={() => handleFilterChange('sortBy', 'date')}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                filters.sortBy === 'date'
                  ? 'bg-[#1B2A4A] text-white'
                  : 'bg-slate-100 text-[#475569] hover:bg-slate-200'
              }`}
            >
              Date
            </button>
          </div>
        </div>
      </div>

      {/* Alert list */}
      {loading ? (
        <LoadingSpinner />
      ) : error ? (
        <div
          className="bg-red-50 border border-red-200 rounded-lg p-5 text-center"
          role="alert"
        >
          <p className="text-sm font-semibold text-[#DC2626] mb-1">Failed to load alerts</p>
          <p className="text-sm text-[#475569]">{error}</p>
          <button
            type="button"
            onClick={() => fetchAlerts(filters, 1, false)}
            className="mt-3 px-4 py-2 bg-[#DC2626] text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors"
          >
            Retry
          </button>
        </div>
      ) : alerts.length === 0 ? (
        <EmptyState hasFilters={hasActiveFilters} />
      ) : (
        <div className="space-y-3" role="list" aria-label="Conflict alerts">
          {alerts.map((alert) => (
            <div key={alert.id} role="listitem">
              <ConflictCard alert={alert} />
            </div>
          ))}
        </div>
      )}

      {/* Load more */}
      {!loading && !error && hasMore && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="px-6 py-2.5 bg-white border border-slate-300 text-[#1B2A4A] rounded-lg text-sm font-medium hover:border-[#2563EB] hover:text-[#2563EB] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
          >
            {loadingMore ? (
              <>
                <span
                  className="inline-block w-4 h-4 rounded-full border-2 border-slate-300 border-t-[#2563EB] animate-spin"
                  aria-hidden="true"
                />
                Loading...
              </>
            ) : (
              'Load more alerts'
            )}
          </button>
        </div>
      )}
    </div>
  );
}

export type { ConflictFeedProps };
