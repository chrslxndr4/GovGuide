import { useState, useEffect, useCallback } from 'react';

// ---------------------------------------------------------------------------
// Types matching the shape returned by /api/zip-lookup
// ---------------------------------------------------------------------------

interface Jurisdiction {
  zip_code: string;
  state_id: string | null;
  county_id: string | null;
  city_id: string | null;
  state: { id: string; name: string; slug: string } | null;
  county: { id: string; name: string; slug: string } | null;
  city: { id: string; name: string; slug: string } | null;
}

interface Office {
  title: string;
  branch: string | null;
  chamber: string | null;
  jurisdiction_id: string | null;
}

interface Official {
  id: string;
  name: string;
  party: string | null;
  photo_url: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  office: Office | null;
}

interface ZipLookupResponse {
  jurisdictions: Jurisdiction[] | null;
  officials: Official[] | null;
  error?: string;
}

// Placeholder shapes for sections not yet backed by live endpoints
interface Donor {
  name: string;
  amount: number;
  recipient: string;
  cycle: string;
}

interface ConflictAlert {
  id: string;
  official: string;
  description: string;
  severity: 'high' | 'medium' | 'low';
}

interface Election {
  id: string;
  name: string;
  date: string;
  type: string;
}

interface SpendingSummary {
  category: string;
  amount: number;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xl font-display font-bold text-civic-navy mb-4 pb-2 border-b border-slate-200">
      {children}
    </h2>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <p className="text-sm text-civic-slate italic py-4">{message}</p>
  );
}

