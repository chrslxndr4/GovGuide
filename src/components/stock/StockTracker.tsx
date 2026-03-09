import { useState, useEffect, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TradeOfficial {
  full_name: string;
  slug: string;
  party: string;
}

interface StockTrade {
  id: string;
  trade_date: string;
  official_id: string;
  official: TradeOfficial;
  ticker: string;
  asset_description: string;
  trade_type: 'purchase' | 'sale' | 'sale_partial' | 'exchange';
  amount_min: number;
  amount_max: number;
  days_late: number;
  committee_overlap: boolean;
  committee_names: string[];
  filing_date: string;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

interface ApiResponse {
  trades: StockTrade[];
  pagination: Pagination;
}

interface SummaryStats {
  totalThisMonth: number;
  lateFilings: number;
  suspiciousTiming: number;
}

type SortField = 'trade_date' | 'official' | 'ticker' | 'amount_min' | 'days_late';
type SortDir = 'asc' | 'desc';

interface FilterState {
  official: string;
  ticker: string;
  dateFrom: string;
  dateTo: string;
  tradeType: string;
  lateOnly: boolean;
}

const INITIAL_FILTERS: FilterState = {
  official: '',
  ticker: '',
  dateFrom: '',
  dateTo: '',
  tradeType: '',
  lateOnly: false,
};

const TRADE_TYPE_LABELS: Record<string, string> = {
  purchase: 'Purchase',
  sale: 'Sale (Full)',
  sale_partial: 'Sale (Partial)',
  exchange: 'Exchange',
};

const PARTY_COLORS: Record<string, string> = {
  D: 'bg-blue-100 text-blue-800',
  R: 'bg-red-100 text-red-800',
  I: 'bg-slate-100 text-slate-700',
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatAmountRange(min: number, max: number): string {
  const fmt = (n: number) =>
    n >= 1_000_000
      ? `$${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000
      ? `$${(n / 1_000).toFixed(0)}K`
      : `$${n.toLocaleString()}`;
  return `${fmt(min)} – ${fmt(max)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function partyBadge(party: string): string {
  return PARTY_COLORS[party] ?? 'bg-slate-100 text-slate-700';
}

function tradeTypeLabel(type: string): string {
  return TRADE_TYPE_LABELS[type] ?? type;
}

function tradeTypeBadgeClass(type: string): string {
  if (type === 'purchase') return 'bg-emerald-100 text-emerald-800';
  if (type === 'sale' || type === 'sale_partial') return 'bg-red-100 text-red-800';
  return 'bg-slate-100 text-slate-700';
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  accent,
  note,
}: {
  label: string;
  value: number | string;
  accent?: 'default' | 'warning' | 'danger';
  note?: string;
}) {
  const valueClass =
    accent === 'danger'
      ? 'text-civic-red'
      : accent === 'warning'
      ? 'text-civic-gold'
      : 'text-civic-navy';

  return (
    <div className="bg-white border border-slate-200 rounded-lg px-5 py-4">
      <p className="text-xs font-medium text-civic-slate uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-3xl font-display font-bold ${valueClass}`}>{value}</p>
      {note && <p className="text-xs text-slate-400 mt-1">{note}</p>}
    </div>
  );
}

function SortButton({
  field,
  currentField,
  currentDir,
  onSort,
  children,
}: {
  field: SortField;
  currentField: SortField;
  currentDir: SortDir;
  onSort: (field: SortField) => void;
  children: React.ReactNode;
}) {
  const active = currentField === field;
  return (
    <button
      onClick={() => onSort(field)}
      className={`flex items-center gap-1 text-left font-semibold text-xs uppercase tracking-wide transition-colors ${
        active ? 'text-civic-blue' : 'text-slate-500 hover:text-civic-navy'
      }`}
      aria-sort={active ? (currentDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {children}
      <span aria-hidden="true" className="text-[10px] leading-none">
        {active ? (currentDir === 'asc' ? '▲' : '▼') : '⇅'}
      </span>
    </button>
  );
}

function LateFilingBadge({ daysLate }: { daysLate: number }) {
  if (daysLate <= 0) return null;
  const cls =
    daysLate > 30
      ? 'bg-red-100 text-civic-red border border-red-200'
      : 'bg-orange-100 text-orange-700 border border-orange-200';
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${cls}`}>
      <span aria-hidden="true">!</span>
      {daysLate}d late
    </span>
  );
}

function CommitteeOverlapBadge({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <span
      title={`Committee overlap: ${names.join(', ')}`}
      className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200 cursor-help"
    >
      <span aria-hidden="true">&#9888;</span>
      Committee overlap
    </span>
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <tr>
      <td colSpan={7} className="py-16 text-center">
        <p className="text-civic-slate font-medium">
          {hasFilters ? 'No trades match your filters.' : 'No trades found.'}
        </p>
        {hasFilters && (
          <p className="text-sm text-slate-400 mt-1">Try adjusting the filter options above.</p>
        )}
      </td>
    </tr>
  );
}

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <tr key={i} className="animate-pulse">
          {Array.from({ length: 7 }).map((_, j) => (
            <td key={j} className="px-4 py-3">
              <div className="h-4 bg-slate-100 rounded w-3/4" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function StockTracker() {
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
  // Committed filters are what we actually fetch against; they update when the
  // user clicks Apply or changes an instant-filter (checkbox).
  const [committedFilters, setCommittedFilters] = useState<FilterState>(INITIAL_FILTERS);

  const [trades, setTrades] = useState<StockTrade[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, pages: 0 });
  const [stats, setStats] = useState<SummaryStats>({ totalThisMonth: 0, lateFilings: 0, suspiciousTiming: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>('trade_date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);

  // Build query params from committed filters + sort + page.
  const buildParams = useCallback(
    (overridePage?: number): URLSearchParams => {
      const params = new URLSearchParams();
      if (committedFilters.official) params.set('official_id', committedFilters.official);
      if (committedFilters.ticker) params.set('ticker', committedFilters.ticker.toUpperCase());
      if (committedFilters.tradeType) params.set('trade_type', committedFilters.tradeType);
      if (committedFilters.dateFrom) params.set('date_from', committedFilters.dateFrom);
      if (committedFilters.dateTo) params.set('date_to', committedFilters.dateTo);
      if (committedFilters.lateOnly) params.set('late_only', 'true');
      params.set('page', String(overridePage ?? page));
      params.set('limit', '50');
      return params;
    },
    [committedFilters, page]
  );

  // Fetch trades whenever committed filters, page, or sort change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function fetchTrades() {
      try {
        const res = await fetch(`/api/stock-trades?${buildParams()}`);
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const data: ApiResponse = await res.json();
        if (cancelled) return;
        setTrades(data.trades ?? []);
        setPagination(data.pagination);
        computeStats(data.trades ?? [], data.pagination.total);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load trades');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchTrades();
    return () => { cancelled = true; };
  }, [buildParams]);

  function computeStats(tradeList: StockTrade[], total: number) {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const thisMonth = tradeList.filter(t => t.trade_date >= startOfMonth).length;
    const late = tradeList.filter(t => t.days_late > 0).length;
    const suspicious = tradeList.filter(t => t.committee_overlap).length;
    setStats({
      totalThisMonth: thisMonth,
      lateFilings: late,
      suspiciousTiming: suspicious,
    });
  }

  // Sort trades client-side within the current page.
  const sortedTrades = [...trades].sort((a, b) => {
    let cmp = 0;
    if (sortField === 'trade_date') {
      cmp = a.trade_date.localeCompare(b.trade_date);
    } else if (sortField === 'official') {
      cmp = a.official.full_name.localeCompare(b.official.full_name);
    } else if (sortField === 'ticker') {
      cmp = a.ticker.localeCompare(b.ticker);
    } else if (sortField === 'amount_min') {
      cmp = a.amount_min - b.amount_min;
    } else if (sortField === 'days_late') {
      cmp = a.days_late - b.days_late;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  }

  function handleApplyFilters() {
    setPage(1);
    setCommittedFilters({ ...filters });
  }

  function handleResetFilters() {
    setFilters(INITIAL_FILTERS);
    setPage(1);
    setCommittedFilters(INITIAL_FILTERS);
  }

  function handleLateOnlyToggle(checked: boolean) {
    const updated = { ...filters, lateOnly: checked };
    setFilters(updated);
    setPage(1);
    setCommittedFilters(updated);
  }

  const hasActiveFilters =
    committedFilters.official !== '' ||
    committedFilters.ticker !== '' ||
    committedFilters.dateFrom !== '' ||
    committedFilters.dateTo !== '' ||
    committedFilters.tradeType !== '' ||
    committedFilters.lateOnly;

  return (
    <div className="flex flex-col gap-6">

      {/* Summary stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          label="Trades this month"
          value={stats.totalThisMonth}
          note="Across all members of Congress"
        />
        <StatCard
          label="Late STOCK Act filings"
          value={stats.lateFilings}
          accent="warning"
          note="Filed after 45-day deadline"
        />
        <StatCard
          label="Committee overlap flags"
          value={stats.suspiciousTiming}
          accent="danger"
          note="Trade overlaps with committee jurisdiction"
        />
      </div>

      {/* Filter controls */}
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <div className="flex flex-wrap gap-3 items-end">

          {/* Official search */}
          <div className="flex flex-col gap-1 min-w-[180px]">
            <label htmlFor="filter-official" className="text-xs font-medium text-slate-600">
              Official
            </label>
            <input
              id="filter-official"
              type="text"
              placeholder="Name or ID..."
              value={filters.official}
              onChange={e => setFilters(f => ({ ...f, official: e.target.value }))}
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
            />
          </div>

          {/* Ticker */}
          <div className="flex flex-col gap-1 min-w-[120px]">
            <label htmlFor="filter-ticker" className="text-xs font-medium text-slate-600">
              Ticker
            </label>
            <input
              id="filter-ticker"
              type="text"
              placeholder="e.g. AAPL"
              value={filters.ticker}
              onChange={e => setFilters(f => ({ ...f, ticker: e.target.value }))}
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
            />
          </div>

          {/* Date from */}
          <div className="flex flex-col gap-1">
            <label htmlFor="filter-date-from" className="text-xs font-medium text-slate-600">
              From
            </label>
            <input
              id="filter-date-from"
              type="date"
              value={filters.dateFrom}
              onChange={e => setFilters(f => ({ ...f, dateFrom: e.target.value }))}
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
            />
          </div>

          {/* Date to */}
          <div className="flex flex-col gap-1">
            <label htmlFor="filter-date-to" className="text-xs font-medium text-slate-600">
              To
            </label>
            <input
              id="filter-date-to"
              type="date"
              value={filters.dateTo}
              onChange={e => setFilters(f => ({ ...f, dateTo: e.target.value }))}
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
            />
          </div>

          {/* Trade type */}
          <div className="flex flex-col gap-1 min-w-[140px]">
            <label htmlFor="filter-trade-type" className="text-xs font-medium text-slate-600">
              Trade type
            </label>
            <select
              id="filter-trade-type"
              value={filters.tradeType}
              onChange={e => setFilters(f => ({ ...f, tradeType: e.target.value }))}
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
            >
              <option value="">All types</option>
              <option value="purchase">Purchase</option>
              <option value="sale">Sale (Full)</option>
              <option value="sale_partial">Sale (Partial)</option>
              <option value="exchange">Exchange</option>
            </select>
          </div>

          {/* Late only toggle */}
          <label className="flex items-center gap-2 cursor-pointer self-end pb-[9px]">
            <input
              type="checkbox"
              checked={filters.lateOnly}
              onChange={e => handleLateOnlyToggle(e.target.checked)}
              className="w-4 h-4 accent-civic-red rounded"
            />
            <span className="text-sm font-medium text-slate-700">Late filings only</span>
          </label>

          {/* Action buttons */}
          <div className="flex gap-2 self-end pb-[1px]">
            <button
              onClick={handleApplyFilters}
              className="bg-civic-blue text-white px-4 py-[7px] rounded-md text-sm font-medium hover:bg-blue-700 transition-colors focus:outline-none focus:ring-2 focus:ring-civic-blue focus:ring-offset-2"
            >
              Apply
            </button>
            {hasActiveFilters && (
              <button
                onClick={handleResetFilters}
                className="border border-slate-300 text-slate-600 px-4 py-[7px] rounded-md text-sm font-medium hover:bg-slate-50 transition-colors focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2"
              >
                Reset
              </button>
            )}
          </div>
        </div>

        {hasActiveFilters && (
          <p className="mt-3 text-xs text-civic-slate border-t border-slate-100 pt-3">
            Showing filtered results
            {committedFilters.lateOnly && ' — late filings only'}
            {committedFilters.ticker && ` — ticker: ${committedFilters.ticker.toUpperCase()}`}
            {committedFilters.tradeType && ` — type: ${tradeTypeLabel(committedFilters.tradeType)}`}
          </p>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 text-civic-red rounded-lg px-4 py-3 text-sm"
        >
          Failed to load trade data: {error}
        </div>
      )}

      {/* Trade table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {/* Table header bar */}
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <h2 className="font-semibold text-civic-navy text-sm">
            Stock Trades
            {!loading && (
              <span className="ml-2 text-xs font-normal text-civic-slate">
                {pagination.total.toLocaleString()} total
              </span>
            )}
          </h2>
          {hasActiveFilters && !loading && (
            <span className="text-xs text-civic-slate">
              Page {pagination.page} of {pagination.pages}
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Congressional stock trades">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="px-4 py-3 text-left">
                  <SortButton field="trade_date" currentField={sortField} currentDir={sortDir} onSort={handleSort}>
                    Date
                  </SortButton>
                </th>
                <th className="px-4 py-3 text-left">
                  <SortButton field="official" currentField={sortField} currentDir={sortDir} onSort={handleSort}>
                    Official
                  </SortButton>
                </th>
                <th className="px-4 py-3 text-left">
                  <SortButton field="ticker" currentField={sortField} currentDir={sortDir} onSort={handleSort}>
                    Ticker / Asset
                  </SortButton>
                </th>
                <th className="px-4 py-3 text-left">
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Type</span>
                </th>
                <th className="px-4 py-3 text-left">
                  <SortButton field="amount_min" currentField={sortField} currentDir={sortDir} onSort={handleSort}>
                    Amount
                  </SortButton>
                </th>
                <th className="px-4 py-3 text-left">
                  <SortButton field="days_late" currentField={sortField} currentDir={sortDir} onSort={handleSort}>
                    Filing
                  </SortButton>
                </th>
                <th className="px-4 py-3 text-left">
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Flags</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <LoadingRows />
              ) : sortedTrades.length === 0 ? (
                <EmptyState hasFilters={hasActiveFilters} />
              ) : (
                sortedTrades.map(trade => (
                  <TradeRow key={trade.id} trade={trade} />
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {!loading && pagination.pages > 1 && (
          <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between">
            <p className="text-xs text-civic-slate">
              Page {pagination.page} of {pagination.pages} ({pagination.total.toLocaleString()} trades)
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={pagination.page <= 1}
                className="px-3 py-1.5 text-xs border border-slate-300 rounded-md disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 transition-colors"
              >
                Previous
              </button>
              <button
                onClick={() => setPage(p => Math.min(pagination.pages, p + 1))}
                disabled={pagination.page >= pagination.pages}
                className="px-3 py-1.5 text-xs border border-slate-300 rounded-md disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 transition-colors"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Disclosure note */}
      <p className="text-xs text-slate-400">
        Trade data sourced from STOCK Act disclosures via the House and Senate periodic transaction report databases.
        Filings are required within 45 days of a transaction. Committee overlap flags are automatically generated
        based on committee assignments at the time of the trade and may not reflect the full context of each transaction.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trade row (extracted to keep the table body readable)
// ---------------------------------------------------------------------------

function TradeRow({ trade }: { trade: StockTrade }) {
  const isLate = trade.days_late > 0;
  const rowClass = isLate
    ? trade.days_late > 30
      ? 'bg-red-50/40 hover:bg-red-50'
      : 'bg-orange-50/40 hover:bg-orange-50'
    : 'hover:bg-slate-50';

  return (
    <tr className={`transition-colors ${rowClass}`}>
      {/* Date */}
      <td className="px-4 py-3 whitespace-nowrap">
        <span className="font-mono text-xs text-slate-700">{formatDate(trade.trade_date)}</span>
      </td>

      {/* Official */}
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <a
            href={`/officials/${trade.official.slug}`}
            className="font-medium text-civic-blue hover:underline whitespace-nowrap"
          >
            {trade.official.full_name}
          </a>
          <span
            className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${partyBadge(trade.official.party)}`}
          >
            {trade.official.party}
          </span>
        </div>
      </td>

      {/* Ticker / Asset */}
      <td className="px-4 py-3">
        <div>
          <span className="font-mono font-semibold text-civic-navy text-xs tracking-wider">
            {trade.ticker}
          </span>
          {trade.asset_description && (
            <p className="text-xs text-slate-400 mt-0.5 max-w-[180px] truncate" title={trade.asset_description}>
              {trade.asset_description}
            </p>
          )}
        </div>
      </td>

      {/* Trade type */}
      <td className="px-4 py-3 whitespace-nowrap">
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${tradeTypeBadgeClass(trade.trade_type)}`}>
          {tradeTypeLabel(trade.trade_type)}
        </span>
      </td>

      {/* Amount range */}
      <td className="px-4 py-3 whitespace-nowrap">
        <span className="text-xs font-mono text-slate-700">
          {formatAmountRange(trade.amount_min, trade.amount_max)}
        </span>
      </td>

      {/* Filing / days late */}
      <td className="px-4 py-3 whitespace-nowrap">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">{formatDate(trade.filing_date)}</span>
          <LateFilingBadge daysLate={trade.days_late} />
        </div>
      </td>

      {/* Flags */}
      <td className="px-4 py-3">
        <CommitteeOverlapBadge names={trade.committee_names ?? []} />
      </td>
    </tr>
  );
}
