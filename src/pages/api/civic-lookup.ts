export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

// ---------------------------------------------------------------------------
// Google Civic divisionsByAddress response types
// ---------------------------------------------------------------------------

interface DivisionsByAddressResponse {
  normalizedInput?: {
    line1: string;
    city: string;
    state: string;
    zip: string;
  };
  divisions?: Record<string, { name: string; alsoKnownAs?: string[] }>;
}

// ---------------------------------------------------------------------------
// Our normalized output shape
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractStateAbbr(divisions: Record<string, { name: string; alsoKnownAs?: string[] }>): string | null {
  for (const divId of Object.keys(divisions)) {
    // Match ocd-division/country:us/state:ca or /district:dc
    const stateMatch = divId.match(/\/state:([a-z]{2})$/);
    if (stateMatch) return stateMatch[1].toUpperCase();
    const districtMatch = divId.match(/\/district:([a-z]{2})$/);
    if (districtMatch) return districtMatch[1].toUpperCase();
    // Also check alsoKnownAs for DC which maps district→state
    const div = divisions[divId];
    if (div.alsoKnownAs) {
      for (const aka of div.alsoKnownAs) {
        const akaState = aka.match(/\/state:([a-z]{2})$/);
        if (akaState) return akaState[1].toUpperCase();
      }
    }
  }
  return null;
}

function extractCongressionalDistrict(divisions: Record<string, unknown>): string | null {
  for (const divId of Object.keys(divisions)) {
    const match = divId.match(/\/cd:(.+)$/);
    if (match) return match[1]; // e.g. "12" or "at-large"
  }
  return null;
}

function partyDisplay(p: string | null): string | null {
  if (!p) return null;
  const map: Record<string, string> = {
    democratic: 'Democratic',
    republican: 'Republican',
    independent: 'Independent',
    libertarian: 'Libertarian',
    green: 'Green',
    other: 'Other',
  };
  return map[p] ?? p;
}

// ---------------------------------------------------------------------------
// GET /api/civic-lookup?address=...
// ---------------------------------------------------------------------------

