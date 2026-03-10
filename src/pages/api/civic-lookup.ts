export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

/**
 * Google Civic Information API types (subset we care about)
 */
interface CivicOffice {
  name: string;
  divisionId: string;
  levels?: string[];
  roles?: string[];
  officialIndices: number[];
}

interface CivicOfficial {
  name: string;
  party?: string;
  phones?: string[];
  urls?: string[];
  emails?: string[];
  photoUrl?: string;
  channels?: Array<{ type: string; id: string }>;
  address?: Array<{ line1?: string; city?: string; state?: string; zip?: string }>;
}

interface CivicDivision {
  name: string;
  alsoKnownAs?: string[];
  officeIndices?: number[];
}

interface CivicResponse {
  normalizedInput?: {
    line1: string;
    city: string;
    state: string;
    zip: string;
  };
  divisions?: Record<string, CivicDivision>;
  offices?: CivicOffice[];
  officials?: CivicOfficial[];
}

/**
 * Our normalized output shape
 */
interface OfficialResult {
  name: string;
  party: string | null;
  title: string;
  level: string; // federal, state, county, city, special
  branch: string; // executive, legislative, judicial
  photo_url: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  channels: Array<{ type: string; id: string }>;
  division: string;
  slug: string | null; // link to our officials page if we have them in DB
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

function inferLevel(office: CivicOffice): string {
  const levels = office.levels ?? [];
  if (levels.includes('country')) return 'federal';
  if (levels.includes('administrativeArea1')) return 'state';
  if (levels.includes('administrativeArea2')) return 'county';
  if (levels.includes('locality')) return 'city';
  if (levels.includes('regional')) return 'county';
  if (levels.includes('special')) return 'special';
  // Infer from division ID
  const div = office.divisionId;
  if (div.includes('/country:us') && !div.includes('/state:')) return 'federal';
  if (div.includes('/state:') && !div.includes('/county:') && !div.includes('/place:')) return 'state';
  if (div.includes('/county:') || div.includes('/parish:')) return 'county';
  if (div.includes('/place:') || div.includes('/city:')) return 'city';
  return 'other';
}

function inferBranch(office: CivicOffice): string {
  const roles = office.roles ?? [];
  if (roles.includes('legislatorUpperBody') || roles.includes('legislatorLowerBody')) return 'legislative';
  if (roles.includes('headOfState') || roles.includes('headOfGovernment') || roles.includes('deputyHeadOfGovernment')) return 'executive';
  if (roles.includes('judge')) return 'judicial';

  const name = office.name.toLowerCase();
  if (name.includes('senator') || name.includes('representative') || name.includes('council') || name.includes('legislat') || name.includes('assembly') || name.includes('delegate') || name.includes('commissioner')) return 'legislative';
  if (name.includes('president') || name.includes('governor') || name.includes('mayor') || name.includes('executive') || name.includes('sheriff') || name.includes('attorney general') || name.includes('secretary') || name.includes('treasurer') || name.includes('comptroller') || name.includes('auditor')) return 'executive';
  if (name.includes('judge') || name.includes('justice') || name.includes('court')) return 'judicial';
  return 'executive';
}

function extractCongressionalDistrict(divisions: Record<string, CivicDivision>): string | null {
  for (const divId of Object.keys(divisions)) {
    const match = divId.match(/\/cd:(\d+)/);
    if (match) return match[1];
  }
  return null;
}

function makeSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

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

  // Call Google Civic Information API
  const civicUrl = new URL('https://www.googleapis.com/civicinfo/v2/representatives');
  civicUrl.searchParams.set('key', apiKey);
  civicUrl.searchParams.set('address', address.trim());

  let civic: CivicResponse;
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
    civic = await res.json() as CivicResponse;
  } catch {
    return new Response(JSON.stringify({ error: 'Failed to reach Google Civic API' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const offices = civic.offices ?? [];
  const officials = civic.officials ?? [];
  const divisions = civic.divisions ?? {};

  // Build normalized officials list
  const results: OfficialResult[] = [];
  for (const office of offices) {
    const level = inferLevel(office);
    const branch = inferBranch(office);
    const divisionName = divisions[office.divisionId]?.name ?? '';

    for (const idx of office.officialIndices) {
      const person = officials[idx];
      if (!person) continue;

      results.push({
        name: person.name,
        party: person.party ?? null,
        title: office.name,
        level,
        branch,
        photo_url: person.photoUrl ?? null,
        phone: person.phones?.[0] ?? null,
        email: person.emails?.[0] ?? null,
        website: person.urls?.[0] ?? null,
        channels: person.channels ?? [],
        division: divisionName,
        slug: null, // filled in below if we match in our DB
      });
    }
  }

  // Try to match officials to our database for linking
  const officialNames = results.map(r => r.name);
  if (officialNames.length > 0) {
    const { data: dbOfficials } = await supabase
      .from('officials')
      .select('name, slug')
      .in('name', officialNames)
      .eq('is_current', true);

    if (dbOfficials) {
      const slugMap = new Map(dbOfficials.map(o => [o.name, o.slug]));
      for (const r of results) {
        r.slug = slugMap.get(r.name) ?? null;
      }
    }
  }

  // Extract jurisdictions from normalized input
  const normalized = civic.normalizedInput ?? null;
  let jurisdictions = { state: null as { name: string; slug: string } | null, county: null as { name: string; slug: string } | null, city: null as { name: string; slug: string } | null };

  if (normalized) {
    // Look up state in our DB
    const { data: stateRow } = await supabase
      .from('jurisdictions')
      .select('name, slug')
      .eq('level', 'state')
      .eq('state_abbr', normalized.state)
      .maybeSingle();

    if (stateRow) {
      jurisdictions.state = stateRow;
    }

    // Try to find county from divisions
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

    // City from normalized input
    if (normalized.city) {
      const { data: cityRow } = await supabase
        .from('jurisdictions')
        .select('name, slug')
        .eq('level', 'city')
        .ilike('name', normalized.city)
        .limit(1)
        .maybeSingle();

      if (cityRow) jurisdictions.city = cityRow;
    }
  }

  const congressionalDistrict = extractCongressionalDistrict(divisions);

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
