interface JurisdictionRef {
  id: string;
  name: string;
  slug: string;
}

interface ZipJurisdictionRow {
  zip_code: string;
  state: JurisdictionRef | null;
  county: JurisdictionRef | null;
  city: JurisdictionRef | null;
}

interface ElectionServices {
  id: string;
  jurisdiction_id: string;
  registration_url: string | null;
  ballot_tracking_url: string | null;
  registration_status_url: string | null;
  election_office_name: string | null;
  election_office_phone: string | null;
  election_office_email: string | null;
  election_office_address: string | null;
  has_online_registration: boolean | null;
  has_ballot_tracking: boolean | null;
  requirements: string | null;
}

interface ElectionLookupResultsProps {
  zipCode: string;
  jurisdictions: ZipJurisdictionRow[];
  electionServices: ElectionServices | null;
}

function InfoRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="py-2 border-b border-slate-100 last:border-0">
      <dt className="text-xs font-medium text-[#475569] uppercase tracking-wider">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-800">
        {href ? (
          <a href={href} className="text-[#2563EB] hover:underline">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}

export default function ElectionLookupResults({
  zipCode,
  jurisdictions,
  electionServices,
}: ElectionLookupResultsProps) {
  if (jurisdictions.length === 0) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-lg p-6 text-center">
        <div className="text-4xl mb-3" aria-hidden="true">&#128269;</div>
        <h2 className="text-lg font-semibold text-[#1B2A4A] mb-2">
          No Results Found for ZIP {zipCode}
        </h2>
        <p className="text-sm text-[#475569] max-w-md mx-auto">
          We couldn't find jurisdiction data for this ZIP code. This may be a new or
          non-residential ZIP code. Try searching for a nearby ZIP, or visit your
          state's official election website directly.
        </p>
        <a
          href="/states"
          className="inline-block mt-4 px-4 py-2 bg-[#1B2A4A] text-white rounded-lg text-sm font-medium hover:bg-blue-900 transition-colors"
        >
          Browse States
        </a>
      </div>
    );
  }

  // Collect unique jurisdictions across all rows
  const stateRef = jurisdictions.find((r) => r.state)?.state ?? null;
  const counties = Array.from(
    new Map(
      jurisdictions
        .filter((r) => r.county)
        .map((r) => [r.county!.id, r.county!])
    ).values()
  );
  const cities = Array.from(
    new Map(
      jurisdictions
        .filter((r) => r.city)
        .map((r) => [r.city!.id, r.city!])
    ).values()
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-[#1B2A4A]">
            Results for ZIP {zipCode}
          </h2>
          {stateRef && (
            <p className="text-sm text-[#475569] mt-1">
              {stateRef.name}
              {counties.length > 0 && ` · ${counties.map((c) => c.name).join(', ')}`}
              {cities.length > 0 && ` · ${cities.map((c) => c.name).join(', ')}`}
            </p>
          )}
        </div>
        <span className="text-xs font-mono bg-slate-100 text-[#475569] px-3 py-1 rounded">
          {zipCode}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: Jurisdiction info */}
        <div className="lg:col-span-1 space-y-4">
          {/* State card */}
          {stateRef && (
            <div className="bg-white rounded-lg border border-slate-200 p-5">
              <h3 className="text-sm font-semibold text-[#1B2A4A] uppercase tracking-wide mb-3">
                State
              </h3>
              <dl>
                <InfoRow
                  label="State"
                  value={stateRef.name}
                  href={`/states/${stateRef.slug}`}
                />
                <InfoRow
                  label="Elections & Voting"
                  value={`${stateRef.name} Elections`}
                  href={`/states/${stateRef.slug}/elections`}
                />
              </dl>
            </div>
          )}

          {/* County cards */}
          {counties.length > 0 && (
            <div className="bg-white rounded-lg border border-slate-200 p-5">
              <h3 className="text-sm font-semibold text-[#1B2A4A] uppercase tracking-wide mb-3">
                {counties.length === 1 ? 'County' : 'Counties'}
              </h3>
              <dl>
                {counties.map((county) => (
                  <InfoRow
                    key={county.id}
                    label="County"
                    value={county.name}
                    href={stateRef ? `/states/${stateRef.slug}/counties/${county.slug}` : undefined}
                  />
                ))}
              </dl>
            </div>
          )}

          {/* City cards */}
          {cities.length > 0 && (
            <div className="bg-white rounded-lg border border-slate-200 p-5">
              <h3 className="text-sm font-semibold text-[#1B2A4A] uppercase tracking-wide mb-3">
                {cities.length === 1 ? 'City / Town' : 'Cities / Towns'}
              </h3>
              <dl>
                {cities.map((city) => (
                  <InfoRow
                    key={city.id}
                    label="City"
                    value={city.name}
                  />
                ))}
              </dl>
            </div>
          )}
        </div>

        {/* Right column: Voter services */}
        <div className="lg:col-span-2 space-y-4">
          {electionServices ? (
            <>
              {/* Voter action buttons */}
              <div className="bg-[#2563EB]/5 border border-[#2563EB]/20 rounded-lg p-6">
                <h3 className="text-lg font-semibold text-[#1B2A4A] mb-4">
                  {stateRef ? `${stateRef.name} Voter Services` : 'Voter Services'}
                </h3>

                <div className="flex flex-wrap gap-3 mb-6">
                  {electionServices.registration_url && (
                    <a
                      href={electionServices.registration_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2 bg-[#2563EB] text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
                    >
                      Register to Vote
                    </a>
                  )}
                  {electionServices.ballot_tracking_url && (
                    <a
                      href={electionServices.ballot_tracking_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2 bg-white border border-[#2563EB] text-[#2563EB] rounded-lg text-sm font-medium hover:bg-[#2563EB]/5 transition-colors"
                    >
                      Track Your Ballot
                    </a>
                  )}
                  {electionServices.registration_status_url && (
                    <a
                      href={electionServices.registration_status_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-4 py-2 bg-white border border-slate-300 text-[#475569] rounded-lg text-sm font-medium hover:border-[#2563EB] hover:text-[#2563EB] transition-colors"
                    >
                      Check Registration Status
                    </a>
                  )}
                </div>

                {/* Service availability badges */}
                <div className="flex flex-wrap gap-2 mb-4">
                  {electionServices.has_online_registration !== null && (
                    <span
                      className={`text-xs px-2 py-1 rounded font-medium ${
                        electionServices.has_online_registration
                          ? 'bg-green-100 text-green-700'
                          : 'bg-slate-100 text-[#475569]'
                      }`}
                    >
                      Online Registration:{' '}
                      {electionServices.has_online_registration ? 'Available' : 'Not Available'}
                    </span>
                  )}
                  {electionServices.has_ballot_tracking !== null && (
                    <span
                      className={`text-xs px-2 py-1 rounded font-medium ${
                        electionServices.has_ballot_tracking
                          ? 'bg-green-100 text-green-700'
                          : 'bg-slate-100 text-[#475569]'
                      }`}
                    >
                      Ballot Tracking:{' '}
                      {electionServices.has_ballot_tracking ? 'Available' : 'Not Available'}
                    </span>
                  )}
                </div>

                {electionServices.requirements && (
                  <div className="p-3 bg-white rounded border border-slate-200">
                    <p className="text-xs font-medium text-[#1B2A4A] mb-1">Voter Requirements</p>
                    <p className="text-sm text-[#475569]">{electionServices.requirements}</p>
                  </div>
                )}
              </div>

              {/* Election office contact */}
              {(electionServices.election_office_name ||
                electionServices.election_office_phone ||
                electionServices.election_office_email ||
                electionServices.election_office_address) && (
                <div className="bg-white rounded-lg border border-slate-200 p-5">
                  <h3 className="text-sm font-semibold text-[#1B2A4A] uppercase tracking-wide mb-3">
                    Election Office Contact
                  </h3>
                  <dl>
                    {electionServices.election_office_name && (
                      <InfoRow label="Office" value={electionServices.election_office_name} />
                    )}
                    {electionServices.election_office_phone && (
                      <InfoRow
                        label="Phone"
                        value={electionServices.election_office_phone}
                        href={`tel:${electionServices.election_office_phone.replace(/\D/g, '')}`}
                      />
                    )}
                    {electionServices.election_office_email && (
                      <InfoRow
                        label="Email"
                        value={electionServices.election_office_email}
                        href={`mailto:${electionServices.election_office_email}`}
                      />
                    )}
                    {electionServices.election_office_address && (
                      <InfoRow label="Address" value={electionServices.election_office_address} />
                    )}
                  </dl>
                </div>
              )}
            </>
          ) : (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-6 text-center">
              <p className="text-sm font-medium text-[#1B2A4A] mb-1">
                No voter service data available for this area
              </p>
              <p className="text-sm text-[#475569] mb-4">
                We don't have voter services on file for{' '}
                {stateRef ? stateRef.name : 'this jurisdiction'} yet.
                Visit your state's official election website for registration and ballot information.
              </p>
              {stateRef && (
                <a
                  href={`/states/${stateRef.slug}/elections`}
                  className="inline-block px-4 py-2 bg-[#1B2A4A] text-white rounded-lg text-sm font-medium hover:bg-blue-900 transition-colors"
                >
                  View {stateRef.name} Elections Page
                </a>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
