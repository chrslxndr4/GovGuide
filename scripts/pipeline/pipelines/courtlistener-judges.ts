/**
 * CourtListener Judges Pipeline
 *
 * Fetches federal courts and judges from the CourtListener API and loads them
 * into the `courts`, `judges`, `judge_financial_disclosures`, `entities`, and
 * `relationships` tables.
 *
 * Requires environment variable: COURTLISTENER_API_TOKEN
 *
 * Run order:
 *   1. Fetch and upsert courts
 *   2. Fetch judges — for each:
 *      a. Upsert a 'person' entity keyed on courtlistener_id
 *      b. Upsert into judges table (primary position drives top-level fields)
 *      c. Upsert 'appointed_by' relationship to appointing president entity
 *   3. Fetch financial disclosures and upsert into judge_financial_disclosures
 *
 * Re-runs are idempotent: upserts key on courtlistener_id / courtlistener_disclosure_id.
 */

import { BasePipeline } from '../base.js';
import {
  CourtListenerClient,
  type CLJudge,
  type CLCourt,
  type CLFinancialDisclosure,
  type CLPosition,
  type CLEducation,
} from '../clients/courtlistener.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * CourtListener jurisdiction codes mapped to our court_type enum.
 * See: https://www.courtlistener.com/api/rest/v4/courts/?format=json
 *
 * CL uses short codes such as 'F' (federal appellate), 'FD' (federal district),
 * 'FB' (federal bankruptcy), 'FS' (federal special), 'S' (state supreme), etc.
 * Unmapped codes fall through to 'special'.
 */
type CourtTypeEnum =
  | 'supreme'
  | 'circuit'
  | 'district'
  | 'bankruptcy'
  | 'state_supreme'
  | 'state_appellate'
  | 'state_trial'
  | 'special';

function mapJurisdictionToCourtType(jurisdiction: string): CourtTypeEnum {
  switch (jurisdiction?.toUpperCase()) {
    case 'F':
      return 'circuit';
    case 'FD':
      return 'district';
    case 'FB':
      return 'bankruptcy';
    case 'FS':
      return 'special';
    case 'S':
      return 'state_supreme';
    case 'SA':
      return 'state_appellate';
    case 'ST':
      return 'state_trial';
    // The US Supreme Court uses the CL id 'scotus'; catch explicit value too
    case 'SCOTUS':
    case 'US':
      return 'supreme';
    default:
      return 'special';
  }
}

/**
 * Extract the circuit number from a court id string such as 'ca1', 'ca9', etc.
 * Returns null when the court id does not encode a circuit number.
 */
function extractCircuitNumber(courtId: string): number | null {
  const match = courtId.match(/^ca(\d{1,2})$/);
  if (match) return parseInt(match[1], 10);
  if (courtId === 'scotus') return null;
  return null;
}

/**
 * Pick the most recent / active position from a judge's position list.
 * Active positions (no termination date) are preferred; among those the one
 * with the latest start date wins. Falls back to the most recently terminated.
 */
function primaryPosition(positions: CLPosition[]): CLPosition | undefined {
  if (!positions || positions.length === 0) return undefined;

  const active = positions.filter(p => !p.date_termination);
  const pool = active.length > 0 ? active : positions;

  return pool.reduce<CLPosition | undefined>((best, pos) => {
    if (!best) return pos;
    const bestDate = best.date_start ?? '';
    const posDate = pos.date_start ?? '';
    return posDate > bestDate ? pos : best;
  }, undefined);
}

/**
 * Select the law school from a judge's education records.
 * Prefers a JD ('jd') degree; falls back to the highest degree year.
 */
function extractLawSchool(educations: CLEducation[]): string | null {
  if (!educations || educations.length === 0) return null;

  const jd = educations.find(e => e.degree_level?.toLowerCase() === 'jd');
  if (jd?.school?.name) return jd.school.name;

  // Fallback: school with the latest degree year
  const sorted = [...educations].sort((a, b) => (b.degree_year ?? 0) - (a.degree_year ?? 0));
  return sorted[0]?.school?.name ?? null;
}

/**
 * Derive a URL-safe slug from a full name.
 */
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Parse a YYYY-MM-DD date string and return just the four-digit year as a
 * number, or null when the string is absent / unparseable.
 */
function yearFromDate(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const year = parseInt(dateStr.slice(0, 4), 10);
  return isNaN(year) ? null : year;
}

/**
 * Extract a person's ID from a CourtListener resource URI.
 * e.g. 'https://www.courtlistener.com/api/rest/v4/people/1234/' → 1234
 */
