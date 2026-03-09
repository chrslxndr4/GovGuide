import { useState, useEffect, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RaceType = 'all' | 'presidential' | 'senate' | 'house' | 'governor';

interface PollCandidate {
  name: string;
  party: string;
  poll_average: number;
  trend: number; // positive = up, negative = down, in percentage points
}

interface PollRace {
  id: string;
  race_name: string;
  race_type: Exclude<RaceType, 'all'>;
  state: string;
  cycle: number;
  candidates: PollCandidate[];
  num_polls: number;
  last_updated: string;
}

interface PredictionMarket {
  id: string;
  race_id: string;
  race_name: string;
  race_type: Exclude<RaceType, 'all'>;
  state: string;
  cycle: number;
  question: string;
  market_source: 'polymarket' | 'kalshi' | 'metaculus' | 'predictit';
  candidate: string;
  party: string;
  probability: number; // 0–1
  price: number; // cents / shares
  volume_usd: number;
  change_24h: number; // percentage-point change in probability
  last_updated: string;
  divergence_alert: boolean; // true when market & polling diverge significantly
}

interface ElectionsApiResponse {
  polls: PollRace[];
  markets: PredictionMarket[];
}

interface FilterState {
  raceType: RaceType;
  state: string;
}

const INITIAL_FILTERS: FilterState = {
  raceType: 'all',
  state: '',
};

const RACE_TYPE_LABELS: Record<RaceType, string> = {
  all: 'All Races',
  presidential: 'Presidential',
  senate: 'Senate',
  house: 'House',
  governor: 'Governor',
};

const MARKET_SOURCE_LABELS: Record<PredictionMarket['market_source'], string> = {
  polymarket: 'Polymarket',
  kalshi: 'Kalshi',
  metaculus: 'Metaculus',
  predictit: 'PredictIt',
};

const PARTY_COLORS: Record<string, string> = {
  D: 'bg-blue-500',
  R: 'bg-red-500',
  I: 'bg-slate-400',
  L: 'bg-amber-400',
  G: 'bg-emerald-500',
};

const PARTY_TEXT: Record<string, string> = {
  D: 'text-blue-700',
  R: 'text-red-700',
  I: 'text-slate-600',
  L: 'text-amber-700',
  G: 'text-emerald-700',
};

// US state list for filter dropdown
const US_STATES: [string, string][] = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'],
  ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
  ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'],
  ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'], ['KS', 'Kansas'],
  ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'],
  ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'],
  ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'],
  ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'], ['OK', 'Oklahoma'],
  ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
  ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'],
  ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'], ['WY', 'Wyoming'], ['DC', 'D.C.'],
];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatProbability(p: number): string {
  return `${Math.round(p * 100)}%`;
}

function formatVolume(usd: number): string {
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(1)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(0)}K`;
  return `$${usd.toLocaleString()}`;
}

function trendSign(t: number): string {
  if (t > 0) return `+${t.toFixed(1)}`;
  if (t < 0) return `${t.toFixed(1)}`;
  return '—';
}

function trendClass(t: number): string {
  if (t > 0) return 'text-emerald-600';
  if (t < 0) return 'text-red-600';
  return 'text-slate-400';
}

function partyBarClass(party: string): string {
  return PARTY_COLORS[party] ?? 'bg-slate-400';
}

function partyTextClass(party: string): string {
  return PARTY_TEXT[party] ?? 'text-slate-600';
}

function probabilityBarClass(p: number): string {
  if (p >= 0.7) return 'bg-emerald-500';
  if (p >= 0.4) return 'bg-amber-400';
  return 'bg-red-400';
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function RaceTypeBadge({ type }: { type: Exclude<RaceType, 'all'> }) {
  const cls: Record<Exclude<RaceType, 'all'>, string> = {
    presidential: 'bg-civic-navy text-white',
    senate: 'bg-blue-100 text-blue-800',
    house: 'bg-slate-100 text-slate-700',
    governor: 'bg-purple-100 text-purple-800',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide ${cls[type]}`}>
      {RACE_TYPE_LABELS[type]}
    </span>
  );
}

function DivergenceAlert() {
  return (
    <span
      title="Prediction market and polling averages diverge significantly"
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-100 text-red-700 border border-red-200"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="w-3 h-3"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
          clipRule="evenodd"
        />
      </svg>
      Divergence
    </span>
  );
}

