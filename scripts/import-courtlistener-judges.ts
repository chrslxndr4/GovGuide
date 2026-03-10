/**
 * Import state + federal judges from the CourtListener API.
 *
 * CourtListener (https://www.courtlistener.com) publishes a REST API with
 * biographical data on judges, including state judges not covered by the
 * FJC database.
 *
 * Strategy:  Iterate the /positions/ endpoint (which returns full nested
 * person + court objects), group positions by person, and import one judge
 * per person using their primary (most recent / active) judicial position.
 *
 * API docs: https://www.courtlistener.com/api/rest/v4/
 *
 * Optional environment variables:
 *   COURTLISTENER_API_TOKEN — API auth token (increases rate limit to 5,000/day)
 *                            Also accepts COURTLISTENER_TOKEN as a fallback
 *   CL_MAX_PAGES          — Maximum number of pages to fetch (default: unlimited)
 *   DRY_RUN               — Set to "true" to skip DB writes
 *
 * This script supplements the existing FJC import (import-judges.ts) by:
 *   - Adding state judges not present in the FJC dataset
 *   - Enriching existing federal judges with courtlistener_id and additional metadata
 *
 * Deduplication strategy:
 *   - Check judges.courtlistener_id for existing records (lookup + insert/update,
 *     NOT upsert, because courtlistener_id can be null for FJC-only judges and
 *     partial unique indexes don't work with Supabase upsert).
 *   - For federal judges, also attempt to match by fjc_id.
 *
 * Rate limiting:
 *   - 2-second delay between API requests
 *   - Retry on HTTP 429 with 60-second backoff
 *
 * Run with:  npx tsx --env-file=.env scripts/import-courtlistener-judges.ts
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types — match the actual CourtListener API v4 response shapes
// ---------------------------------------------------------------------------

interface CLSchool {
  id: number;
  name: string;
}

interface CLEducation {
  school: CLSchool | null;
  degree_level: string;
  degree_detail: string;
  degree_year: number | null;
}

interface CLPoliticalAffiliation {
  political_party: string;
  date_start: string | null;
  date_end: string | null;
}

interface CLAbaRating {
  rating: string;
  year_rated: number | null;
}

/** Nested person object returned inside a position response. */
interface CLPerson {
  id: number;
  resource_uri: string;
  slug: string;
  name_first: string;
  name_middle: string;
  name_last: string;
  name_suffix: string;
  date_dob: string | null;
  date_dod: string | null;
  dob_city: string;
  dob_state: string;
  gender: string;
  race: string[];
  educations: CLEducation[];
  political_affiliations: CLPoliticalAffiliation[];
  aba_ratings: CLAbaRating[];
  fjc_id: number | null;
  has_photo: boolean;
  /** positions are URL strings when nested inside a person object */
  positions: string[];
}

interface CLCourt {
  id: string;         // e.g. "mad" — this is the court's short slug ID
  short_name: string;
  full_name: string;
  url: string;
  jurisdiction: string;  // "FD" = federal district, "FS" = federal special, "S" = state, "SA" = state appellate, etc.
}

interface CLAppointer {
  person: CLPerson | null;
}

/** A single position row from /api/rest/v4/positions/ */
interface CLPositionRow {
  id: number;
  person: CLPerson;
  court: CLCourt | null;
  appointer: CLAppointer | null;
  position_type: string;     // "jud" = judge, "pres" = president, etc.
  how_selected: string;
  date_nominated: string | null;
  date_elected: string | null;
  date_recess_appointment: string | null;
  date_confirmation: string | null;
  date_start: string | null;
  date_termination: string | null;
  date_retirement: string | null;
  termination_reason: string;
  vote_type: string;
  votes_yes: number | null;
  votes_no: number | null;
  nomination_process: string;
}

