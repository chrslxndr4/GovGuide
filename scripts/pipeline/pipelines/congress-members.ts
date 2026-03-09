import { BasePipeline } from '../base.js';
import { CongressClient } from '../clients/congress.js';
import type { CongressMember, CongressMemberDetail } from '../clients/congress.js';

// Maps Congress.gov partyName strings to the `party` DB enum.
// Any unrecognised value falls through to 'other'.
const PARTY_MAP: Record<string, string> = {
  'Democratic': 'democratic',
  'Democrat': 'democratic',
  'Republican': 'republican',
  'Independent': 'independent',
  'Libertarian': 'libertarian',
  'Green': 'green',
};

function toPartyEnum(partyName: string): string {
  return PARTY_MAP[partyName] ?? 'other';
}

// Derives first/last from the API's "Last, First" or "First Last" format.
function splitName(raw: string): { firstName: string; lastName: string } {
  if (raw.includes(',')) {
    const [last, ...rest] = raw.split(',').map(s => s.trim());
    return { firstName: rest.join(' '), lastName: last };
  }
  const parts = raw.trim().split(/\s+/);
  return {
    firstName: parts.slice(0, -1).join(' '),
    lastName: parts[parts.length - 1] ?? raw,
  };
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// Returns the most recent term item from the nested terms structure.
function currentTerm(
  terms: CongressMember['terms']
): { chamber: string; startYear: number; endYear?: number } | null {
  const items = terms?.item;
  if (!items?.length) return null;
  return items.reduce((latest, item) =>
    item.startYear > latest.startYear ? item : latest
  );
}

export class CongressMembersPipeline extends BasePipeline {
  private client: CongressClient;

  constructor() {
    super();
    const apiKey = process.env.CONGRESS_API_KEY;
    if (!apiKey) throw new Error('Missing CONGRESS_API_KEY environment variable');
    this.client = new CongressClient(apiKey);
  }

  getName(): string {
    return 'congress-members';
  }

  async run(): Promise<void> {
    // ------------------------------------------------------------------
    // 1. Fetch all current members
    // ------------------------------------------------------------------
    console.log(`[${this.getName()}] Fetching all current members...`);
    const members = await this.client.getMembers({ currentMember: 'true' });
    this.results.records_fetched = members.length;
    console.log(`[${this.getName()}] Fetched ${members.length} members.`);

    // ------------------------------------------------------------------
    // 2. Process each member
    // ------------------------------------------------------------------
    for (const member of members) {
      try {
        await this.processMember(member);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.results.errors.push(`[${member.bioguideId}] ${msg}`);
        console.error(`[${this.getName()}] Error processing ${member.bioguideId}: ${msg}`);
      }
    }
  }

  private async processMember(member: CongressMember): Promise<void> {
    const { bioguideId, name, partyName, state, district, terms } = member;

    const { firstName, lastName } = splitName(name);
    const fullName = name.includes(',')
      ? `${firstName} ${lastName}`.trim()
      : name.trim();
    const slug = toSlug(fullName);
    const party = toPartyEnum(partyName);
    const term = currentTerm(terms);

    // ------------------------------------------------------------------
    // 2a. Optionally fetch detail for photo URL (best-effort)
    // ------------------------------------------------------------------
    let photoUrl: string | null = null;
    let detail: CongressMemberDetail | null = null;
    try {
      const res = await this.client.getMemberDetail(bioguideId);
      detail = res.member;
      photoUrl = detail?.depiction?.imageUrl ?? null;
    } catch (err) {
      // Non-fatal — continue without photo
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.getName()}] Could not fetch detail for ${bioguideId}: ${msg}`);
    }

    // Build metadata from all available enrichment data.
    const metadata: Record<string, unknown> = {
      state,
      district: district ?? null,
      chamber: term?.chamber ?? null,
      term_start_year: term?.startYear ?? null,
      term_end_year: term?.endYear ?? null,
      sponsored_legislation_count: detail?.sponsoredLegislation?.count ?? null,
      cosponsored_legislation_count: detail?.cosponsoredLegislation?.count ?? null,
      birth_year: detail?.birthYear ?? null,
    };

    // ------------------------------------------------------------------
    // 2b. Upsert into `officials` (match on bioguide_id)
    // ------------------------------------------------------------------
    const officialPayload = {
      first_name: firstName,
      last_name: lastName,
      full_name: fullName,
      slug,
      // office_id is required by the schema but is jurisdiction-specific;
      // it must be resolved separately (e.g. by a prior offices-seeding step).
      // We do NOT set it here to avoid a FK violation on insert — the upsert
      // path below handles the update-only case when the row already exists.
      party,
      bioguide_id: bioguideId,
      photo_url: photoUrl,
      is_current: true,
      metadata,
    };

    const { data: existingOfficial } = await this.supabase
      .from('officials')
      .select('id')
      .eq('bioguide_id', bioguideId)
      .single();

    if (existingOfficial) {
      const { error } = await this.supabase
        .from('officials')
        .update({ ...officialPayload, updated_at: new Date().toISOString() })
        .eq('id', existingOfficial.id);

      if (error) throw new Error(`Officials update failed: ${error.message}`);
      this.results.records_updated++;
    } else {
      // Only attempt insert when office_id is derivable from state + chamber.
      // Without a matching office row this insert will violate the FK constraint,
      // so we skip and record it rather than crash the entire run.
      const officeId = await this.resolveOfficeId(state, term?.chamber ?? null);
      if (!officeId) {
        console.warn(
          `[${this.getName()}] No office_id found for ${bioguideId} (${state} / ${term?.chamber ?? 'unknown'}). Skipping insert.`
        );
        this.results.records_skipped++;
        // Still upsert the entity graph node so relationships can be built later.
        await this.upsertMemberEntity(bioguideId, fullName);
        return;
      }

      const { error } = await this.supabase
        .from('officials')
        .insert({ ...officialPayload, office_id: officeId });

      if (error) throw new Error(`Officials insert failed: ${error.message}`);
      this.results.records_inserted++;
    }

    // ------------------------------------------------------------------
    // 2c. Upsert the person entity in the graph
    // ------------------------------------------------------------------
    await this.upsertMemberEntity(bioguideId, fullName);
  }

  // Looks up the UUID of a pre-seeded office row for this state + chamber.
  // Returns null if no matching office exists yet.
  private async resolveOfficeId(
    state: string,
    chamber: string | null
  ): Promise<string | null> {
    if (!chamber) return null;

    // Normalise "Senate" / "House of Representatives" → DB enum values.
    const chamberEnum = chamber.toLowerCase().includes('senate') ? 'senate' : 'house';

    const { data } = await this.supabase
      .from('offices')
      .select('id')
      .eq('chamber', chamberEnum)
      .eq('branch', 'legislative')
      // Offices are linked to jurisdictions; join through jurisdictions.abbreviation.
      // We filter via a nested join on the jurisdictions table.
      .filter('jurisdictions.abbreviation', 'eq', state)
      .limit(1)
      .single();

    return data?.id ?? null;
  }

  // Wraps BasePipeline.upsertEntity for person nodes, sharing the
  // external_ids.bioguide_id lookup key.
  private async upsertMemberEntity(
    bioguideId: string,
    fullName: string
  ): Promise<string> {
    return this.upsertEntity(
      {
        entity_type: 'person',
        name: fullName,
        external_ids: { bioguide_id: bioguideId },
      },
      'bioguide_id',
      bioguideId
    );
  }
}
