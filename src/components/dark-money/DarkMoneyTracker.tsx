import { useState, useEffect, useCallback, useRef } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OrgType = '501c4' | '501c6' | '501c3' | 'super_pac' | 'other';

type DisclosureRating = 'none' | 'partial' | 'full';

interface TopRecipient {
  name: string;
  amount: number;
  recipientType: 'candidate' | 'party' | 'pac' | 'other';
}

interface SpendingCycle {
  cycle: string;
  amount: number;
}

interface DarkMoneyOrg {
  id: string;
  name: string;
  orgType: OrgType;
  totalSpending: number;
  topRecipients: TopRecipient[];
  spendingByCycle: SpendingCycle[];
  disclosureRating: DisclosureRating;
  state: string;
  filedYear: number;
  description: string | null;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

interface ApiEntityResult {
  id: string;
  name: string;
  entity_type: string;
  total_spending?: number;
  disclosure_rating?: DisclosureRating;
  state?: string;
  filed_year?: number;
  description?: string | null;
  top_recipients?: TopRecipient[];
  spending_by_cycle?: SpendingCycle[];
}

interface ApiResponse {
  results: {
    entities?: ApiEntityResult[];
  };
  pagination?: Pagination;
}

interface FilterState {
  searchQuery: string;
  minSpending: string;
  maxSpending: string;
  cycle: string;
  orgType: string;
}

type SortField = 'name' | 'totalSpending' | 'disclosureRating' | 'filedYear';
type SortDir = 'asc' | 'desc';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INITIAL_FILTERS: FilterState = {
  searchQuery: '',
  minSpending: '',
  maxSpending: '',
  cycle: '',
  orgType: '',
};

const ELECTION_CYCLES = ['2024', '2022', '2020', '2018', '2016'];

const ORG_TYPE_LABELS: Record<OrgType | string, string> = {
  '501c4': '501(c)(4)',
  '501c6': '501(c)(6)',
  '501c3': '501(c)(3)',
  super_pac: 'Super PAC',
  other: 'Other',
};

const DISCLOSURE_LABELS: Record<DisclosureRating, string> = {
  none: 'None',
  partial: 'Partial',
  full: 'Full',
};

const DISCLOSURE_BADGE: Record<DisclosureRating, string> = {
  none: 'bg-red-100 text-civic-red border border-red-200',
  partial: 'bg-amber-100 text-amber-800 border border-amber-200',
  full: 'bg-emerald-100 text-emerald-800 border border-emerald-200',
};

const ORG_TYPE_BADGE: Record<OrgType | string, string> = {
  '501c4': 'bg-purple-100 text-purple-800',
  '501c6': 'bg-blue-100 text-blue-800',
  '501c3': 'bg-slate-100 text-slate-700',
  super_pac: 'bg-orange-100 text-orange-800',
  other: 'bg-slate-100 text-slate-600',
};

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatDollars(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
}

function mapApiEntityToOrg(e: ApiEntityResult): DarkMoneyOrg {
  const orgType = (e.entity_type as OrgType) ?? 'other';
  return {
    id: e.id,
    name: e.name,
    orgType,
    totalSpending: e.total_spending ?? 0,
    topRecipients: e.top_recipients ?? [],
    spendingByCycle: e.spending_by_cycle ?? [],
    disclosureRating: e.disclosure_rating ?? 'none',
    state: e.state ?? '—',
    filedYear: e.filed_year ?? 0,
    description: e.description ?? null,
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent?: 'default' | 'warning' | 'danger';
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
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
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
  onSort: (f: SortField) => void;
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

function DisclosureBadge({ rating }: { rating: DisclosureRating }) {
  return (
    <span
      className={`inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full ${DISCLOSURE_BADGE[rating]}`}
      title={`Disclosure: ${DISCLOSURE_LABELS[rating]}`}
    >
      {rating === 'none' && <span aria-hidden="true" className="mr-1">&#9632;</span>}
      {rating === 'partial' && <span aria-hidden="true" className="mr-1">&#9641;</span>}
      {rating === 'full' && <span aria-hidden="true" className="mr-1">&#10003;</span>}
      {DISCLOSURE_LABELS[rating]}
    </span>
  );
}

function OrgTypeBadge({ orgType }: { orgType: OrgType | string }) {
  return (
    <span
      className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide ${
        ORG_TYPE_BADGE[orgType] ?? 'bg-slate-100 text-slate-600'
      }`}
    >
      {ORG_TYPE_LABELS[orgType] ?? orgType}
    </span>
  );
}

function RecipientList({ recipients }: { recipients: TopRecipient[] }) {
  if (recipients.length === 0) {
    return <p className="text-xs text-slate-400 italic">No recipients on file</p>;
  }
  return (
    <ul className="space-y-1.5">
      {recipients.slice(0, 5).map((r, i) => (
        <li key={i} className="flex items-center justify-between gap-4 text-xs">
          <span className="text-slate-700 truncate max-w-[220px]" title={r.name}>
            {r.name}
          </span>
          <span className="font-mono text-slate-500 shrink-0">{formatDollars(r.amount)}</span>
        </li>
      ))}
    </ul>
  );
}

function CycleBreakdown({ cycles }: { cycles: SpendingCycle[] }) {
  if (cycles.length === 0) {
    return <p className="text-xs text-slate-400 italic">No cycle data available</p>;
  }
  const max = Math.max(...cycles.map(c => c.amount), 1);
  return (
    <div className="space-y-1.5">
      {cycles.map(c => (
        <div key={c.cycle} className="flex items-center gap-3">
          <span className="font-mono text-xs text-slate-500 w-10 shrink-0">{c.cycle}</span>
          <div className="flex-1 bg-slate-100 rounded-full h-1.5 overflow-hidden">
            <div
              className="h-full bg-civic-blue rounded-full transition-all"
              style={{ width: `${(c.amount / max) * 100}%` }}
              aria-label={`${formatDollars(c.amount)} in ${c.cycle}`}
            />
          </div>
          <span className="font-mono text-xs text-slate-600 w-14 text-right shrink-0">
            {formatDollars(c.amount)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ExpandedRow({
  org,
  colSpan,
}: {
  org: DarkMoneyOrg;
  colSpan: number;
}) {
  return (
    <tr className="bg-slate-50 border-b border-slate-200">
      <td colSpan={colSpan} className="px-6 py-5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">

          {/* Description */}
          <div>
            <h4 className="text-xs font-semibold text-civic-slate uppercase tracking-wide mb-2">
              About
            </h4>
            {org.description ? (
              <p className="text-sm text-slate-600 leading-relaxed">{org.description}</p>
            ) : (
              <p className="text-xs text-slate-400 italic">No description on file.</p>
            )}
            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="text-xs text-slate-500">State: <strong className="text-slate-700">{org.state}</strong></span>
              {org.filedYear > 0 && (
                <span className="text-xs text-slate-500 ml-2">Filed: <strong className="text-slate-700">{org.filedYear}</strong></span>
              )}
            </div>
          </div>

          {/* Top recipients */}
          <div>
            <h4 className="text-xs font-semibold text-civic-slate uppercase tracking-wide mb-2">
              Top Recipients
            </h4>
            <RecipientList recipients={org.topRecipients} />
          </div>

          {/* Spending by cycle */}
          <div>
            <h4 className="text-xs font-semibold text-civic-slate uppercase tracking-wide mb-2">
              Spending by Cycle
            </h4>
            <CycleBreakdown cycles={org.spendingByCycle} />
            <div className="mt-4">
              <a
                href={`/money-graph?entity=${org.id}`}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-civic-blue hover:text-blue-800 transition-colors border border-civic-blue/30 hover:border-civic-blue/70 px-3 py-1.5 rounded-md"
              >
                <span aria-hidden="true">&#9737;</span>
                View money flow graph
              </a>
            </div>
          </div>

        </div>
      </td>
    </tr>
  );
}

function OrgRow({
  org,
  expanded,
  onToggle,
}: {
  org: DarkMoneyOrg;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className={`transition-colors cursor-pointer ${
          expanded
            ? 'bg-slate-50 border-b-0'
            : 'hover:bg-slate-50 border-b border-slate-100'
        }`}
        onClick={onToggle}
        aria-expanded={expanded}
      >
        {/* Expand toggle */}
        <td className="px-4 py-3 w-8">
          <button
            onClick={e => { e.stopPropagation(); onToggle(); }}
            className="text-slate-400 hover:text-civic-navy transition-colors focus:outline-none focus:ring-2 focus:ring-civic-blue rounded"
            aria-label={expanded ? `Collapse ${org.name}` : `Expand ${org.name}`}
          >
            <span aria-hidden="true" className="font-mono text-xs">
              {expanded ? '▼' : '▶'}
            </span>
          </button>
        </td>

        {/* Organization name */}
        <td className="px-4 py-3">
          <div className="flex flex-col gap-1">
            <a
              href={`/money-graph?entity=${org.id}`}
              onClick={e => e.stopPropagation()}
              className="font-medium text-civic-blue hover:underline leading-tight"
            >
              {org.name}
            </a>
          </div>
        </td>

        {/* Type */}
        <td className="px-4 py-3 whitespace-nowrap">
          <OrgTypeBadge orgType={org.orgType} />
        </td>

        {/* Total spending */}
        <td className="px-4 py-3 whitespace-nowrap">
          <span className="font-mono font-semibold text-civic-navy text-sm">
            {org.totalSpending > 0 ? formatDollars(org.totalSpending) : '—'}
          </span>
        </td>

        {/* Top recipients (summary) */}
        <td className="px-4 py-3">
          {org.topRecipients.length > 0 ? (
            <span className="text-xs text-slate-600 truncate max-w-[200px] block" title={org.topRecipients[0].name}>
              {org.topRecipients[0].name}
              {org.topRecipients.length > 1 && (
                <span className="text-slate-400 ml-1">+{org.topRecipients.length - 1} more</span>
              )}
            </span>
          ) : (
            <span className="text-xs text-slate-400">—</span>
          )}
        </td>

        {/* Disclosure rating */}
        <td className="px-4 py-3 whitespace-nowrap">
          <DisclosureBadge rating={org.disclosureRating} />
        </td>

        {/* Money graph link */}
        <td className="px-4 py-3 whitespace-nowrap">
          <a
            href={`/money-graph?entity=${org.id}`}
            onClick={e => e.stopPropagation()}
            className="text-xs text-civic-blue hover:text-blue-800 hover:underline font-medium transition-colors"
            aria-label={`View money flow for ${org.name}`}
          >
            Flow graph &#8594;
          </a>
        </td>
      </tr>

      {expanded && <ExpandedRow org={org} colSpan={7} />}
    </>
  );
}

function LoadingRows() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <tr key={i} className="animate-pulse border-b border-slate-100">
          {Array.from({ length: 7 }).map((_, j) => (
            <td key={j} className="px-4 py-3">
              <div className={`h-4 bg-slate-100 rounded ${j === 1 ? 'w-full' : 'w-3/4'}`} />
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
      <td colSpan={7} className="py-16 text-center">
        <p className="text-civic-slate font-medium">
          {hasFilters ? 'No organizations match your filters.' : 'No organizations found.'}
        </p>
        {hasFilters && (
          <p className="text-sm text-slate-400 mt-1">Try broadening your search or adjusting the filters.</p>
        )}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function DarkMoneyTracker() {
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
  const [committedFilters, setCommittedFilters] = useState<FilterState>(INITIAL_FILTERS);

  const [orgs, setOrgs] = useState<DarkMoneyOrg[]>([]);
  const [pagination, setPagination] = useState<Pagination>({ page: 1, limit: 50, total: 0, pages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const [sortField, setSortField] = useState<SortField>('totalSpending');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);

  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Build query params from committed filters + page.
  const buildParams = useCallback(
    (overridePage?: number): URLSearchParams => {
      const params = new URLSearchParams();
      params.set('type', 'entity');
      if (committedFilters.searchQuery) params.set('q', committedFilters.searchQuery);
      if (committedFilters.minSpending) params.set('min_spending', committedFilters.minSpending);
      if (committedFilters.maxSpending) params.set('max_spending', committedFilters.maxSpending);
      if (committedFilters.cycle) params.set('cycle', committedFilters.cycle);
      if (committedFilters.orgType) params.set('entity_type', committedFilters.orgType);
      params.set('page', String(overridePage ?? page));
      params.set('limit', '50');
      return params;
    },
    [committedFilters, page]
  );

  // Fetch organizations whenever committed filters or page change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function fetchOrgs() {
      try {
        const params = buildParams();
        const q = params.get('q') ?? '';
        // If no search query, use a broad entity search endpoint
        const url = q
          ? `/api/search?${params}`
          : `/api/search?${params}&q=`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const data: ApiResponse = await res.json();
        if (cancelled) return;
        const mapped = (data.results?.entities ?? []).map(mapApiEntityToOrg);
        setOrgs(mapped);
        setPagination(
          data.pagination ?? { page: 1, limit: 50, total: mapped.length, pages: 1 }
        );
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load organizations');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchOrgs();
    return () => { cancelled = true; };
  }, [buildParams]);

  // Debounced search-as-you-type: commit query automatically after 400 ms.
  function handleSearchChange(value: string) {
    setFilters(f => ({ ...f, searchQuery: value }));
    clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setPage(1);
      setCommittedFilters(f => ({ ...f, searchQuery: value }));
    }, 400);
  }

  function handleApplyFilters() {
    setPage(1);
    setExpandedIds(new Set());
    setCommittedFilters({ ...filters });
  }

  function handleResetFilters() {
    clearTimeout(searchDebounceRef.current);
    setFilters(INITIAL_FILTERS);
    setPage(1);
    setExpandedIds(new Set());
    setCommittedFilters(INITIAL_FILTERS);
  }

  // Client-side sort within the current page.
  const sortedOrgs = [...orgs].sort((a, b) => {
    let cmp = 0;
    if (sortField === 'name') {
      cmp = a.name.localeCompare(b.name);
    } else if (sortField === 'totalSpending') {
      cmp = a.totalSpending - b.totalSpending;
    } else if (sortField === 'disclosureRating') {
      const order: DisclosureRating[] = ['none', 'partial', 'full'];
      cmp = order.indexOf(a.disclosureRating) - order.indexOf(b.disclosureRating);
    } else if (sortField === 'filedYear') {
      cmp = a.filedYear - b.filedYear;
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

  function toggleExpanded(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const hasActiveFilters =
    committedFilters.searchQuery !== '' ||
    committedFilters.minSpending !== '' ||
    committedFilters.maxSpending !== '' ||
    committedFilters.cycle !== '' ||
    committedFilters.orgType !== '';

  // Derive summary stats from the current result set.
  const totalTracked = pagination.total;
  const totalSpending = orgs.reduce((sum, o) => sum + o.totalSpending, 0);
  const topCycleEntry = orgs
    .flatMap(o => o.spendingByCycle)
    .reduce(
      (best, c) => (c.amount > best.amount ? c : best),
      { cycle: '—', amount: 0 }
    );

  return (
    <div className="flex flex-col gap-6">

      {/* Summary stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          label="Organizations tracked"
          value={loading ? '—' : totalTracked.toLocaleString()}
          sub="501(c)(4)s, 501(c)(6)s, and related entities"
        />
        <StatCard
          label="Total outside spending"
          value={loading ? '—' : formatDollars(totalSpending)}
          accent="warning"
          sub="Across all tracked cycles"
        />
        <StatCard
          label="Top spending cycle"
          value={loading ? '—' : topCycleEntry.cycle}
          accent="danger"
          sub={topCycleEntry.amount > 0 ? formatDollars(topCycleEntry.amount) + ' in outside spending' : 'No cycle data yet'}
        />
      </div>

      {/* Filter bar */}
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <div className="flex flex-wrap gap-3 items-end">

          {/* Organization name search */}
          <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
            <label htmlFor="filter-query" className="text-xs font-medium text-slate-600">
              Organization name
            </label>
            <input
              id="filter-query"
              type="search"
              placeholder="Search by name..."
              value={filters.searchQuery}
              onChange={e => handleSearchChange(e.target.value)}
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
            />
          </div>

          {/* Organization type */}
          <div className="flex flex-col gap-1 min-w-[150px]">
            <label htmlFor="filter-org-type" className="text-xs font-medium text-slate-600">
              Org type
            </label>
            <select
              id="filter-org-type"
              value={filters.orgType}
              onChange={e => setFilters(f => ({ ...f, orgType: e.target.value }))}
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
            >
              <option value="">All types</option>
              <option value="501c4">501(c)(4)</option>
              <option value="501c6">501(c)(6)</option>
              <option value="501c3">501(c)(3)</option>
              <option value="super_pac">Super PAC</option>
              <option value="other">Other</option>
            </select>
          </div>

          {/* Election cycle */}
          <div className="flex flex-col gap-1 min-w-[140px]">
            <label htmlFor="filter-cycle" className="text-xs font-medium text-slate-600">
              Election cycle
            </label>
            <select
              id="filter-cycle"
              value={filters.cycle}
              onChange={e => setFilters(f => ({ ...f, cycle: e.target.value }))}
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
            >
              <option value="">All cycles</option>
              {ELECTION_CYCLES.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </div>

          {/* Min spending */}
          <div className="flex flex-col gap-1 min-w-[120px]">
            <label htmlFor="filter-min-spending" className="text-xs font-medium text-slate-600">
              Min spending ($)
            </label>
            <input
              id="filter-min-spending"
              type="number"
              min="0"
              step="100000"
              placeholder="e.g. 100000"
              value={filters.minSpending}
              onChange={e => setFilters(f => ({ ...f, minSpending: e.target.value }))}
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
            />
          </div>

          {/* Max spending */}
          <div className="flex flex-col gap-1 min-w-[120px]">
            <label htmlFor="filter-max-spending" className="text-xs font-medium text-slate-600">
              Max spending ($)
            </label>
            <input
              id="filter-max-spending"
              type="number"
              min="0"
              step="100000"
              placeholder="No limit"
              value={filters.maxSpending}
              onChange={e => setFilters(f => ({ ...f, maxSpending: e.target.value }))}
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
            />
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
            {committedFilters.searchQuery && ` — name: "${committedFilters.searchQuery}"`}
            {committedFilters.orgType && ` — type: ${ORG_TYPE_LABELS[committedFilters.orgType] ?? committedFilters.orgType}`}
            {committedFilters.cycle && ` — cycle: ${committedFilters.cycle}`}
            {committedFilters.minSpending && ` — min: ${formatDollars(Number(committedFilters.minSpending))}`}
            {committedFilters.maxSpending && ` — max: ${formatDollars(Number(committedFilters.maxSpending))}`}
          </p>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 text-civic-red rounded-lg px-4 py-3 text-sm"
        >
          Failed to load organization data: {error}
        </div>
      )}

      {/* Results table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">

        {/* Table header bar */}
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <h2 className="font-semibold text-civic-navy text-sm">
            Dark Money Organizations
            {!loading && (
              <span className="ml-2 text-xs font-normal text-civic-slate">
                {pagination.total.toLocaleString()} total
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
          <table
            className="w-full text-sm"
            aria-label="Dark money organizations"
          >
            <thead>
              <tr className="border-b border-slate-100 bg-slate-50">
                {/* Toggle column */}
                <th className="px-4 py-3 w-8" aria-label="Expand row" />

                <th className="px-4 py-3 text-left">
                  <SortButton field="name" currentField={sortField} currentDir={sortDir} onSort={handleSort}>
                    Organization
                  </SortButton>
                </th>
                <th className="px-4 py-3 text-left">
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Type</span>
                </th>
                <th className="px-4 py-3 text-left">
                  <SortButton field="totalSpending" currentField={sortField} currentDir={sortDir} onSort={handleSort}>
                    Total Spending
                  </SortButton>
                </th>
                <th className="px-4 py-3 text-left">
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Top Recipient</span>
                </th>
                <th className="px-4 py-3 text-left">
                  <SortButton field="disclosureRating" currentField={sortField} currentDir={sortDir} onSort={handleSort}>
                    Disclosure
                  </SortButton>
                </th>
                <th className="px-4 py-3 text-left">
                  <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Flow</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <LoadingRows />
              ) : sortedOrgs.length === 0 ? (
                <EmptyState hasFilters={hasActiveFilters} />
              ) : (
                sortedOrgs.map(org => (
                  <OrgRow
                    key={org.id}
                    org={org}
                    expanded={expandedIds.has(org.id)}
                    onToggle={() => toggleExpanded(org.id)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {!loading && pagination.pages > 1 && (
          <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-between">
            <p className="text-xs text-civic-slate">
              Page {pagination.page} of {pagination.pages} ({pagination.total.toLocaleString()} organizations)
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
        Spending data sourced from FEC filings, IRS Form 990s, and OpenSecrets. 501(c)(4) and 501(c)(6)
        organizations are not required to disclose donors, making complete tracing of fund origins
        impossible. Disclosure ratings reflect the degree to which the organization has voluntarily
        published donor information. Data may be incomplete for recent election cycles.
      </p>

    </div>
  );
}
