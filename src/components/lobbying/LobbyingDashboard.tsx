import { useState, useEffect, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LobbyingEntity {
  id: string;
  name: string;
}

interface LobbyingActivity {
  id: string;
  report_year: number;
  report_quarter: number;
  amount: number | null;
  general_issue_code: string;
  specific_lobbying_issues: string;
  government_entities: string[];
}

interface LobbyingRegistration {
  id: string;
  firm: LobbyingEntity;
  client: LobbyingEntity;
  activities: LobbyingActivity[];
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

interface ApiResponse {
  registrations: LobbyingRegistration[];
  pagination: Pagination;
}

interface FilterState {
  search: string;
  year: string;
  quarter: string;
}

interface SummaryStats {
  totalSpending: number;
  activeRegistrations: number;
  topIndustries: TopIndustry[];
}

interface TopIndustry {
  code: string;
  label: string;
  count: number;
}

type SortField = 'firm' | 'client' | 'amount' | 'issues';
type SortDir = 'asc' | 'desc';

// Flattened row derived from a registration + one activity, used for display.
interface TableRow {
  registrationId: string;
  firmName: string;
  clientName: string;
  amount: number | null;
  issueCode: string;
  issueDetail: string;
  governmentEntities: string[];
  year: number;
  quarter: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CURRENT_YEAR = new Date().getFullYear();

const YEAR_OPTIONS: number[] = Array.from({ length: 6 }, (_, i) => CURRENT_YEAR - i);

const QUARTER_LABELS: Record<number, string> = {
  1: 'Q1 (Jan–Mar)',
  2: 'Q2 (Apr–Jun)',
  3: 'Q3 (Jul–Sep)',
  4: 'Q4 (Oct–Dec)',
};

const ISSUE_CODE_LABELS: Record<string, string> = {
  AGR: 'Agriculture',
  AUT: 'Automotive',
  BAN: 'Banking',
  BUD: 'Budget',
  CAW: 'Clean Air & Water',
  CDT: 'Consumer Issues',
  COM: 'Communications',
  CPT: 'Copyright & IP',
  DEF: 'Defense',
  DIS: 'Disaster Relief',
  EDU: 'Education',
  ENE: 'Energy',
  ENV: 'Environment',
  FIN: 'Finance',
  FOO: 'Food Industry',
  FOR: 'Foreign Affairs',
  GOV: 'Government Issues',
  HCR: 'Health Care',
  HOM: 'Homeland Security',
  HOU: 'Housing',
  IMM: 'Immigration',
  IND: 'Indian/Native Affairs',
  INS: 'Insurance',
  LBR: 'Labor',
  LAW: 'Law Enforcement',
  MAN: 'Manufacturing',
  MAR: 'Marine',
  MED: 'Media',
  MIA: 'Medicare/Medicaid',
  NAT: 'Natural Resources',
  PHA: 'Pharmacy',
  POS: 'Postal',
  RES: 'Real Estate',
  REL: 'Religion',
  RET: 'Retirement',
  ROD: 'Roads & Highways',
  SCI: 'Science & Technology',
  SMB: 'Small Business',
  SPO: 'Sports',
  TAX: 'Taxes',
  TOR: 'Tort Reform',
  TRA: 'Trade',
  TRN: 'Transportation',
  UNM: 'Unemployment',
  URB: 'Urban Development',
  WEL: 'Welfare',
};

const INITIAL_FILTERS: FilterState = {
  search: '',
  year: '',
  quarter: '',
};

const PAGE_LIMIT = 50;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatAmount(n: number | null): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
}

function formatAmountLong(n: number): string {
  return `$${n.toLocaleString()}`;
}

function issueLabel(code: string): string {
  return ISSUE_CODE_LABELS[code] ?? code;
}

function flattenRegistrations(registrations: LobbyingRegistration[]): TableRow[] {
  const rows: TableRow[] = [];
  for (const reg of registrations) {
    if (reg.activities.length === 0) {
      rows.push({
        registrationId: reg.id,
        firmName: reg.firm?.name ?? '—',
        clientName: reg.client?.name ?? '—',
        amount: null,
        issueCode: '',
        issueDetail: '',
        governmentEntities: [],
        year: 0,
        quarter: 0,
      });
    } else {
      for (const act of reg.activities) {
        rows.push({
          registrationId: reg.id,
          firmName: reg.firm?.name ?? '—',
          clientName: reg.client?.name ?? '—',
          amount: act.amount ?? null,
          issueCode: act.general_issue_code ?? '',
          issueDetail: act.specific_lobbying_issues ?? '',
          governmentEntities: act.government_entities ?? [],
          year: act.report_year,
          quarter: act.report_quarter,
        });
      }
    }
  }
  return rows;
}

function computeStats(registrations: LobbyingRegistration[]): SummaryStats {
  let totalSpending = 0;
  const issueCounts: Record<string, number> = {};

  for (const reg of registrations) {
    for (const act of reg.activities) {
      if (act.amount) totalSpending += act.amount;
      if (act.general_issue_code) {
        issueCounts[act.general_issue_code] = (issueCounts[act.general_issue_code] ?? 0) + 1;
      }
    }
  }

  const topIndustries: TopIndustry[] = Object.entries(issueCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([code, count]) => ({ code, label: issueLabel(code), count }));

  return {
    totalSpending,
    activeRegistrations: registrations.length,
    topIndustries,
  };
}

function sortRows(rows: TableRow[], field: SortField, dir: SortDir): TableRow[] {
  return [...rows].sort((a, b) => {
    let cmp = 0;
    if (field === 'firm') {
      cmp = a.firmName.localeCompare(b.firmName);
    } else if (field === 'client') {
      cmp = a.clientName.localeCompare(b.clientName);
    } else if (field === 'amount') {
      cmp = (a.amount ?? -1) - (b.amount ?? -1);
    } else if (field === 'issues') {
      cmp = a.issueCode.localeCompare(b.issueCode);
    }
    return dir === 'asc' ? cmp : -cmp;
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  note,
  accent,
}: {
  label: string;
  value: string | number;
  note?: string;
  accent?: 'default' | 'highlight';
}) {
  const valueClass =
    accent === 'highlight' ? 'text-civic-blue' : 'text-civic-navy';

  return (
    <div className="bg-white border border-slate-200 rounded-lg px-5 py-4">
      <p className="text-xs font-medium text-civic-slate uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-3xl font-display font-bold ${valueClass}`}>{value}</p>
      {note && <p className="text-xs text-slate-400 mt-1">{note}</p>}
    </div>
  );
}

function TopIndustriesCard({ industries }: { industries: TopIndustry[] }) {
  if (industries.length === 0) return null;
  const max = industries[0]?.count ?? 1;

  return (
    <div className="bg-white border border-slate-200 rounded-lg px-5 py-4">
      <p className="text-xs font-medium text-civic-slate uppercase tracking-wide mb-3">Top Industries</p>
      <ol className="flex flex-col gap-2">
        {industries.map((ind) => (
          <li key={ind.code} className="flex items-center gap-3">
            <span
              className="text-xs font-mono font-semibold text-civic-navy w-8 shrink-0 uppercase"
              title={ind.label}
            >
              {ind.code}
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-0.5">
                <span className="text-xs text-slate-600 truncate">{ind.label}</span>
                <span className="text-xs font-medium text-civic-slate ml-2 shrink-0">{ind.count}</span>
              </div>
              <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-civic-blue rounded-full transition-all"
                  style={{ width: `${Math.round((ind.count / max) * 100)}%` }}
                />
              </div>
            </div>
          </li>
        ))}
      </ol>
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

function EntitiesBadgeList({ entities }: { entities: string[] }) {
  if (entities.length === 0) return <span className="text-slate-400 text-xs">—</span>;
  const visible = entities.slice(0, 2);
  const overflow = entities.length - visible.length;

  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((entity) => (
        <span
          key={entity}
          className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 whitespace-nowrap"
        >
          {entity}
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="inline-block text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-100 text-slate-500"
          title={entities.slice(2).join(', ')}
        >
          +{overflow} more
        </span>
      )}
    </div>
  );
}

function LoadingRows({ cols }: { cols: number }) {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <tr key={i} className="animate-pulse">
          {Array.from({ length: cols }).map((_, j) => (
            <td key={j} className="px-4 py-3">
              <div className="h-4 bg-slate-100 rounded w-3/4" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function EmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <tr>
      <td colSpan={5} className="py-16 text-center">
        <p className="text-civic-slate font-medium">
          {hasFilters ? 'No registrations match your filters.' : 'No registrations found.'}
        </p>
        {hasFilters && (
          <p className="text-sm text-slate-400 mt-1">Try adjusting or clearing the filter options above.</p>
        )}
      </td>
    </tr>
  );
}

function LobbyingRow({ row }: { row: TableRow }) {
  return (
    <tr className="hover:bg-slate-50 transition-colors">
      {/* Firm */}
      <td className="px-4 py-3">
        <span className="font-medium text-civic-navy text-sm leading-snug">{row.firmName}</span>
      </td>

      {/* Client */}
      <td className="px-4 py-3">
        <span className="text-sm text-slate-700 leading-snug">{row.clientName}</span>
      </td>

      {/* Amount */}
      <td className="px-4 py-3 whitespace-nowrap">
        <span
          className="font-mono text-sm font-medium text-civic-navy"
          title={row.amount !== null ? formatAmountLong(row.amount) : undefined}
        >
          {formatAmount(row.amount)}
        </span>
      </td>

      {/* Issues lobbied */}
      <td className="px-4 py-3">
        {row.issueCode ? (
          <div>
            <span className="inline-block text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-civic-blue border border-blue-100 mb-1">
              {issueLabel(row.issueCode)}
            </span>
            {row.issueDetail && (
              <p
                className="text-xs text-slate-400 max-w-[240px] truncate"
                title={row.issueDetail}
              >
                {row.issueDetail}
              </p>
            )}
          </div>
        ) : (
          <span className="text-slate-400 text-xs">—</span>
        )}
      </td>

      {/* Government entities */}
      <td className="px-4 py-3">
        <EntitiesBadgeList entities={row.governmentEntities} />
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function LobbyingDashboard() {
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
  const [committedFilters, setCommittedFilters] = useState<FilterState>(INITIAL_FILTERS);

  const [registrations, setRegistrations] = useState<LobbyingRegistration[]>([]);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: PAGE_LIMIT,
    total: 0,
    pages: 0,
  });
  const [stats, setStats] = useState<SummaryStats>({
    totalSpending: 0,
    activeRegistrations: 0,
    topIndustries: [],
  });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [sortField, setSortField] = useState<SortField>('amount');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const buildParams = useCallback(
    (overridePage?: number): URLSearchParams => {
      const params = new URLSearchParams();

      // The API currently accepts firm_id / client_id; we use the search term
      // as a client-side filter since the API does not yet support free-text.
      if (committedFilters.year) params.set('year', committedFilters.year);
      if (committedFilters.quarter) params.set('quarter', committedFilters.quarter);
      params.set('page', String(overridePage ?? page));
      params.set('limit', String(PAGE_LIMIT));
      return params;
    },
    [committedFilters, page]
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function fetchRegistrations() {
      try {
        const res = await fetch(`/api/lobbying?${buildParams()}`);
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const data: ApiResponse = await res.json();
        if (cancelled) return;

        const regs = data.registrations ?? [];
        setRegistrations(regs);
        setPagination(data.pagination);
        setStats(computeStats(regs));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load lobbying data');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchRegistrations();
    return () => {
      cancelled = true;
    };
  }, [buildParams]);

  function handleApplyFilters() {
    setPage(1);
    setCommittedFilters({ ...filters });
  }

  function handleResetFilters() {
    setFilters(INITIAL_FILTERS);
    setPage(1);
    setCommittedFilters(INITIAL_FILTERS);
  }

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  }

  // Client-side: filter by search term across firm and client names, then sort.
  const allRows = flattenRegistrations(registrations);

  const filteredRows = committedFilters.search
    ? allRows.filter((r) => {
        const q = committedFilters.search.toLowerCase();
        return (
          r.firmName.toLowerCase().includes(q) ||
          r.clientName.toLowerCase().includes(q) ||
          r.issueCode.toLowerCase().includes(q) ||
          issueLabel(r.issueCode).toLowerCase().includes(q)
        );
      })
    : allRows;

  const sortedRows = sortRows(filteredRows, sortField, sortDir);

  const hasActiveFilters =
    committedFilters.search !== '' ||
    committedFilters.year !== '' ||
    committedFilters.quarter !== '';

  return (
    <div className="flex flex-col gap-6">

      {/* Summary stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          label={`Total Spending (${CURRENT_YEAR})`}
          value={formatAmount(stats.totalSpending)}
          note="Across all active registrations in current results"
          accent="highlight"
        />
        <StatCard
          label="Active Registrations"
          value={stats.activeRegistrations.toLocaleString()}
          note="Lobbying Disclosure Act filings"
        />
        <TopIndustriesCard industries={stats.topIndustries} />
      </div>

      {/* Filter controls */}
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <div className="flex flex-wrap gap-3 items-end">

          {/* Free-text search */}
          <div className="flex flex-col gap-1 min-w-[220px] flex-1">
            <label htmlFor="filter-search" className="text-xs font-medium text-slate-600">
              Search firm, client, or industry
            </label>
            <input
              id="filter-search"
              type="search"
              placeholder="e.g. Lockheed, Pharma, Health Care..."
              value={filters.search}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && handleApplyFilters()}
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
            />
          </div>

          {/* Year */}
          <div className="flex flex-col gap-1 min-w-[110px]">
            <label htmlFor="filter-year" className="text-xs font-medium text-slate-600">
              Year
            </label>
            <select
              id="filter-year"
              value={filters.year}
              onChange={(e) => setFilters((f) => ({ ...f, year: e.target.value }))}
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
            >
              <option value="">All years</option>
              {YEAR_OPTIONS.map((y) => (
                <option key={y} value={String(y)}>
                  {y}
                </option>
              ))}
            </select>
          </div>

          {/* Quarter */}
          <div className="flex flex-col gap-1 min-w-[160px]">
            <label htmlFor="filter-quarter" className="text-xs font-medium text-slate-600">
              Quarter
            </label>
            <select
              id="filter-quarter"
              value={filters.quarter}
              onChange={(e) => setFilters((f) => ({ ...f, quarter: e.target.value }))}
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
            >
              <option value="">All quarters</option>
              {Object.entries(QUARTER_LABELS).map(([q, label]) => (
                <option key={q} value={q}>
                  {label}
                </option>
              ))}
            </select>
          </div>

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
            {committedFilters.year && ` — year: ${committedFilters.year}`}
            {committedFilters.quarter && ` — ${QUARTER_LABELS[Number(committedFilters.quarter)]}`}
            {committedFilters.search && ` — search: "${committedFilters.search}"`}
          </p>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 text-civic-red rounded-lg px-4 py-3 text-sm"
        >
          Failed to load lobbying data: {error}
        </div>
      )}

      {/* Results table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        {/* Table header bar */}
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <h2 className="font-semibold text-civic-navy text-sm">
            Lobbying Registrations
            {!loading && (
              <span className="ml-2 text-xs font-normal text-civic-slate">
                {pagination.total.toLocaleString()} total
                {committedFilters.search && sortedRows.length !== allRows.length && (
                  <> &mdash; {sortedRows.length.toLocaleString()} matching</>
                )}
              </span>
            )}
          </h2>
          {!loading && pagination.pages > 1 && (
            <span className="text-xs text-civic-slate">
              Page {pagination.page} of {pagination.pages}
            </span>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label="Lobbying registrations">
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                <th className="px-4 py-3 text-left">
                  <SortButton
                    field="firm"
                    currentField={sortField}
                    currentDir={sortDir}
                    onSort={handleSort}
                  >
                    Firm
                  </SortButton>
                </th>
                <th className="px-4 py-3 text-left">
                  <SortButton
                    field="client"
                    currentField={sortField}
                    currentDir={sortDir}
                    onSort={handleSort}
                  >
                    Client
                  </SortButton>
                </th>
                <th className="px-4 py-3 text-left">
                  <SortButton
                    field="amount"
                    currentField={sortField}
                    currentDir={sortDir}
                    onSort={handleSort}
                  >
                    Amount
                  </SortButton>
                </th>
                <th className="px-4 py-3 text-left">
                  <SortButton
                    field="issues"
                    currentField={sortField}
                    currentDir={sortDir}
                    onSort={handleSort}
                  >
                    Issues Lobbied
                  </SortButton>
                </th>
                <th className="px-4 py-3 text-left">
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                    Gov't Entities
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <LoadingRows cols={5} />
              ) : sortedRows.length === 0 ? (
                <EmptyState hasFilters={hasActiveFilters} />
              ) : (
                sortedRows.map((row, i) => (
                  <LobbyingRow key={`${row.registrationId}-${i}`} row={row} />
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {!loading && pagination.pages > 1 && (
          <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between">
            <p className="text-xs text-civic-slate">
              Page {pagination.page} of {pagination.pages} (
              {pagination.total.toLocaleString()} registrations)
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={pagination.page <= 1}
                className="px-3 py-1.5 text-xs border border-slate-300 rounded-md disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 transition-colors focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-1"
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => Math.min(pagination.pages, p + 1))}
                disabled={pagination.page >= pagination.pages}
                className="px-3 py-1.5 text-xs border border-slate-300 rounded-md disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-50 transition-colors focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-1"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Disclosure note */}
      <p className="text-xs text-slate-400">
        Lobbying data sourced from Senate LDA (Lobbying Disclosure Act) filings. Registrations are
        required for any lobbying firm or individual spending more than $3,000 per quarter on federal
        lobbying activities. Amounts reflect self-reported quarterly income or expenses and may not
        capture all lobbying-related expenditures.
      </p>
    </div>
  );
}