function PollBar({ candidate, maxAvg }: { candidate: PollCandidate; maxAvg: number }) {
  const pct = maxAvg > 0 ? (candidate.poll_average / maxAvg) * 100 : 0;
  return (
    <div className="flex items-center gap-2 text-sm">
      <div className="w-28 flex items-center gap-1.5 shrink-0">
        <span className={`w-2 h-2 rounded-full ${partyBarClass(candidate.party)} shrink-0`} aria-hidden="true" />
        <span className={`font-medium truncate ${partyTextClass(candidate.party)}`} title={candidate.name}>
          {candidate.name.split(' ').pop()}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full ${partyBarClass(candidate.party)} opacity-80`}
            style={{ width: `${pct}%` }}
            aria-hidden="true"
          />
        </div>
      </div>
      <span className="w-10 text-right font-mono text-xs text-slate-700 shrink-0">
        {candidate.poll_average.toFixed(1)}%
      </span>
      <span className={`w-10 text-right font-mono text-xs shrink-0 ${trendClass(candidate.trend)}`}>
        {trendSign(candidate.trend)}
      </span>
    </div>
  );
}

function PollCard({ race }: { race: PollRace }) {
  const maxAvg = Math.max(...race.candidates.map(c => c.poll_average));

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <p className="font-semibold text-civic-navy text-sm leading-tight">{race.race_name}</p>
          <p className="text-xs text-civic-slate mt-0.5">{race.state} &middot; {race.cycle}</p>
        </div>
        <RaceTypeBadge type={race.race_type} />
      </div>

      <div className="flex flex-col gap-1.5">
        {race.candidates.map(c => (
          <PollBar key={c.name} candidate={c} maxAvg={maxAvg} />
        ))}
      </div>

      <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between">
        <span className="text-[11px] text-slate-400">
          {race.num_polls} poll{race.num_polls !== 1 ? 's' : ''} averaged
        </span>
        <time dateTime={race.last_updated} className="text-[11px] text-slate-400 font-mono">
          Updated {formatDate(race.last_updated)}
        </time>
      </div>
    </div>
  );
}

function MarketCard({ market }: { market: PredictionMarket }) {
  const probPct = market.probability * 100;
  const change24h = market.change_24h;

  return (
    <div className={`bg-white border rounded-lg p-4 hover:shadow-sm transition-shadow ${
      market.divergence_alert ? 'border-red-200' : 'border-slate-200'
    }`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5 mb-1">
            <RaceTypeBadge type={market.race_type} />
            {market.divergence_alert && <DivergenceAlert />}
          </div>
          <p className="font-semibold text-civic-navy text-sm leading-tight">{market.question}</p>
          <p className="text-xs text-civic-slate mt-0.5">{market.state} &middot; {market.cycle}</p>
        </div>
      </div>

      {/* Probability meter */}
      <div className="mb-3">
        <div className="flex items-end justify-between mb-1">
          <span className={`text-2xl font-display font-bold tabular-nums ${partyTextClass(market.party)}`}>
            {formatProbability(market.probability)}
          </span>
          <span className={`text-sm font-mono font-medium ${trendClass(change24h)}`}>
            {change24h > 0 ? '+' : ''}{change24h.toFixed(1)}pp <span className="text-xs text-slate-400 font-normal">24h</span>
          </span>
        </div>
        <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${probabilityBarClass(market.probability)}`}
            style={{ width: `${probPct}%` }}
            aria-label={`${formatProbability(market.probability)} probability`}
          />
        </div>
        <div className="flex justify-between mt-0.5">
          <span className="text-[10px] text-slate-400">0%</span>
          <span className="text-[10px] text-slate-400">50%</span>
          <span className="text-[10px] text-slate-400">100%</span>
        </div>
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${partyBarClass(market.party)}`}
            aria-hidden="true"
          />
          <span className="text-xs text-slate-600 font-medium">{market.candidate}</span>
        </div>
        <span className="text-[11px] text-slate-400">
          Vol: <span className="font-mono font-medium text-slate-600">{formatVolume(market.volume_usd)}</span>
        </span>
        <span className="text-[11px] bg-slate-100 text-slate-500 px-2 py-0.5 rounded font-medium">
          {MARKET_SOURCE_LABELS[market.market_source]}
        </span>
      </div>

      <time dateTime={market.last_updated} className="block text-[10px] text-slate-400 font-mono mt-2">
        Updated {formatDate(market.last_updated)}
      </time>
    </div>
  );
}

function SkeletonCard({ tall }: { tall?: boolean }) {
  return (
    <div className={`bg-white border border-slate-200 rounded-lg p-4 animate-pulse ${tall ? 'min-h-[180px]' : 'min-h-[140px]'}`}>
      <div className="h-4 bg-slate-100 rounded w-3/4 mb-2" />
      <div className="h-3 bg-slate-100 rounded w-1/2 mb-4" />
      <div className="space-y-2">
        <div className="h-2 bg-slate-100 rounded" />
        <div className="h-2 bg-slate-100 rounded w-5/6" />
        <div className="h-2 bg-slate-100 rounded w-4/5" />
      </div>
    </div>
  );
}

function EmptySection({ message }: { message: string }) {
  return (
    <div className="col-span-full py-10 text-center">
      <p className="text-civic-slate text-sm">{message}</p>
    </div>
  );
}

function SectionHeader({ title, count, note }: { title: string; count?: number; note?: string }) {
  return (
    <div className="flex items-baseline gap-3 mb-4">
      <h2 className="text-xl font-display font-bold text-civic-navy">{title}</h2>
      {count !== undefined && (
        <span className="text-sm text-civic-slate">
          {count.toLocaleString()} race{count !== 1 ? 's' : ''}
        </span>
      )}
      {note && <span className="ml-auto text-xs text-slate-400">{note}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function PredictionsDashboard() {
  const [filters, setFilters] = useState<FilterState>(INITIAL_FILTERS);
  const [polls, setPolls] = useState<PollRace[]>([]);
  const [markets, setMarkets] = useState<PredictionMarket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const buildParams = useCallback((): URLSearchParams => {
    const params = new URLSearchParams();
    if (filters.raceType !== 'all') params.set('race_type', filters.raceType);
    if (filters.state) params.set('state', filters.state);
    return params;
  }, [filters]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function fetchData() {
      try {
        const res = await fetch(`/api/elections?${buildParams()}`);
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const data: ElectionsApiResponse = await res.json();
        if (cancelled) return;
        setPolls(data.polls ?? []);
        setMarkets(data.markets ?? []);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load data');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchData();
    return () => {
      cancelled = true;
    };
  }, [buildParams]);

  function handleFilterChange(partial: Partial<FilterState>) {
    setFilters(f => ({ ...f, ...partial }));
  }

  const hasActiveFilters = filters.raceType !== 'all' || filters.state !== '';

  const divergenceCount = markets.filter(m => m.divergence_alert).length;

  return (
    <div className="flex flex-col gap-8">

      {/* Divergence alert banner */}
      {!loading && divergenceCount > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-center gap-3">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-5 h-5 text-red-500 shrink-0"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
              clipRule="evenodd"
            />
          </svg>
          <p className="text-sm text-red-800">
            <strong>{divergenceCount}</strong> market{divergenceCount !== 1 ? 's' : ''} show
            significant divergence from polling averages. These races may warrant closer scrutiny.
          </p>
        </div>
      )}

      {/* Filter controls */}
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <div className="flex flex-wrap gap-3 items-end">

          {/* Race type */}
          <div className="flex flex-col gap-1 min-w-[160px]">
            <label htmlFor="filter-race-type" className="text-xs font-medium text-slate-600">
              Race Type
            </label>
            <select
              id="filter-race-type"
              value={filters.raceType}
              onChange={e => handleFilterChange({ raceType: e.target.value as RaceType })}
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
            >
              {(Object.entries(RACE_TYPE_LABELS) as [RaceType, string][]).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          {/* State */}
          <div className="flex flex-col gap-1 min-w-[160px]">
            <label htmlFor="filter-state" className="text-xs font-medium text-slate-600">
              State
            </label>
            <select
              id="filter-state"
              value={filters.state}
              onChange={e => handleFilterChange({ state: e.target.value })}
              className="border border-slate-300 rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
            >
              <option value="">All States</option>
              {US_STATES.map(([abbr, name]) => (
                <option key={abbr} value={abbr}>
                  {name}
                </option>
              ))}
            </select>
          </div>

          {/* Reset */}
          {hasActiveFilters && (
            <button
              onClick={() => setFilters(INITIAL_FILTERS)}
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
          Failed to load election data: {error}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Section 1: Polling Aggregation                                      */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="polls-heading">
        <div id="polls-heading" className="sr-only">Polling Aggregation</div>
        <SectionHeader
          title="Polling Aggregation"
          count={!loading ? polls.length : undefined}
          note="Poll averages weighted by recency and sample size"
        />

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        ) : polls.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-lg">
            <EmptySection
              message={
                hasActiveFilters
                  ? 'No polling data matches your filters.'
                  : 'No polling data available.'
              }
            />
          </div>
        ) : (
          <>
            {/* Legend */}
            <div className="flex flex-wrap gap-4 text-xs text-slate-500 mb-3">
              <span>
                Bars show poll average. Rightmost column is trend in pp vs. prior week.
              </span>
              <span className="flex items-center gap-1 text-emerald-600">
                <span aria-hidden="true">+</span> gaining
              </span>
              <span className="flex items-center gap-1 text-red-600">
                <span aria-hidden="true">−</span> losing
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {polls.map(race => (
                <PollCard key={race.id} race={race} />
              ))}
            </div>
          </>
        )}
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Section 2: Prediction Markets                                       */}
      {/* ------------------------------------------------------------------ */}
      <section aria-labelledby="markets-heading">
        <div id="markets-heading" className="sr-only">Prediction Markets</div>
        <SectionHeader
          title="Prediction Markets"
          count={!loading ? markets.length : undefined}
          note="Live odds from Polymarket, Kalshi, and Metaculus"
        />

        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonCard key={i} tall />
            ))}
          </div>
        ) : markets.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-lg">
            <EmptySection
              message={
                hasActiveFilters
                  ? 'No prediction market data matches your filters.'
                  : 'No prediction market data available.'
              }
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {markets.map(market => (
              <MarketCard key={market.id} market={market} />
            ))}
          </div>
        )}
      </section>

      {/* Disclosure */}
      <p className="text-xs text-slate-400">
        Poll averages are aggregated from public polling data and weighted by recency, methodology,
        and sample size. Prediction market probabilities reflect real-money contract prices and are
        not endorsements or forecasts by GovGuide. Divergence alerts are triggered when poll averages
        and market prices differ by more than 15 percentage points.
      </p>
    </div>
  );
}