interface CLCursorPage<T> {
  count: string | number;  // CL returns a URL for count unless ?count=on
  next: string | null;
  previous: string | null;
  results: T[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CL_BASE_URL = 'https://www.courtlistener.com/api/rest/v4';
const REQUEST_DELAY_MS = 2000;
const RETRY_DELAY_MS = 60_000;
const MAX_RETRIES = 3;
const PAGE_SIZE = 20; // CL default max

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CL_TOKEN = process.env['COURTLISTENER_API_TOKEN'] ?? process.env['COURTLISTENER_TOKEN'] ?? '';
const MAX_PAGES = process.env['CL_MAX_PAGES']
  ? parseInt(process.env['CL_MAX_PAGES'], 10)
  : Infinity;
const DRY_RUN = process.env['DRY_RUN'] === 'true';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map CourtListener `how_selected` to our selection_method values.
 *
 * CL codes: e_part (partisan election), e_non_part (nonpartisan election),
 * a_pres (presidential appt), a_gov (governor appt), a_legis (legislative),
 * a_jud_comm (judicial commission / merit selection), etc.
 */
function mapSelectionMethod(howSelected: string | undefined): string | null {
  if (!howSelected) return null;
  const lower = howSelected.toLowerCase().trim();
  if (!lower) return null;

  if (lower.startsWith('e_')) return 'elected';
  if (lower === 'a_pres' || lower === 'a_gov') return 'appointed';
  if (lower === 'a_legis') return 'legislative_appointment';
  if (lower.includes('merit') || lower === 'a_jud_comm') return 'merit_selection';
  if (lower.startsWith('a_')) return 'appointed';

  return null;
}

function extractYear(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null;
  const match = dateStr.match(/^(\d{4})/);
  return match ? parseInt(match[1], 10) : null;
}

function buildFullName(p: CLPerson): string {
  const parts = [p.name_first, p.name_middle, p.name_last, p.name_suffix]
    .map((s) => s?.trim())
    .filter(Boolean);
  return parts.join(' ');
}

function buildConfirmationVote(pos: CLPositionRow): string | null {
  if (pos.votes_yes != null && pos.votes_no != null) {
    return `${pos.votes_yes}-${pos.votes_no}`;
  }
  return null;
}

function extractLawSchool(educations: CLEducation[]): string | null {
  const lawEd = educations.find(
    (e) =>
      e.degree_level === 'jd' ||
      e.degree_detail?.toLowerCase().includes('law') ||
      e.school?.name?.toLowerCase().includes('law'),
  );
  return lawEd?.school?.name ?? null;
}

function getAppointingPresident(pos: CLPositionRow): string | null {
  if (!pos.appointer?.person) return null;
  return buildFullName(pos.appointer.person) || null;
}

/**
 * Infer our schema court_type from the CL jurisdiction code and court name.
 *
 * CL jurisdiction codes: F = federal appellate, FD = federal district,
 * FB = federal bankruptcy, FS = federal special, S = state, SA = state appellate,
 * SS = state supreme, ST = state trial, etc.
 */
function inferSchemaCourtType(jurisdiction: string, courtName: string): string {
  const j = jurisdiction?.toUpperCase() ?? '';
  if (j === 'SS') return 'state_supreme';
  if (j === 'SA') return 'state_appellate';
  if (j === 'S' || j === 'ST') return 'state_trial';
  if (j === 'F') return 'appellate';
  if (j === 'FD') return 'district';
  if (j === 'FB') return 'bankruptcy';
  if (j === 'FS') return 'specialized';

  // Fallback: guess from court name
  const lower = courtName.toLowerCase();
  if (lower.includes('supreme')) return 'supreme';
  if (lower.includes('appell') || lower.includes('circuit')) return 'appellate';
  if (lower.includes('district') || lower.includes('trial')) return 'district';
  if (lower.includes('bankruptcy')) return 'bankruptcy';
  return 'specialized';
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

async function fetchPage<T>(url: string): Promise<CLCursorPage<T>> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (CL_TOKEN) {
    headers['Authorization'] = `Token ${CL_TOKEN}`;
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, { headers });

    if (response.status === 429) {
      console.warn(
        `  Rate limited (429). Waiting ${RETRY_DELAY_MS / 1000}s before retry ${attempt}/${MAX_RETRIES}...`,
      );
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `HTTP ${response.status} from ${url}: ${body.slice(0, 300)}`,
      );
    }

    return (await response.json()) as CLCursorPage<T>;
  }

  throw new Error(`Exhausted ${MAX_RETRIES} retries for ${url}`);
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

/** court CL slug → courts.id */
const courtCache = new Map<string, string>();

/** courtlistener person id → already-processed flag */
const knownCLIds = new Set<number>();

/** Accumulated positions grouped by person ID */
const personPositions = new Map<number, { person: CLPerson; positions: CLPositionRow[] }>();

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function ensureCourtlistenerIndex(): Promise<void> {
  console.log('  Ensuring unique index on judges.courtlistener_id...');
  const { error } = await supabase.rpc('exec_sql', {
    query: `CREATE UNIQUE INDEX IF NOT EXISTS idx_judges_courtlistener_id ON judges (courtlistener_id) WHERE courtlistener_id IS NOT NULL;`,
  });
  if (error) {
    console.warn(
      `  Could not create index via RPC (${error.message}). Index may already exist.`,
    );
  }
}

async function loadExistingCourtlistenerIds(): Promise<void> {
  console.log('  Loading existing courtlistener_id values...');
  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('judges')
      .select('courtlistener_id')
      .not('courtlistener_id', 'is', null)
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.error(`  ERROR loading existing CL IDs: ${error.message}`);
      break;
    }
    if (!data || data.length === 0) break;