function PartyBadge({ party }: { party: string | null }) {
  if (!party) return null;

  const colorMap: Record<string, string> = {
    Democrat: 'bg-blue-100 text-blue-800',
    Democratic: 'bg-blue-100 text-blue-800',
    Republican: 'bg-red-100 text-red-800',
    Independent: 'bg-slate-100 text-slate-700',
    Libertarian: 'bg-yellow-100 text-yellow-800',
    Green: 'bg-green-100 text-green-800',
  };

  const colorClass = colorMap[party] ?? 'bg-slate-100 text-slate-700';

  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded ${colorClass}`}>
      {party}
    </span>
  );
}

function OfficialCard({ official }: { official: Official }) {
  const initials = official.name
    .split(' ')
    .map((n) => n[0])
    .slice(0, 2)
    .join('');

  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4 flex gap-3 hover:border-civic-blue hover:shadow-sm transition-all">
      {/* Avatar */}
      <div className="shrink-0">
        {official.photo_url ? (
          <img
            src={official.photo_url}
            alt={official.name}
            className="w-12 h-12 rounded-full object-cover bg-slate-100"
          />
        ) : (
          <div
            className="w-12 h-12 rounded-full bg-civic-navy text-white flex items-center justify-center text-sm font-bold font-mono"
            aria-hidden="true"
          >
            {initials}
          </div>
        )}
      </div>

      {/* Info */}
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="font-semibold text-civic-navy text-sm truncate">{official.name}</p>
          <PartyBadge party={official.party} />
        </div>
        {official.office && (
          <p className="text-xs text-civic-slate mt-0.5 truncate">{official.office.title}</p>
        )}
        <div className="flex gap-3 mt-2 flex-wrap">
          {official.website && (
            <a
              href={official.website}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-civic-blue hover:underline"
            >
              Website
            </a>
          )}
          {official.email && (
            <a
              href={`mailto:${official.email}`}
              className="text-xs text-civic-blue hover:underline"
            >
              Email
            </a>
          )}
          {official.phone && (
            <a
              href={`tel:${official.phone}`}
              className="text-xs text-civic-blue hover:underline"
            >
              {official.phone}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function OfficialsSection({ officials }: { officials: Official[] }) {
  const grouped = officials.reduce<Record<string, Official[]>>((acc, o) => {
    const branch = o.office?.branch ?? 'Other';
    if (!acc[branch]) acc[branch] = [];
    acc[branch].push(o);
    return acc;
  }, {});

  const order = ['Executive', 'Legislative', 'Judicial', 'Other'];
  const sortedKeys = Object.keys(grouped).sort(
    (a, b) => order.indexOf(a) - order.indexOf(b),
  );

  return (
    <section aria-labelledby="officials-heading">
      <SectionHeading>
        <span id="officials-heading">Your Officials</span>
      </SectionHeading>
      {sortedKeys.length === 0 ? (
        <EmptyState message="No officials found for this ZIP code." />
      ) : (
        sortedKeys.map((branch) => (
          <div key={branch} className="mb-6">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-civic-slate mb-3">
              {branch}
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {grouped[branch].map((official) => (
                <OfficialCard key={official.id} official={official} />
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

function DonorsSection({ donors }: { donors: Donor[] }) {
  return (
    <section aria-labelledby="donors-heading">
      <SectionHeading>
        <span id="donors-heading">Top Donors in Your Area</span>
      </SectionHeading>
      {donors.length === 0 ? (
        <EmptyState message="Donor data for this area is not yet available." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-civic-slate">
              <tr>
                <th className="text-left px-4 py-2.5 font-semibold">Donor</th>
                <th className="text-left px-4 py-2.5 font-semibold">Recipient</th>
                <th className="text-right px-4 py-2.5 font-semibold">Amount</th>
                <th className="text-right px-4 py-2.5 font-semibold">Cycle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {donors.map((donor, i) => (
                <tr key={i} className="hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-civic-navy">{donor.name}</td>
                  <td className="px-4 py-3 text-civic-slate">{donor.recipient}</td>
                  <td className="px-4 py-3 text-right font-mono text-civic-navy">
                    ${donor.amount.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right text-civic-slate">{donor.cycle}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

const SEVERITY_STYLES: Record<ConflictAlert['severity'], string> = {
  high: 'border-red-300 bg-red-50',
  medium: 'border-amber-300 bg-amber-50',
  low: 'border-slate-200 bg-slate-50',
};

const SEVERITY_BADGE: Record<ConflictAlert['severity'], string> = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-slate-100 text-slate-600',
};

function AlertsSection({ alerts }: { alerts: ConflictAlert[] }) {
  return (
    <section aria-labelledby="alerts-heading">
      <SectionHeading>
        <span id="alerts-heading">Active Alerts</span>
      </SectionHeading>
      {alerts.length === 0 ? (
        <EmptyState message="No active conflict alerts for this area." />
      ) : (
        <div className="flex flex-col gap-3">
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className={`rounded-lg border px-4 py-3 ${SEVERITY_STYLES[alert.severity]}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`text-xs font-semibold px-2 py-0.5 rounded uppercase tracking-wide ${SEVERITY_BADGE[alert.severity]}`}
                >
                  {alert.severity}
                </span>
                <span className="text-sm font-semibold text-civic-navy">{alert.official}</span>
              </div>
              <p className="text-sm text-civic-slate">{alert.description}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function ElectionsSection({ elections }: { elections: Election[] }) {
  return (
    <section aria-labelledby="elections-heading">
      <SectionHeading>
        <span id="elections-heading">Upcoming Elections</span>
      </SectionHeading>
      {elections.length === 0 ? (
        <EmptyState message="No upcoming elections found for this ZIP code." />
      ) : (
        <ol className="relative border-l-2 border-slate-200 ml-3 flex flex-col gap-0">
          {elections.map((election) => (
            <li key={election.id} className="ml-6 pb-6 last:pb-0">
              {/* Timeline dot */}
              <span
                className="absolute -left-[9px] flex items-center justify-center w-4 h-4 rounded-full bg-civic-blue ring-2 ring-white"
                aria-hidden="true"
              />
              <time
                className="text-xs font-mono text-civic-slate block mb-0.5"
                dateTime={election.date}
              >
                {new Date(election.date).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </time>
              <p className="font-semibold text-civic-navy text-sm">{election.name}</p>
              <p className="text-xs text-civic-slate mt-0.5">{election.type}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SpendingSection({ spending }: { spending: SpendingSummary[] }) {
  const total = spending.reduce((sum, s) => sum + s.amount, 0);

  return (
    <section aria-labelledby="spending-heading">
      <SectionHeading>
        <span id="spending-heading">Local Spending</span>
      </SectionHeading>
      {spending.length === 0 ? (
        <EmptyState message="Local spending data is not yet available for this area." />
      ) : (
        <div className="flex flex-col gap-2">
          {spending.map((item) => {
            const pct = total > 0 ? (item.amount / total) * 100 : 0;
            return (
              <div key={item.category}>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-civic-navy font-medium">{item.category}</span>
                  <span className="font-mono text-civic-slate">
                    ${item.amount.toLocaleString()}
                  </span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-civic-blue rounded-full transition-all duration-500"
                    style={{ width: `${pct.toFixed(1)}%` }}
                    role="progressbar"
                    aria-valuenow={Math.round(pct)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`${item.category}: ${pct.toFixed(0)}% of total`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

function LoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-8" aria-label="Loading government data" role="status">
      {/* Officials skeleton */}
      <div>
        <div className="h-6 bg-slate-200 rounded w-48 mb-4" />
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <div key={n} className="bg-white rounded-lg border border-slate-200 p-4 flex gap-3">
              <div className="w-12 h-12 rounded-full bg-slate-200 shrink-0" />
              <div className="flex-1 space-y-2 pt-1">
                <div className="h-3.5 bg-slate-200 rounded w-3/4" />
                <div className="h-3 bg-slate-100 rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>
      {/* Table skeleton */}
      <div>
        <div className="h-6 bg-slate-200 rounded w-56 mb-4" />
        <div className="rounded-lg border border-slate-200 overflow-hidden">
          {[1, 2, 3].map((n) => (
            <div key={n} className="h-10 border-b border-slate-100 bg-white last:border-0 flex items-center gap-4 px-4">
              <div className="h-3 bg-slate-200 rounded w-1/4" />
              <div className="h-3 bg-slate-100 rounded w-1/3" />
              <div className="h-3 bg-slate-200 rounded w-16 ml-auto" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ZIP input sub-component used inside the results panel
// ---------------------------------------------------------------------------

interface ZipInputProps {
  initialZip: string;
  onSubmit: (zip: string) => void;
}

function ZipInput({ initialZip, onSubmit }: ZipInputProps) {
  const [value, setValue] = useState(initialZip);
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{5}$/.test(value)) {
      setError('Please enter a valid 5-digit ZIP code.');
      return;
    }
    setError('');
    onSubmit(value);
  };

  return (
    <form onSubmit={handleSubmit} className="relative max-w-sm">
      <div className="flex gap-2">
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]{5}"
          maxLength={5}
          value={value}
          onChange={(e) => {
            setValue(e.target.value.replace(/\D/g, ''));
            setError('');
          }}
          placeholder="Enter ZIP code"
          className="flex-1 px-4 py-2.5 rounded-lg border border-slate-300 text-base font-mono focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
          aria-label="ZIP code"
        />
        <button
          type="submit"
          className="px-5 py-2.5 bg-civic-blue text-white font-medium rounded-lg hover:bg-blue-700 transition-colors text-sm"
        >
          Update
        </button>
      </div>
      {error && (
        <p className="text-red-500 text-xs mt-1.5" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface MyGovernmentResultsProps {
  /** ZIP code pre-seeded from the page (URL param or hero form). Empty string means awaiting input. */
  initialZip?: string;
}

type FetchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; data: ZipLookupResponse; zip: string };

export default function MyGovernmentResults({ initialZip = '' }: MyGovernmentResultsProps) {
  const [fetchState, setFetchState] = useState<FetchState>({ status: 'idle' });
  const [activeZip, setActiveZip] = useState(initialZip);

  const fetchData = useCallback(async (zip: string) => {
    setFetchState({ status: 'loading' });
    try {
      const res = await fetch(`/api/zip-lookup?zip=${encodeURIComponent(zip)}`);
      const json: ZipLookupResponse = await res.json();
      if (!res.ok) {
        setFetchState({ status: 'error', message: json.error ?? 'Failed to load data.' });
        return;
      }
      setFetchState({ status: 'success', data: json, zip });
    } catch {
      setFetchState({
        status: 'error',
        message: 'Network error — please check your connection and try again.',
      });
    }
  }, []);

  // Auto-fetch when a ZIP is seeded on mount
  useEffect(() => {
    if (activeZip && /^\d{5}$/.test(activeZip)) {
      void fetchData(activeZip);
    }
  }, []); // intentionally runs once on mount only

  // Listen for ZIP searches submitted via the hero form (progressive enhancement).
  // The Astro page script dispatches 'govguide:zip-search' to avoid a hard reload.
  useEffect(() => {
    const handleHeroSearch = (e: Event) => {
      const detail = (e as CustomEvent<{ zip: string }>).detail;
      if (detail?.zip && /^\d{5}$/.test(detail.zip)) {
        setActiveZip(detail.zip);
        void fetchData(detail.zip);
      }
    };
    window.addEventListener('govguide:zip-search', handleHeroSearch);
    return () => window.removeEventListener('govguide:zip-search', handleHeroSearch);
  }, [fetchData]);

  const handleZipSubmit = (zip: string) => {
    setActiveZip(zip);
    // Reflect ZIP in URL without a full navigation for shareability
    const url = new URL(window.location.href);
    url.searchParams.set('zip', zip);
    window.history.replaceState(null, '', url.toString());
    void fetchData(zip);
  };

  // ------------------------------------------------------------------
  // Placeholder data for sections not yet backed by live endpoints.
  // These will be replaced with real API calls once those endpoints
  // are implemented.
  // ------------------------------------------------------------------
  const placeholderDonors: Donor[] = [];
  const placeholderAlerts: ConflictAlert[] = [];
  const placeholderElections: Election[] = [];
  const placeholderSpending: SpendingSummary[] = [];

  // Idle state — waiting for user to enter a ZIP
  if (fetchState.status === 'idle') {
    return (
      <div className="py-12 text-center text-civic-slate">
        <p className="text-lg font-display text-civic-navy mb-2">
          Enter your ZIP code above to get started.
        </p>
        <p className="text-sm">
          We will show your elected officials, local donors, conflict alerts, upcoming elections,
          and spending data.
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Results header — shows current ZIP + allows changing it */}
      {(fetchState.status === 'success' || fetchState.status === 'error') && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8 pb-6 border-b border-slate-200">
          {fetchState.status === 'success' && (
            <div>
              <p className="text-sm text-civic-slate">Showing results for</p>
              <p className="text-2xl font-display font-bold text-civic-navy font-mono">
                {fetchState.zip}
              </p>
              {fetchState.data.jurisdictions && fetchState.data.jurisdictions.length > 0 && (
                <p className="text-sm text-civic-slate mt-0.5">
                  {[
                    fetchState.data.jurisdictions[0].city?.name,
                    fetchState.data.jurisdictions[0].county?.name,
                    fetchState.data.jurisdictions[0].state?.name,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </p>
              )}
            </div>
          )}
          {fetchState.status === 'error' && (
            <div>
              <p className="text-red-600 font-medium text-sm">{fetchState.message}</p>
            </div>
          )}
          <ZipInput initialZip={activeZip} onSubmit={handleZipSubmit} />
        </div>
      )}

      {/* Loading */}
      {fetchState.status === 'loading' && <LoadingSkeleton />}

      {/* Error with retry */}
      {fetchState.status === 'error' && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-5 py-4 text-sm text-red-700">
          {fetchState.message}
        </div>
      )}

      {/* Success — render all sections */}
      {fetchState.status === 'success' && (
        <div className="space-y-10">
          <OfficialsSection officials={fetchState.data.officials ?? []} />
          <DonorsSection donors={placeholderDonors} />
          <AlertsSection alerts={placeholderAlerts} />
          <ElectionsSection elections={placeholderElections} />
          <SpendingSection spending={placeholderSpending} />
        </div>
      )}
    </div>
  );
}