function idFromResourceUri(uri: string | null | undefined): number | null {
  if (!uri) return null;
  const match = uri.match(/\/(\d+)\/?$/);
  return match ? parseInt(match[1], 10) : null;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class CourtListenerJudgesPipeline extends BasePipeline {
  private cl: CourtListenerClient;

  /** In-process cache: courtlistener_id (string) → courts.id (UUID) */
  private courtIdCache = new Map<string, string>();

  /** In-process cache: 'courtlistener:<clId>' → entities.id (UUID) */
  private entityCache = new Map<string, string>();

  constructor() {
    super();
    const token = process.env.COURTLISTENER_API_TOKEN;
    if (!token) throw new Error('Missing COURTLISTENER_API_TOKEN environment variable');
    this.cl = new CourtListenerClient(token);
  }

  getName(): string {
    return 'courtlistener-judges';
  }

  // ---------------------------------------------------------------------------
  // Main run
  // ---------------------------------------------------------------------------

  async run(): Promise<void> {
    console.log(`[${this.getName()}] Starting CourtListener judges pipeline...`);

    await this.runCourts();
    await this.runJudges();
    await this.runFinancialDisclosures();
  }

  // ---------------------------------------------------------------------------
  // Step 1: Courts
  // ---------------------------------------------------------------------------

  private async runCourts(): Promise<void> {
    console.log(`[${this.getName()}] Fetching courts from CourtListener...`);

    let courts: CLCourt[];
    try {
      courts = await this.cl.getCourts();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.results.errors.push(`getCourts: ${msg}`);
      console.error(`[${this.getName()}] Failed to fetch courts: ${msg}`);
      return;
    }

    this.results.records_fetched += courts.length;
    console.log(`[${this.getName()}] Received ${courts.length} court(s). Upserting...`);

    for (const court of courts) {
      try {
        const courtType = mapJurisdictionToCourtType(court.jurisdiction);
        const circuitNumber = extractCircuitNumber(court.id);
        const slug = toSlug(court.short_name || court.full_name || court.id);

        const { data: upserted, error } = await this.supabase
          .from('courts')
          .upsert(
            {
              name: court.full_name || court.short_name,
              slug,
              court_type: courtType,
              circuit_number: circuitNumber,
              metadata: {
                courtlistener_id: court.id,
                short_name: court.short_name,
                jurisdiction: court.jurisdiction,
              },
            },
            {
              // Courts are identified by their CourtListener slug-style id stored
              // in metadata; we rely on name uniqueness here. In practice the
              // courts table should have a unique index on metadata->>'courtlistener_id'
              // but we use slug as the on-conflict target since it has a unique constraint.
              onConflict: 'slug',
              ignoreDuplicates: false,
            }
          )
          .select('id')
          .single();

        if (error) {
          this.results.errors.push(`Court upsert (${court.id}): ${error.message}`);
          console.error(`[${this.getName()}] Court upsert error for ${court.id}: ${error.message}`);
          continue;
        }

        const dbId: string = (upserted as { id: string }).id;
        this.courtIdCache.set(court.id, dbId);
        this.results.records_inserted++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.results.errors.push(`Court (${court.id}): ${msg}`);
        console.error(`[${this.getName()}] Unexpected error for court ${court.id}: ${msg}`);
      }
    }

    console.log(`[${this.getName()}] Courts complete. Cache size: ${this.courtIdCache.size}`);
  }

  // ---------------------------------------------------------------------------
  // Step 2: Judges
  // ---------------------------------------------------------------------------

  private async runJudges(): Promise<void> {
    console.log(`[${this.getName()}] Fetching judges from CourtListener...`);

    let judges: CLJudge[];
    try {
      // Limit to judges with federal court positions to keep the initial load
      // manageable; remove or adjust params for a full import.
      judges = await this.cl.getJudges({ type: 'judge' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.results.errors.push(`getJudges: ${msg}`);
      console.error(`[${this.getName()}] Failed to fetch judges: ${msg}`);
      return;
    }

    this.results.records_fetched += judges.length;
    console.log(`[${this.getName()}] Received ${judges.length} judge(s). Processing...`);

    for (const judge of judges) {
      try {
        await this.processJudge(judge);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.results.errors.push(`Judge ${judge.id}: ${msg}`);
        console.error(`[${this.getName()}] Error processing judge ${judge.id}: ${msg}`);
      }
    }

    console.log(`[${this.getName()}] Judges complete.`);
  }

  private async processJudge(judge: CLJudge): Promise<void> {
    const fullName = [judge.name_first, judge.name_middle, judge.name_last]
      .filter(Boolean)
      .join(' ')
      .trim();

    if (!fullName) {
      this.results.records_skipped++;
      return;
    }

    // 2a. Upsert person entity
    const entityId = await this.resolveJudgeEntity(judge.id, fullName);
    if (!entityId) {
      this.results.records_skipped++;
      return;
    }

    // Resolve primary position for top-level judge fields
    const pos = primaryPosition(judge.positions ?? []);

    // Resolve court UUID from cached map, falling back to a DB lookup
    let courtId: string | null = null;
    if (pos?.court) {
      courtId = await this.resolveCourtId(pos.court);
    }

    // 2b. Upsert into judges table
    const slug = toSlug(fullName);
    const mostRecentAba = (judge.aba_ratings ?? []).sort(
      (a, b) => (b.year_rated ?? 0) - (a.year_rated ?? 0)
    )[0];

    const allRaces = Array.isArray(judge.race) && judge.race.length > 0
      ? judge.race.join(', ')
      : null;

    const priorPositions = (judge.positions ?? [])
      .filter(p => p.court !== pos?.court)
      .map(p => p.court)
      .filter(Boolean);

    const confirmationVote =
      pos?.votes_yes != null && pos?.votes_no != null
        ? `${pos.votes_yes}-${pos.votes_no}`
        : null;

    const { error: judgeError } = await this.supabase
      .from('judges')
      .upsert(
        {
          entity_id: entityId,
          court_id: courtId,
          first_name: judge.name_first || null,
          last_name: judge.name_last || null,
          full_name: fullName,
          slug,
          appointing_president: pos?.appointer
            ? await this.resolveAppointerName(pos.appointer)
            : null,
          nomination_date: pos?.date_start ?? null,
          confirmation_date: pos?.date_confirmation ?? null,
          confirmation_vote: confirmationVote,
          aba_rating: mostRecentAba?.rating ?? null,
          termination_date: pos?.date_termination ?? null,
          birth_year: yearFromDate(judge.date_dob),
          gender: judge.gender || null,
          race_ethnicity: allRaces,
          law_school: extractLawSchool(judge.educations ?? []),
          prior_positions: priorPositions.length > 0 ? priorPositions : null,
          courtlistener_id: judge.id,
          metadata: {
            how_selected: pos?.how_selected ?? null,
            nomination_process: (pos as unknown as Record<string, unknown>)?.nomination_process ?? null,
            aba_ratings: judge.aba_ratings ?? [],
            educations: judge.educations ?? [],
            all_positions_count: (judge.positions ?? []).length,
          },
        },
        {
          onConflict: 'courtlistener_id',
          ignoreDuplicates: false,
        }
      );

    if (judgeError) {
      throw new Error(`Judge upsert failed: ${judgeError.message}`);
    }

    this.results.records_inserted++;

    // 2c. Upsert 'appointed_by' relationship when appointer is known
    if (pos?.appointer) {
      await this.upsertAppointedByRelationship(entityId, pos.appointer);
    }
  }

  // ---------------------------------------------------------------------------
  // Entity helpers
  // ---------------------------------------------------------------------------

  /**
   * Look up or create a 'person' entity for a judge, keyed on courtlistener_id.
   */
  private async resolveJudgeEntity(
    clId: number,
    fullName: string
  ): Promise<string | null> {
    const cacheKey = `courtlistener:${clId}`;
    if (this.entityCache.has(cacheKey)) {
      return this.entityCache.get(cacheKey)!;
    }

    try {
      const entityId = await this.upsertEntity(
        {
          entity_type: 'person',
          name: fullName,
          external_ids: { courtlistener_id: String(clId) },
        },
        'courtlistener_id',
        String(clId)
      );

      this.entityCache.set(cacheKey, entityId);
      return entityId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.getName()}] Entity resolution failed for judge ${clId}: ${msg}`);
      this.results.errors.push(`Entity for judge ${clId}: ${msg}`);
      return null;
    }
  }

  /**
   * Resolve a court's DB UUID from its CourtListener string id.
   * Checks the in-memory cache first, then queries Supabase by metadata field.
   */
  private async resolveCourtId(clCourtIdOrUri: string): Promise<string | null> {
    // The position.court field may be a resource URI or a bare ID string.
    const clCourtId = clCourtIdOrUri.includes('/')
      ? clCourtIdOrUri.replace(/\/$/, '').split('/').pop() ?? clCourtIdOrUri
      : clCourtIdOrUri;

    if (this.courtIdCache.has(clCourtId)) {
      return this.courtIdCache.get(clCourtId)!;
    }

    // Not in cache — query DB
    const { data, error } = await this.supabase
      .from('courts')
      .select('id')
      .eq("metadata->>'courtlistener_id'", clCourtId)
      .maybeSingle();

    if (error || !data) return null;

    const id: string = (data as { id: string }).id;
    this.courtIdCache.set(clCourtId, id);
    return id;
  }

  /**
   * Resolve the display name of an appointing president from a resource URI.
   * CourtListener's appointer field is a URI pointing to another person record.
   * We optimistically derive the name from the entity cache if already loaded,
   * otherwise we return the URI itself as a fallback label — a separate pass
   * (or manual enrichment) can resolve these later.
   */
  private async resolveAppointerName(appointerUri: string): Promise<string | null> {
    const clId = idFromResourceUri(appointerUri);
    if (!clId) return appointerUri;

    // If we already have this person in the entity cache we can query by entity id
    const cacheKey = `courtlistener:${clId}`;
    if (this.entityCache.has(cacheKey)) {
      const entityId = this.entityCache.get(cacheKey)!;
      const { data } = await this.supabase
        .from('entities')
        .select('name')
        .eq('id', entityId)
        .maybeSingle();
      return (data as { name: string } | null)?.name ?? null;
    }

    // Fall back: store the CL URI so the field is populated and can be resolved
    // in a later enrichment pass.
    return appointerUri;
  }

  /**
   * Upsert an 'appointed_by' relationship from a judge entity to the appointer
   * entity (president). The appointer entity is created if not found.
   */
  private async upsertAppointedByRelationship(
    judgeEntityId: string,
    appointerUri: string
  ): Promise<void> {
    const clId = idFromResourceUri(appointerUri);
    if (!clId) return;

    // Attempt to find or create the appointer entity
    let appointerEntityId: string | null = null;
    try {
      // We may not have a name — use a placeholder that can be enriched later
      appointerEntityId = await this.upsertEntity(
        {
          entity_type: 'person',
          name: `CourtListener Person ${clId}`,
          external_ids: { courtlistener_id: String(clId) },
        },
        'courtlistener_id',
        String(clId)
      );
      this.entityCache.set(`courtlistener:${clId}`, appointerEntityId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[${this.getName()}] Could not resolve appointer entity (CL id ${clId}): ${msg}`
      );
      return;
    }

    const { error } = await this.supabase.from('relationships').upsert(
      {
        source_entity_id: judgeEntityId,
        target_entity_id: appointerEntityId,
        relationship_type: 'appointed_by',
        metadata: { courtlistener_appointer_id: clId },
      },
      {
        onConflict: 'source_entity_id,target_entity_id,relationship_type',
        ignoreDuplicates: true,
      }
    );

    if (error && error.code !== '23505') {
      console.error(
        `[${this.getName()}] Relationship upsert error (appointed_by): ${error.message}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Step 3: Financial disclosures
  // ---------------------------------------------------------------------------

  private async runFinancialDisclosures(): Promise<void> {
    console.log(`[${this.getName()}] Fetching financial disclosures from CourtListener...`);

    let disclosures: CLFinancialDisclosure[];
    try {
      disclosures = await this.cl.getFinancialDisclosures();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.results.errors.push(`getFinancialDisclosures: ${msg}`);
      console.error(`[${this.getName()}] Failed to fetch financial disclosures: ${msg}`);
      return;
    }

    this.results.records_fetched += disclosures.length;
    console.log(
      `[${this.getName()}] Received ${disclosures.length} disclosure(s). Upserting...`
    );

    for (const disclosure of disclosures) {
      try {
        await this.processDisclosure(disclosure);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.results.errors.push(`Disclosure ${disclosure.id}: ${msg}`);
        console.error(
          `[${this.getName()}] Error processing disclosure ${disclosure.id}: ${msg}`
        );
      }
    }

    console.log(`[${this.getName()}] Financial disclosures complete.`);
  }

  private async processDisclosure(disclosure: CLFinancialDisclosure): Promise<void> {
    // Resolve the judge's entity from the person URI on the disclosure
    const clPersonId = idFromResourceUri(disclosure.person);
    if (!clPersonId) {
      this.results.records_skipped++;
      return;
    }

    // Look up the judge row by courtlistener_id to get its UUID
    const { data: judgeRow, error: judgeErr } = await this.supabase
      .from('judges')
      .select('id')
      .eq('courtlistener_id', clPersonId)
      .maybeSingle();

    if (judgeErr || !judgeRow) {
      // Judge not yet ingested — skip; will be populated on the next full run
      this.results.records_skipped++;
      return;
    }

    const judgeDbId: string = (judgeRow as { id: string }).id;

    const { error } = await this.supabase
      .from('judge_financial_disclosures')
      .upsert(
        {
          judge_id: judgeDbId,
          disclosure_year: disclosure.year,
          // CourtListener v4 does not expose a direct filing URL in the list
          // endpoint; store null and let a separate enrichment step populate it.
          filing_url: null,
          courtlistener_disclosure_id: disclosure.id,
          parsed: disclosure.has_been_extracted ?? false,
        },
        {
          onConflict: 'courtlistener_disclosure_id',
          ignoreDuplicates: false,
        }
      );

    if (error) {
      throw new Error(`Disclosure upsert failed: ${error.message}`);
    }

    this.results.records_inserted++;
  }
}