    for (const row of data) {
      const clId = (row as { courtlistener_id: number }).courtlistener_id;
      if (clId) knownCLIds.add(clId);
    }

    offset += pageSize;
    if (data.length < pageSize) break;
  }

  console.log(`  Found ${knownCLIds.size} judges with existing courtlistener_id.`);
}

async function getOrCreateCourt(
  clCourt: CLCourt,
): Promise<string | null> {
  const courtSlug = clCourt.id; // CL uses short slugs like "mad", "scotus"
  if (courtCache.has(courtSlug)) return courtCache.get(courtSlug)!;

  const { data: existing } = await supabase
    .from('courts')
    .select('id')
    .eq('slug', courtSlug)
    .maybeSingle();

  if (existing) {
    const id = (existing as { id: string }).id;
    courtCache.set(courtSlug, id);
    return id;
  }

  // Also try by name
  const { data: byName } = await supabase
    .from('courts')
    .select('id')
    .eq('name', clCourt.full_name || clCourt.short_name)
    .maybeSingle();

  if (byName) {
    const id = (byName as { id: string }).id;
    courtCache.set(courtSlug, id);
    return id;
  }

  if (DRY_RUN) {
    console.log(
      `  [DRY RUN] Would create court: ${clCourt.full_name} (${courtSlug})`,
    );
    return null;
  }

  const schemaCourtType = inferSchemaCourtType(
    clCourt.jurisdiction,
    clCourt.full_name || clCourt.short_name,
  );

  const { data: created, error } = await supabase
    .from('courts')
    .insert({
      name: clCourt.full_name || clCourt.short_name,
      slug: courtSlug,
      court_type: schemaCourtType,
      metadata: {
        source: 'courtlistener',
        cl_jurisdiction: clCourt.jurisdiction,
        website: clCourt.url || null,
      },
    })
    .select('id')
    .single();

  if (error || !created) {
    console.error(
      `  ERROR creating court "${clCourt.full_name}": ${error?.message}`,
    );
    return null;
  }

  const id = (created as { id: string }).id;
  courtCache.set(courtSlug, id);
  return id;
}

async function findJudgeByFjcId(
  fjcId: number,
): Promise<{ id: string } | null> {
  const { data } = await supabase
    .from('judges')
    .select('id')
    .eq('fjc_id', fjcId)
    .maybeSingle();
  return data as { id: string } | null;
}

async function findJudgeByCLId(
  clId: number,
): Promise<{ id: string } | null> {
  const { data } = await supabase
    .from('judges')
    .select('id')
    .eq('courtlistener_id', clId)
    .maybeSingle();
  return data as { id: string } | null;
}

async function resolveOrCreateEntity(
  person: CLPerson,
): Promise<string | null> {
  const externalIds: Record<string, string> = {
    courtlistener_id: String(person.id),
  };
  if (person.fjc_id) {
    externalIds.fjc_nid = String(person.fjc_id);
  }

  // Check by courtlistener_id
  const { data: existing } = await supabase
    .from('entities')
    .select('id')
    .contains('external_ids', { courtlistener_id: String(person.id) })
    .maybeSingle();

  if (existing) return (existing as { id: string }).id;

  // Check by fjc_nid for federal judges
  if (person.fjc_id) {
    const { data: fjcMatch } = await supabase
      .from('entities')
      .select('id, external_ids')
      .contains('external_ids', { fjc_nid: String(person.fjc_id) })
      .maybeSingle();

    if (fjcMatch) {
      const entityId = (fjcMatch as { id: string }).id;
      const mergedIds = {
        ...((fjcMatch as { external_ids: Record<string, string> }).external_ids ?? {}),
        courtlistener_id: String(person.id),
      };
      await supabase
        .from('entities')
        .update({ external_ids: mergedIds })
        .eq('id', entityId);
      return entityId;
    }
  }

  // Create new entity
  const fullName = buildFullName(person);
  const insert = {
    entity_type: 'judge' as const,
    name: fullName,
    aliases: [] as string[],
    external_ids: externalIds,
    metadata: { source: 'courtlistener' },
  };

  const { data: created, error } = await supabase
    .from('entities')
    .insert(insert)
    .select('id')
    .single();

  if (error) {
    if (error.message.includes('uq_entities_name')) {
      const { data: retry, error: retryErr } = await supabase
        .from('entities')
        .insert({ ...insert, name: `${fullName} (CL ${person.id})` })
        .select('id')
        .single();
      if (retry) return (retry as { id: string }).id;
      console.error(`  ENTITY ERROR "${fullName}": ${retryErr?.message}`);
      return null;
    }
    console.error(`  ENTITY ERROR "${fullName}": ${error.message}`);
    return null;
  }

  return created ? (created as { id: string }).id : null;
}

