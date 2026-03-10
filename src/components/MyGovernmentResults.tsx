import { useState, useEffect, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types matching /api/civic-lookup response
// ---------------------------------------------------------------------------

interface OfficialResult {
  name: string;
  party: string | null;
  title: string;
  level: string;
  branch: string;
  photo_url: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  channels: Array<{ type: string; id: string }>;
  division: string;
  slug: string | null;
}

interface LookupResponse {
  address: string;
  normalized: { city: string; state: string; zip: string } | null;
  officials: OfficialResult[];
  jurisdictions: {
    state: { name: string; slug: string } | null;
    county: { name: string; slug: string } | null;
    city: { name: string; slug: string } | null;
  };
  congressionalDistrict: string | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PartyBadge({ party }: { party: string | null }) {
  if (!party) return null;
  const colors: Record<string, string> = {
    Democrat: 'bg-blue-100 text-blue-700 border-blue-200',
    Democratic: 'bg-blue-100 text-blue-700 border-blue-200',
    'Democratic Party': 'bg-blue-100 text-blue-700 border-blue-200',
    Republican: 'bg-red-100 text-red-700 border-red-200',
    'Republican Party': 'bg-red-100 text-red-700 border-red-200',
    Independent: 'bg-slate-100 text-slate-600 border-slate-200',
    Libertarian: 'bg-yellow-100 text-yellow-700 border-yellow-200',
    'Libertarian Party': 'bg-yellow-100 text-yellow-700 border-yellow-200',
    Green: 'bg-green-100 text-green-700 border-green-200',
    Nonpartisan: 'bg-slate-50 text-slate-500 border-slate-200',
  };
  const cls = colors[party] ?? 'bg-slate-100 text-slate-600 border-slate-200';
  const short = party.replace(/ Party$/, '');
  return <span className={`text-xs font-medium px-2 py-0.5 rounded border ${cls}`}>{short}</span>;
}

function LevelBadge({ level }: { level: string }) {
  const colors: Record<string, string> = {
    federal: 'bg-civic-navy text-white',
    state: 'bg-blue-600 text-white',
    county: 'bg-amber-100 text-amber-800',
    city: 'bg-green-100 text-green-800',
    special: 'bg-slate-100 text-slate-600',
    other: 'bg-slate-100 text-slate-600',
  };
  return (
    <span className={`text-xs font-semibold px-2 py-0.5 rounded uppercase tracking-wide ${colors[level] ?? colors.other}`}>
      {level}
    </span>
  );
}

function OfficialCard({ official }: { official: OfficialResult }) {
  const initials = official.name
    .split(' ')
    .map((n) => n[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('');

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4 flex gap-3 hover:border-blue-400 hover:-translate-y-px transition-all">
      {/* Avatar */}
      <div className="shrink-0">
        {official.photo_url ? (
          <img
            src={official.photo_url}
            alt={official.name}
            className="w-14 h-14 rounded-full object-cover bg-slate-100 border border-slate-200"
            loading="lazy"
          />
        ) : (
          <div className="w-14 h-14 rounded-full bg-civic-navy text-white flex items-center justify-center text-sm font-bold">
            {initials}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap mb-0.5">
          {official.slug ? (
            <a href={'/officials/' + official.slug} className="font-semibold text-civic-navy text-sm hover:text-blue-600 no-underline">
              {official.name}
            </a>
          ) : (
            <span className="font-semibold text-civic-navy text-sm">{official.name}</span>
          )}
          <PartyBadge party={official.party} />
        </div>
        <p className="text-xs text-slate-500 mb-1">{official.title}</p>
        <p className="text-xs text-slate-400">{official.division}</p>

        <div className="flex gap-3 mt-2 flex-wrap">
          {official.website && (
            <a href={official.website} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline no-underline">
              Website
            </a>
          )}
          {official.email && (
            <a href={'mailto:' + official.email} className="text-xs text-blue-600 hover:underline no-underline">
              Email
            </a>
          )}
          {official.phone && (
            <a href={'tel:' + official.phone} className="text-xs text-blue-600 hover:underline no-underline">
              {official.phone}
            </a>
          )}
          {official.slug && (
            <a href={'/officials/' + official.slug} className="text-xs text-blue-600 hover:underline no-underline font-medium">
              Full Profile &rarr;
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function OfficialsByLevel({ officials, level, label }: { officials: OfficialResult[]; level: string; label: string }) {
  const filtered = officials.filter(o => o.level === level);
  if (filtered.length === 0) return null;

  // Group by branch within level
  const byBranch: Record<string, OfficialResult[]> = {};
  for (const o of filtered) {
    const b = o.branch;
    if (!byBranch[b]) byBranch[b] = [];
    byBranch[b].push(o);
  }
  const branchOrder = ['executive', 'legislative', 'judicial'];
  const sortedBranches = Object.keys(byBranch).sort((a, b) => branchOrder.indexOf(a) - branchOrder.indexOf(b));

  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-4">
        <LevelBadge level={level} />
        <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">{label}</h3>
        <div className="flex-1 h-px bg-slate-200" />
        <span className="text-xs text-slate-400">{filtered.length} officials</span>
      </div>

      {sortedBranches.map(branch => (
        <div key={branch} className="mb-4">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2 ml-1 capitalize">{branch}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {byBranch[branch].map((official, i) => (
              <OfficialCard key={official.name + i} official={official} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function JurisdictionSidebar({ data }: { data: LookupResponse }) {
  return (
    <div className="space-y-4">
      {/* Location summary */}
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Your Location</h3>
        {data.normalized && (
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">City</span>
              <span className="font-medium text-slate-800">{data.normalized.city}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">State</span>
              <span className="font-medium text-slate-800">{data.normalized.state}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">ZIP</span>
              <span className="font-medium text-slate-800 font-mono">{data.normalized.zip}</span>
            </div>
            {data.congressionalDistrict && (
              <div className="flex justify-between">
                <span className="text-slate-500">District</span>
                <span className="font-medium text-slate-800">
                  {data.normalized.state}-{data.congressionalDistrict.padStart(2, '0')}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Jurisdiction links */}
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Explore</h3>
        <div className="space-y-2">
          {data.jurisdictions.state && (
            <a href={'/states/' + data.jurisdictions.state.slug} className="block text-sm text-blue-600 hover:underline no-underline">
              {data.jurisdictions.state.name} &rarr;
            </a>
          )}
          {data.jurisdictions.county && (
            <a href={'/counties/' + data.jurisdictions.county.slug} className="block text-sm text-blue-600 hover:underline no-underline">
              {data.jurisdictions.county.name} &rarr;
            </a>
          )}
          {data.jurisdictions.city && (
            <a href={'/cities/' + data.jurisdictions.city.slug} className="block text-sm text-blue-600 hover:underline no-underline">
              {data.jurisdictions.city.name} &rarr;
            </a>
          )}
        </div>
      </div>

      {/* Quick links */}
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Related</h3>
        <div className="space-y-2 text-sm">
          <a href="/elections/lookup" className="block text-blue-600 hover:underline no-underline">Voter Registration &rarr;</a>
          <a href="/money/graph" className="block text-blue-600 hover:underline no-underline">Money Graph &rarr;</a>
          <a href="/conflicts" className="block text-blue-600 hover:underline no-underline">Conflict Alerts &rarr;</a>
        </div>
      </div>

      {/* Stats */}
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Summary</h3>
        <div className="grid grid-cols-2 gap-3">
          {['federal', 'state', 'county', 'city'].map(level => {
            const count = data.officials.filter(o => o.level === level).length;
            if (count === 0) return null;
            return (
              <div key={level} className="text-center">
                <p className="text-lg font-bold text-civic-navy">{count}</p>
                <p className="text-xs text-slate-500 capitalize">{level}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-6" role="status" aria-label="Loading your representatives">
      <div className="h-5 bg-slate-200 rounded w-48" />
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <div key={n} className="bg-white rounded-lg border border-slate-200 p-4 flex gap-3">
            <div className="w-14 h-14 rounded-full bg-slate-200 shrink-0" />
            <div className="flex-1 space-y-2 pt-1">
              <div className="h-3.5 bg-slate-200 rounded w-3/4" />
              <div className="h-3 bg-slate-100 rounded w-1/2" />
              <div className="h-3 bg-slate-100 rounded w-2/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface MyGovernmentResultsProps {
  initialAddress?: string;
}

type FetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; data: LookupResponse };

export default function MyGovernmentResults({ initialAddress = '' }: MyGovernmentResultsProps) {
  const [fetchState, setFetchState] = useState<FetchState>({ status: 'idle' });

  const fetchData = useCallback(async (address: string) => {
    setFetchState({ status: 'loading' });
    try {
      const res = await fetch('/api/civic-lookup?address=' + encodeURIComponent(address));
      const json = await res.json();
      if (!res.ok) {
        setFetchState({ status: 'error', message: json.error ?? 'Failed to look up address.' });
        return;
      }
      setFetchState({ status: 'success', data: json as LookupResponse });
    } catch {
      setFetchState({ status: 'error', message: 'Network error — please check your connection.' });
    }
  }, []);

  useEffect(() => {
    if (initialAddress && initialAddress.length >= 5) {
      void fetchData(initialAddress);
    }
  }, []);

  // Listen for address searches from the hero form
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ address: string }>).detail;
      if (detail?.address && detail.address.length >= 5) {
        void fetchData(detail.address);
      }
    };
    window.addEventListener('govguide:address-search', handler);
    return () => window.removeEventListener('govguide:address-search', handler);
  }, [fetchData]);

  if (fetchState.status === 'idle') {
    return (
      <div className="py-16 text-center text-slate-400">
        <div className="text-5xl mb-4" aria-hidden="true">&#127970;</div>
        <p className="text-lg font-semibold text-slate-700 mb-2">Enter Your Address Above</p>
        <p className="text-sm max-w-md mx-auto">
          We'll show every elected official who represents you — federal, state, county, and local —
          along with their contact info and links to their donor and conflict data.
        </p>
      </div>
    );
  }

  if (fetchState.status === 'loading') return <LoadingSkeleton />;

  if (fetchState.status === 'error') {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg px-5 py-4 text-sm text-red-700">
        {fetchState.message}
      </div>
    );
  }

  const { data } = fetchState;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-8">
      {/* Main content — officials by level */}
      <div className="lg:col-span-3">
        <div className="mb-6 pb-4 border-b border-slate-200">
          <p className="text-sm text-slate-500">
            Showing <strong className="text-slate-800">{data.officials.length} officials</strong> representing
          </p>
          <p className="text-lg font-semibold text-civic-navy mt-1">{data.address}</p>
        </div>

        <OfficialsByLevel officials={data.officials} level="federal" label="Federal Government" />
        <OfficialsByLevel officials={data.officials} level="state" label="State Government" />
        <OfficialsByLevel officials={data.officials} level="county" label="County Government" />
        <OfficialsByLevel officials={data.officials} level="city" label="City / Municipal Government" />
        <OfficialsByLevel officials={data.officials} level="special" label="Special Districts" />
        <OfficialsByLevel officials={data.officials} level="other" label="Other" />
      </div>

      {/* Sidebar */}
      <div className="lg:col-span-1">
        <JurisdictionSidebar data={data} />
      </div>
    </div>
  );
}