export const GET: APIRoute = async ({ url }) => {
  const address = url.searchParams.get('address');
  if (!address || address.trim().length < 5) {
    return new Response(JSON.stringify({ error: 'Address is required (minimum 5 characters)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = import.meta.env.GOOGLE_CIVIC_API_KEY || process.env.GOOGLE_CIVIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'Google Civic API key not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Step 1: Call Google divisionsByAddress to get OCD-IDs
  const civicUrl = new URL('https://www.googleapis.com/civicinfo/v2/divisionsByAddress');
  civicUrl.searchParams.set('key', apiKey);
  civicUrl.searchParams.set('address', address.trim());

  let civic: DivisionsByAddressResponse;
  try {
    const res = await fetch(civicUrl.toString());
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      const msg = (errBody as { error?: { message?: string } }).error?.message || 'Address not found';
      return new Response(JSON.stringify({ error: msg }), {
        status: res.status === 404 ? 404 : 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    civic = await res.json() as DivisionsByAddressResponse;
  } catch {
    return new Response(JSON.stringify({ error: 'Failed to reach Google Civic API' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const divisions = civic.divisions ?? {};
  const normalized = civic.normalizedInput ?? null;

  // Step 2: Parse OCD-IDs to identify state and congressional district
  const stateAbbr = normalized?.state || extractStateAbbr(divisions);
  const congressionalDistrict = extractCongressionalDistrict(divisions);

  // Step 3: Query our database for matching officials
  const results: OfficialResult[] = [];

  if (stateAbbr) {
    // Get senators for this state
    const { data: senators } = await supabase
      .from('officials')
      .select(`
        full_name, slug, party, photo_url, email, phone, website, social_media,
        offices!inner(title, branch, chamber, district,
          jurisdictions!inner(name, level, state_abbr)
        )
      `)
      .eq('is_current', true)
      .eq('offices.jurisdictions.state_abbr', stateAbbr)
      .eq('offices.title', 'U.S. Senator');

    if (senators) {
      for (const s of senators) {
        const office = s.offices as unknown as { title: string; branch: string; chamber: string; district: string; jurisdictions: { name: string; level: string; state_abbr: string } };
        results.push({
          name: s.full_name,
          party: partyDisplay(s.party),
          title: office.title,
          level: 'federal',
          branch: 'legislative',
          photo_url: s.photo_url,
          phone: s.phone,
          email: s.email,
          website: s.website,
          channels: [],
          division: office.jurisdictions.name,
          slug: s.slug,
        });
      }
    }

    // Get house rep for this congressional district
    if (congressionalDistrict) {
      const isAtLarge = congressionalDistrict === 'at-large';
      let repQuery = supabase
        .from('officials')
        .select(`
          full_name, slug, party, photo_url, email, phone, website, social_media,
          offices!inner(title, branch, chamber, district,
            jurisdictions!inner(name, level, state_abbr)
          )
        `)
        .eq('is_current', true)
        .eq('offices.jurisdictions.state_abbr', stateAbbr)
        .eq('offices.title', 'U.S. Representative');

      if (!isAtLarge) {
        repQuery = repQuery.eq('offices.district', congressionalDistrict);
      }
      // For at-large, don't filter by district — there's only one rep per state

      const { data: reps } = await repQuery;

      if (reps) {
        for (const r of reps) {
          const office = r.offices as unknown as { title: string; branch: string; chamber: string; district: string; jurisdictions: { name: string; level: string; state_abbr: string } };
          const distLabel = congressionalDistrict === 'at-large'
            ? `${office.jurisdictions.name} At-Large`
            : `${office.jurisdictions.name} District ${congressionalDistrict}`;
          results.push({
            name: r.full_name,
            party: partyDisplay(r.party),
            title: office.title,
            level: 'federal',
            branch: 'legislative',
            photo_url: r.photo_url,
            phone: r.phone,
            email: r.email,
            website: r.website,
            channels: [],
            division: distLabel,
            slug: r.slug,
          });
        }
      }
    }
  }

  // Add President and VP as static entries when we have a US division
  const hasUS = Object.keys(divisions).some(d => d === 'ocd-division/country:us');
  if (hasUS) {
    results.unshift(
      {
        name: 'Donald J. Trump',
        party: 'Republican',
        title: 'President of the United States',
        level: 'federal',
        branch: 'executive',
        photo_url: null,
        phone: '(202) 456-1111',
        email: null,
        website: 'https://www.whitehouse.gov/',
        channels: [],
        division: 'United States',
        slug: null,
      },
      {
        name: 'J.D. Vance',
        party: 'Republican',
        title: 'Vice President of the United States',
        level: 'federal',
        branch: 'executive',
        photo_url: null,
        phone: '(202) 456-1111',
        email: null,
        website: 'https://www.whitehouse.gov/',
        channels: [],
        division: 'United States',
        slug: null,
      },
    );
  }

  // Step 4: Look up jurisdictions for sidebar links
  const jurisdictions = {
    state: null as { name: string; slug: string } | null,
    county: null as { name: string; slug: string } | null,
    city: null as { name: string; slug: string } | null,
  };

  if (stateAbbr) {
    const { data: stateRow } = await supabase
      .from('jurisdictions')
      .select('name, slug')
      .eq('level', 'state')
      .eq('state_abbr', stateAbbr)
      .maybeSingle();

    if (stateRow) jurisdictions.state = stateRow;
  }

  // County from divisions
  for (const [divId, div] of Object.entries(divisions)) {
    if (divId.includes('/county:') || divId.includes('/parish:')) {
      const countyName = div.name.replace(/ County$| Parish$| Borough$| Census Area$/i, '');
      const { data: countyRow } = await supabase
        .from('jurisdictions')
        .select('name, slug')
        .eq('level', 'county')
        .ilike('name', countyName + '%')
        .limit(1)
        .maybeSingle();

      if (countyRow) jurisdictions.county = countyRow;
      break;
    }
  }

  // City from normalized input — our DB stores as "City name city, State" or "City name, State"
  if (normalized?.city && stateAbbr && jurisdictions.state) {
    const stateName = jurisdictions.state.name;
    // Try exact match first: "New York city, New York"
    const { data: cityRow } = await supabase
      .from('jurisdictions')
      .select('name, slug')
      .eq('level', 'city')
      .ilike('name', normalized.city + '%, ' + stateName)
      .limit(1)
      .maybeSingle();

    if (cityRow) jurisdictions.city = cityRow;
  }

  const response: LookupResponse = {
    address: address.trim(),
    normalized: normalized ? { city: normalized.city, state: normalized.state, zip: normalized.zip } : null,
    officials: results,
    jurisdictions,
    congressionalDistrict,
  };

  return new Response(JSON.stringify(response), {
    headers: { 'Content-Type': 'application/json' },
  });
};