// ---------------------------------------------------------------------------
// Process a single person (with all their accumulated positions)
// ---------------------------------------------------------------------------

async function processJudge(
  person: CLPerson,
  positions: CLPositionRow[],
): Promise<'inserted' | 'updated' | 'skipped'> {
  if (knownCLIds.has(person.id)) return 'skipped';

  // Pick the primary (most recent active) judicial position
  const judicialPositions = positions.filter((p) => p.court);
  if (judicialPositions.length === 0) return 'skipped';

  // Prefer active (no termination), then most recent start
  const sorted = [...judicialPositions].sort((a, b) => {
    const aActive = !a.date_termination ? 1 : 0;
    const bActive = !b.date_termination ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    return (b.date_start ?? '').localeCompare(a.date_start ?? '');
  });
  const primary = sorted[0];

  const fullName = buildFullName(person);
  if (!fullName.trim()) return 'skipped';

  // Resolve court
  const courtId = await getOrCreateCourt(primary.court!);
  if (!courtId && !DRY_RUN) return 'skipped';

  // Resolve entity
  const entityId = DRY_RUN ? null : await resolveOrCreateEntity(person);
  if (!entityId && !DRY_RUN) return 'skipped';

  const judgeSlug = person.slug || slugify(`${fullName}-cl-${person.id}`);
  const selectionMethod = mapSelectionMethod(primary.how_selected);
  const appointingPresident = getAppointingPresident(primary);
  const confirmationVote = buildConfirmationVote(primary);
  const lawSchool = extractLawSchool(person.educations ?? []);

  // Build prior positions list from all judicial positions
  const priorPositions = judicialPositions
    .filter((p) => p.court)
    .map((p) => {
      const court = p.court!.full_name || p.court!.short_name;
      const start = p.date_start ?? '?';
      const end = p.date_termination ?? 'present';
      return `${court} (${start} – ${end})`;
    });

  // Best ABA rating
  const latestAba = (person.aba_ratings ?? [])
    .sort((a, b) => (b.year_rated ?? 0) - (a.year_rated ?? 0))[0];

  const judgeData = {
    entity_id: entityId,
    court_id: courtId,
    first_name: person.name_first ?? '',
    last_name: person.name_last ?? '',
    full_name: fullName,
    slug: judgeSlug,
    appointing_president: appointingPresident,
    nomination_date: primary.date_nominated || null,
    confirmation_date: primary.date_confirmation || null,
    confirmation_vote: confirmationVote,
    commission_date: primary.date_start || null,
    aba_rating: latestAba?.rating || null,
    senior_status_date: primary.date_retirement || null,
    termination_date: primary.date_termination || null,
    termination_reason: primary.termination_reason || null,
    birth_year: extractYear(person.date_dob),
    gender: person.gender || null,
    race_ethnicity: (person.race ?? []).join(', ') || null,
    law_school: lawSchool,
    prior_positions: priorPositions.length > 0 ? priorPositions : null,
    courtlistener_id: person.id,
    fjc_id: person.fjc_id || null,
    photo_url: person.has_photo
      ? `https://www.courtlistener.com/api/rest/v4/people/${person.id}/photo/`
      : null,
    selection_method: selectionMethod,
    metadata: {
      source: 'courtlistener',
      courtlistener_slug: person.slug,
      dob_city: person.dob_city || null,
      dob_state: person.dob_state || null,
      political_affiliations: (person.political_affiliations ?? []).map(
        (pa) => ({
          party: pa.political_party,
          start: pa.date_start,
          end: pa.date_end,
        }),
      ),
      education: (person.educations ?? []).map((e) => ({
        school: e.school?.name,
        degree: e.degree_level,
        detail: e.degree_detail,
        year: e.degree_year,
      })),
    },
  };

  if (DRY_RUN) {
    console.log(
      `  [DRY RUN] Would import: ${fullName} (CL #${person.id}, court: ${primary.court!.full_name || primary.court!.short_name})`,
    );
    return 'inserted';
  }

  // Enrichment: if the judge already exists by fjc_id, update with CL data
  if (person.fjc_id) {
    const existingByFjc = await findJudgeByFjcId(person.fjc_id);
    if (existingByFjc) {
      const { error } = await supabase
        .from('judges')
        .update({
          courtlistener_id: person.id,
          photo_url: judgeData.photo_url,
          selection_method: judgeData.selection_method,
          law_school: judgeData.law_school,
          prior_positions: judgeData.prior_positions,
          race_ethnicity: judgeData.race_ethnicity,
          birth_year: judgeData.birth_year,
          gender: judgeData.gender,
          metadata: judgeData.metadata,
        })
        .eq('id', existingByFjc.id);

      if (error) {
        console.error(
          `  UPDATE ERROR for ${fullName} (fjc_id=${person.fjc_id}): ${error.message}`,
        );
        return 'skipped';
      }
      knownCLIds.add(person.id);
      return 'updated';
    }
  }

  // Check if already exists by courtlistener_id
  const existingByCL = await findJudgeByCLId(person.id);
  if (existingByCL) {
    knownCLIds.add(person.id);
    return 'skipped';
  }

  // Insert new judge
  const { error } = await supabase.from('judges').insert(judgeData);

  if (error) {
    if (error.message.includes('judges_slug') || error.message.includes('unique')) {
      const retrySlug = slugify(`${fullName}-cl-${person.id}`);
      const { error: retryErr } = await supabase
        .from('judges')
        .insert({ ...judgeData, slug: retrySlug });
      if (retryErr) {
        console.error(
          `  INSERT ERROR ${fullName} (CL #${person.id}): ${retryErr.message}`,
        );
        return 'skipped';
      }
    } else {
      console.error(
        `  INSERT ERROR ${fullName} (CL #${person.id}): ${error.message}`,
      );
      return 'skipped';
    }
  }

  knownCLIds.add(person.id);
  return 'inserted';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importCourtListenerJudges(): Promise<void> {
  console.log('=== Import CourtListener Judges ===\n');

  if (DRY_RUN) {
    console.log('  *** DRY RUN MODE — no DB writes ***\n');
  }

  if (!CL_TOKEN) {
    console.warn(
      '  Warning: COURTLISTENER_TOKEN not set. Rate limits will be lower.\n',
    );
  }

  // Ensure index and load known IDs
  if (!DRY_RUN) {
    await ensureCourtlistenerIndex();
    await loadExistingCourtlistenerIds();
  }

  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let pagesFetched = 0;

  // Iterate the positions endpoint — it returns full nested person + court objects.
  // Filter to position_type=jud (judges) to exclude presidents, governors, etc.
  let nextUrl: string | null =
    `${CL_BASE_URL}/positions/?position_type=jud&page_size=${PAGE_SIZE}`;

  while (nextUrl && pagesFetched < MAX_PAGES) {
    pagesFetched++;
    const shortUrl =
      nextUrl.length > 100 ? nextUrl.slice(0, 100) + '...' : nextUrl;
    console.log(`\n--- Page ${pagesFetched} (${shortUrl}) ---`);

    const page = await fetchPage<CLPositionRow>(nextUrl);
    console.log(`  Results on this page: ${page.results.length}`);

    // Group positions by person ID. Since the API paginates by position,
    // the same person may appear across multiple pages. We process each
    // person as soon as all their positions on THIS page are collected,
    // accepting that a person split across pages gets processed twice
    // (the second time will be a no-op skip via knownCLIds).
    const pagePersons = new Map<
      number,
      { person: CLPerson; positions: CLPositionRow[] }
    >();

    for (const posRow of page.results) {
      if (!posRow.person) continue;
      const pid = posRow.person.id;

      if (!pagePersons.has(pid)) {
        pagePersons.set(pid, { person: posRow.person, positions: [] });
      }
      pagePersons.get(pid)!.positions.push(posRow);
    }

    // Process each person seen on this page
    for (const [_pid, { person, positions }] of pagePersons) {
      const result = await processJudge(person, positions);
      if (result === 'inserted') totalInserted++;
      else if (result === 'updated') totalUpdated++;
      else totalSkipped++;
    }

    console.log(
      `  Running totals — inserted: ${totalInserted}, updated: ${totalUpdated}, skipped: ${totalSkipped}`,
    );

    nextUrl = page.next;

    // Rate limit delay before next page
    if (nextUrl && pagesFetched < MAX_PAGES) {
      console.log(`  Waiting ${REQUEST_DELAY_MS / 1000}s before next request...`);
      await sleep(REQUEST_DELAY_MS);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`  Pages fetched    : ${pagesFetched}`);
  console.log(`  Judges inserted  : ${totalInserted}`);
  console.log(`  Judges updated   : ${totalUpdated}`);
  console.log(`  Judges skipped   : ${totalSkipped}`);
  console.log('=== Completed ===');
}

importCourtListenerJudges().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
