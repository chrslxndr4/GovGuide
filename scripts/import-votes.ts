/**
 * Import congressional roll call votes from the Congress.gov API v3 and
 * chamber-specific XML source files.
 *
 * Requires environment variable:  CONGRESS_API_KEY
 * Obtain a free key at: https://api.congress.gov/
 *
 * House workflow:
 *   1. Page through /house-vote/{congress} to collect vote stubs.
 *   2. Fetch each clerk.house.gov XML file for member positions.
 *   3. Match members by bioguide_id (name-id attribute in <legislator>).
 *
 * Senate workflow:
 *   1. Enumerate XML files directly at senate.gov — no list API exists.
 *   2. Try vote numbers 1, 2, 3 … until a 404 is returned.
 *   3. Match members by first_name + last_name against the officials table.
 *
 * DB tables:
 *   roll_call_votes — upsert on (vote_number, congress, chamber)
 *   vote_positions  — upsert on (vote_id, official_id)
 *
 * Run with:  npm run import:votes
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONGRESS_API_BASE = 'https://api.congress.gov/v3';
/** Number of vote stubs to request per page from the House API. */
const PAGE_LIMIT = 250;
/** Number of rows flushed per Supabase upsert call. */
const BATCH_SIZE = 100;
/** Milliseconds to wait between HTTP requests to respect rate limits. */
const RATE_DELAY_MS = 750;

const TARGET_CONGRESS = parseInt(process.env.CONGRESS_NUMBER ?? '119', 10);

// ---------------------------------------------------------------------------
// Types — Congress.gov House vote list API
// ---------------------------------------------------------------------------

interface HouseVoteStub {
  congress: number;
  /** e.g. "HR", "S", "HRES" */
  legislationType?: string;
  legislationNumber?: string;
  result?: string;
  rollCallNumber: number;
  sessionNumber: number;
  sourceDataURL: string;
  startDate?: string;
  url: string;
  voteType?: string;
}

interface HouseVoteListResponse {
  houseRollCallVotes: HouseVoteStub[];
  pagination: {
    count: number;
    next?: string | null;
  };
}

// ---------------------------------------------------------------------------
// Types — DB insert shapes
// ---------------------------------------------------------------------------

type ChamberCode = 'senate' | 'house';

interface RollCallVoteInsert {
  bill_id: string | null;
  chamber: ChamberCode;
  vote_date: string | null;
  result: string | null;
  vote_number: number;
  congress: number;
  metadata: Record<string, unknown>;
}

interface VotePositionInsert {
  vote_id: string;
  official_id: string;
  position: 'yea' | 'nay' | 'present' | 'absent';
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Sleep for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map raw XML vote-cast strings to our position enum.
 *
 * House XML values:  "Yea" | "Nay" | "Present" | "Not Voting"
 * Senate XML values: "Yea" | "Nay" | "Present" | "Not Voting" | "Absent"
 */
function mapPosition(raw: string): 'yea' | 'nay' | 'present' | 'absent' | null {
  const lower = raw.toLowerCase().trim();
  if (lower === 'yea' || lower === 'yes' || lower === 'aye') return 'yea';
  if (lower === 'nay' || lower === 'no') return 'nay';
  if (lower === 'present') return 'present';
  if (lower === 'not voting' || lower === 'absent') return 'absent';
  return null;
}

/**
 * Derive the two-digit senate session number for a given congress.
 * Congress sessions run two years:
 *   - Odd-numbered congressional years → session 1
 *   - Even-numbered congressional years → session 2
 * Congress 119 started in January 2025, so 2025 = session 1, 2026 = session 2.
 * Formula: session = (currentYear - startYear) + 1
 *   where startYear = 2023 + 2 * (congress - 118)
 */
function senateSessionForYear(congress: number, year: number): 1 | 2 {
  // The first year of congress N:  startYear = 2023 + 2*(N-118)
  const startYear = 2023 + 2 * (congress - 118);
  const session = year - startYear + 1;
  return (session >= 2 ? 2 : 1) as 1 | 2;
}

// ---------------------------------------------------------------------------
// Simple regex-based XML extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract all occurrences of a tag's inner text from an XML string.
 * Handles both <tag>value</tag> and simple attribute extraction patterns.
 */
function extractTagValue(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'));
  return match ? match[1].trim() : null;
}

function extractAttribute(element: string, attr: string): string | null {
  const match = element.match(new RegExp(`${attr}="([^"]*)"`, 'i'));
  return match ? match[1].trim() : null;
}

/**
 * Split an XML string into individual element blocks for a given tag.
 * Works well for simple, non-nested structures like <recorded-vote> or <member>.
 */
function splitElements(xml: string, tag: string): string[] {
  const results: string[] = [];
  const openTag = `<${tag}`;
  const closeTag = `</${tag}>`;
  let pos = 0;

  while (pos < xml.length) {
    const start = xml.indexOf(openTag, pos);
    if (start === -1) break;
    const end = xml.indexOf(closeTag, start);
    if (end === -1) break;
    results.push(xml.slice(start, end + closeTag.length));
    pos = end + closeTag.length;
  }

  return results;
}

// ---------------------------------------------------------------------------
// HTTP fetch with rate limiting
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function throttledFetch(url: string): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_DELAY_MS) {
    await sleep(RATE_DELAY_MS - elapsed);
  }
  lastRequestTime = Date.now();
  return fetch(url);
}

async function apiFetch<T>(path: string, apiKey: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${CONGRESS_API_BASE}${path}${sep}api_key=${apiKey}&format=json`;

  const res = await throttledFetch(url);
  if (!res.ok) {
    throw new Error(`Congress.gov API ${res.status} at ${path}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// House: fetch vote stubs via API
// ---------------------------------------------------------------------------

async function fetchHouseVoteStubs(
  congress: number,
  apiKey: string,
): Promise<HouseVoteStub[]> {
  const stubs: HouseVoteStub[] = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    console.log(`  [house] Fetching vote list offset=${offset} …`);
    const body = await apiFetch<HouseVoteListResponse>(
      `/house-vote/${congress}?limit=${PAGE_LIMIT}&offset=${offset}`,
      apiKey,
    );
    total = body.pagination.count;
    stubs.push(...body.houseRollCallVotes);
    offset += body.houseRollCallVotes.length;
    if (body.houseRollCallVotes.length === 0) break;
  }

  console.log(`  [house] Total vote stubs: ${stubs.length}`);
  return stubs;
}

// ---------------------------------------------------------------------------
// House: parse clerk.house.gov XML for member positions
// ---------------------------------------------------------------------------

interface HouseMemberPosition {
  bioguideId: string;
  vote: string;
}

/**
 * Parse the House clerk XML roll call file.
 *
 * Relevant structure:
 *   <recorded-vote>
 *     <legislator name-id="BIOGUIDE_ID" ... />
 *     <vote>Yea</vote>
 *   </recorded-vote>
 *
 * Also extracts top-level vote metadata (action-date, vote-result, etc.)
 */
function parseHouseXml(xml: string): {
  voteDate: string | null;
  result: string | null;
  question: string | null;
  legislationNumber: string | null;
  legislationType: string | null;
  members: HouseMemberPosition[];
} {
  const voteDate = extractTagValue(xml, 'action-date');
  const result = extractTagValue(xml, 'vote-result');
  const question = extractTagValue(xml, 'vote-question');
  const legislationNumber = extractTagValue(xml, 'legis-num');
  const legislationType = null; // embedded in legis-num string, not split out

  const members: HouseMemberPosition[] = [];

  for (const block of splitElements(xml, 'recorded-vote')) {
    // Extract the <legislator> opening tag to read name-id attribute.
    const legMatch = block.match(/<legislator([^>]*)>/i);
    if (!legMatch) continue;
    const legAttrs = legMatch[1];

    const bioguideId = extractAttribute(legAttrs, 'name-id');
    if (!bioguideId) continue;

    const vote = extractTagValue(block, 'vote');
    if (!vote) continue;

    members.push({ bioguideId, vote });
  }

  return { voteDate, result, question, legislationNumber, legislationType, members };
}

async function fetchHouseXml(sourceDataURL: string): Promise<string | null> {
  try {
    const res = await throttledFetch(sourceDataURL);
    if (!res.ok) {
      if (res.status === 404) return null;
      console.warn(`  WARN House XML ${res.status} at ${sourceDataURL}`);
      return null;
    }
    return res.text();
  } catch (err) {
    console.warn(`  WARN House XML fetch error at ${sourceDataURL}: ${(err as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Senate: enumerate XML files directly
// ---------------------------------------------------------------------------

interface SenateMemberPosition {
  firstName: string;
  lastName: string;
  state: string;
  party: string;
  vote: string;
  lisMemberId: string;
}

/**
 * Parse a senate.gov roll call XML file.
 *
 * Relevant structure:
 *   <roll_call_vote>
 *     <congress>119</congress>
 *     <session>1</session>
 *     <vote_number>42</vote_number>
 *     <vote_date>March 5, 2025</vote_date>
 *     <result>Agreed to</result>
 *     <vote_title>...</vote_title>
 *     <members>
 *       <member>
 *         <first_name>John</first_name>
 *         <last_name>Smith</last_name>
 *         <state>VA</state>
 *         <party>D</party>
 *         <vote_cast>Yea</vote_cast>
 *         <lis_member_id>S123</lis_member_id>
 *       </member>
 *       ...
 *     </members>
 *   </roll_call_vote>
 */
function parseSenateXml(xml: string): {
  congress: number | null;
  session: number | null;
  voteNumber: number | null;
  voteDate: string | null;
  result: string | null;
  question: string | null;
  members: SenateMemberPosition[];
} {
  const congressRaw = extractTagValue(xml, 'congress');
  const sessionRaw = extractTagValue(xml, 'session');
  const voteNumberRaw = extractTagValue(xml, 'vote_number');
  const voteDate = extractTagValue(xml, 'vote_date');
  const result = extractTagValue(xml, 'result');
  const question = extractTagValue(xml, 'vote_title') ?? extractTagValue(xml, 'question');

  const members: SenateMemberPosition[] = [];

  for (const block of splitElements(xml, 'member')) {
    const firstName = extractTagValue(block, 'first_name') ?? '';
    const lastName = extractTagValue(block, 'last_name') ?? '';
    const state = extractTagValue(block, 'state') ?? '';
    const party = extractTagValue(block, 'party') ?? '';
    const vote = extractTagValue(block, 'vote_cast') ?? '';
    const lisMemberId = extractTagValue(block, 'lis_member_id') ?? '';

    if (firstName || lastName) {
      members.push({ firstName, lastName, state, party, vote, lisMemberId });
    }
  }

  return {
    congress: congressRaw ? parseInt(congressRaw, 10) : null,
    session: sessionRaw ? parseInt(sessionRaw, 10) : null,
    voteNumber: voteNumberRaw ? parseInt(voteNumberRaw, 10) : null,
    voteDate,
    result,
    question,
    members,
  };
}

/**
 * Build the senate.gov XML URL for a given congress, session, and roll number.
 * Roll number is zero-padded to 5 digits.
 *
 * Example: https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_00042.xml
 */
function senateXmlUrl(congress: number, session: 1 | 2, rollNumber: number): string {
  const paddedRoll = String(rollNumber).padStart(5, '0');
  return (
    `https://www.senate.gov/legislative/LIS/roll_call_votes/` +
    `vote${congress}${session}/vote_${congress}_${session}_${paddedRoll}.xml`
  );
}

/**
 * Fetch a senate XML file. Returns null on 404 (signals end of enumeration).
 * Throws on other HTTP errors.
 */
async function fetchSenateXml(
  congress: number,
  session: 1 | 2,
  rollNumber: number,
): Promise<string | null> {
  const url = senateXmlUrl(congress, session, rollNumber);
  let res: Response;
  try {
    res = await throttledFetch(url);
  } catch (err) {
    console.warn(`  WARN senate XML network error #${rollNumber}: ${(err as Error).message}`);
    return null;
  }

  if (res.status === 404) return null;

  if (!res.ok) {
    console.warn(`  WARN senate XML HTTP ${res.status} for roll #${rollNumber}`);
    return null;
  }

  return res.text();
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

/** bioguide_id → officials.id UUID */
const bioguideCache = new Map<string, string | null>();

async function resolveOfficialByBioguide(bioguideId: string): Promise<string | null> {
  if (bioguideCache.has(bioguideId)) return bioguideCache.get(bioguideId)!;

  const { data, error } = await supabase
    .from('officials')
    .select('id')
    .eq('bioguide_id', bioguideId)
    .maybeSingle();

  if (error) {
    console.warn(`  WARN lookup bioguide_id="${bioguideId}": ${error.message}`);
  }

  const id = (data as { id: string } | null)?.id ?? null;
  bioguideCache.set(bioguideId, id);
  return id;
}

/** "FIRSTNAME|LASTNAME" → officials.id UUID */
const nameCache = new Map<string, string | null>();

async function resolveOfficialByName(
  firstName: string,
  lastName: string,
): Promise<string | null> {
  const key = `${firstName.toLowerCase()}|${lastName.toLowerCase()}`;
  if (nameCache.has(key)) return nameCache.get(key)!;

  const { data, error } = await supabase
    .from('officials')
    .select('id')
    .ilike('first_name', firstName)
    .ilike('last_name', lastName)
    .maybeSingle();

  if (error) {
    console.warn(`  WARN lookup official name="${firstName} ${lastName}": ${error.message}`);
  }

  const id = (data as { id: string } | null)?.id ?? null;
  nameCache.set(key, id);
  return id;
}

/** "BILL_TYPE BILL_NUMBER:CONGRESS" → bills.id UUID */
const billCache = new Map<string, string | null>();

async function resolveBillId(
  legislationType: string | null | undefined,
  legislationNumber: string | null | undefined,
  congress: number,
): Promise<string | null> {
  if (!legislationType || !legislationNumber) return null;

  const billNumber = `${legislationType.toUpperCase()} ${legislationNumber}`;
  const cacheKey = `${billNumber}:${congress}`;
  if (billCache.has(cacheKey)) return billCache.get(cacheKey)!;

  const { data, error } = await supabase
    .from('bills')
    .select('id')
    .eq('bill_number', billNumber)
    .eq('congress', congress)
    .maybeSingle();

  if (error) {
    console.warn(`  WARN lookup bill "${billNumber}" congress=${congress}: ${error.message}`);
  }

  const id = (data as { id: string } | null)?.id ?? null;
  billCache.set(cacheKey, id);
  return id;
}

// ---------------------------------------------------------------------------
// Batch flush
// ---------------------------------------------------------------------------

async function flushVotePositions(
  batch: VotePositionInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('vote_positions')
    .upsert(batch, { onConflict: 'vote_id,official_id' });

  if (error) {
    console.error(`  BATCH ERROR vote_positions (${batch.length}): ${error.message}`);
    return { ok: 0, err: batch.length };
  }
  return { ok: batch.length, err: 0 };
}

// ---------------------------------------------------------------------------
// Upsert a roll_call_vote row and return its UUID
// ---------------------------------------------------------------------------

async function upsertRollCallVote(insert: RollCallVoteInsert): Promise<string | null> {
  const { data, error } = await supabase
    .from('roll_call_votes')
    .upsert(insert, { onConflict: 'vote_number,congress,chamber' })
    .select('id')
    .single();

  if (error || !data) {
    console.error(
      `  ERROR upserting vote ${insert.chamber} #${insert.vote_number}: ${error?.message}`,
    );
    return null;
  }
  return (data as { id: string }).id;
}

// ---------------------------------------------------------------------------
// Process member positions after we have a vote UUID
// ---------------------------------------------------------------------------

async function persistPositions(
  voteId: string,
  positionInserts: VotePositionInsert[],
  voteLabel: string,
): Promise<void> {
  for (let i = 0; i < positionInserts.length; i += BATCH_SIZE) {
    const chunk = positionInserts.slice(i, i + BATCH_SIZE);
    const { err } = await flushVotePositions(chunk);
    if (err > 0) {
      console.warn(`  WARN ${err} position(s) failed for ${voteLabel}`);
    }
  }
}

// ---------------------------------------------------------------------------
// House import
// ---------------------------------------------------------------------------

async function importHouseVote(
  stub: HouseVoteStub,
): Promise<{ ok: boolean }> {
  const { congress, rollCallNumber, sessionNumber, sourceDataURL } = stub;

  // 1. Fetch the clerk.house.gov XML for member positions.
  const xml = await fetchHouseXml(sourceDataURL);
  if (!xml) {
    console.warn(`  WARN no XML for house vote #${rollCallNumber}`);
    // Still upsert the vote row with what we have from the stub.
  }

  const parsed = xml
    ? parseHouseXml(xml)
    : { voteDate: null, result: null, question: null, legislationNumber: null, legislationType: null, members: [] };

  // 2. Resolve bill reference — use stub fields first, fall back to XML.
  const billId = await resolveBillId(
    stub.legislationType ?? parsed.legislationType,
    stub.legislationNumber ?? parsed.legislationNumber,
    congress,
  );

  // 3. Upsert roll_call_votes row.
  const voteInsert: RollCallVoteInsert = {
    bill_id: billId,
    chamber: 'house',
    vote_date: stub.startDate ?? parsed.voteDate ?? null,
    result: stub.result ?? parsed.result ?? null,
    vote_number: rollCallNumber,
    congress,
    metadata: {
      session: sessionNumber,
      question: parsed.question ?? null,
      vote_type: stub.voteType ?? null,
      source_data_url: sourceDataURL,
      congress_api_url: stub.url,
    },
  };

  const voteId = await upsertRollCallVote(voteInsert);
  if (!voteId) return { ok: false };

  // 4. Resolve member positions.
  const positionInserts: VotePositionInsert[] = [];
  for (const mv of parsed.members) {
    const position = mapPosition(mv.vote);
    if (!position) {
      console.warn(`  WARN unknown position "${mv.vote}" bioguide=${mv.bioguideId} vote #${rollCallNumber}`);
      continue;
    }
    const officialId = await resolveOfficialByBioguide(mv.bioguideId);
    if (!officialId) continue;
    positionInserts.push({ vote_id: voteId, official_id: officialId, position });
  }

  await persistPositions(voteId, positionInserts, `house #${rollCallNumber}`);
  return { ok: true };
}

async function importAllHouseVotes(congress: number, apiKey: string): Promise<void> {
  console.log('\n--- HOUSE ---');

  let stubs: HouseVoteStub[];
  try {
    stubs = await fetchHouseVoteStubs(congress, apiKey);
  } catch (err) {
    console.error(`  ERROR fetching house vote list: ${(err as Error).message}`);
    return;
  }

  console.log(`\nProcessing ${stubs.length} house votes …\n`);

  let ok = 0;
  let err = 0;

  for (let i = 0; i < stubs.length; i++) {
    const result = await importHouseVote(stubs[i]);
    if (result.ok) {
      ok++;
      process.stdout.write('.');
    } else {
      err++;
      process.stdout.write('E');
    }

    if ((i + 1) % BATCH_SIZE === 0 || i === stubs.length - 1) {
      process.stdout.write(`  [${i + 1}/${stubs.length}] ok=${ok} err=${err}\n`);
    }
  }

  console.log(`  HOUSE complete — imported: ${ok}, failed: ${err}`);
}

// ---------------------------------------------------------------------------
// Senate import
// ---------------------------------------------------------------------------

async function importSenateVote(
  congress: number,
  session: 1 | 2,
  rollNumber: number,
): Promise<{ ok: boolean; done: boolean }> {
  const xml = await fetchSenateXml(congress, session, rollNumber);

  // null means 404 — we've exhausted available votes for this session.
  if (xml === null) return { ok: false, done: true };

  const parsed = parseSenateXml(xml);

  // 2. Resolve bill from vote_title heuristics — senate XML rarely has
  //    structured bill refs, so bill_id will usually be null.
  const billId: string | null = null;

  // 3. Upsert roll_call_votes row.
  const voteInsert: RollCallVoteInsert = {
    bill_id: billId,
    chamber: 'senate',
    vote_date: parsed.voteDate ?? null,
    result: parsed.result ?? null,
    vote_number: rollNumber,
    congress,
    metadata: {
      session,
      question: parsed.question ?? null,
      source_data_url: senateXmlUrl(congress, session, rollNumber),
    },
  };

  const voteId = await upsertRollCallVote(voteInsert);
  if (!voteId) return { ok: false, done: false };

  // 4. Resolve member positions by first+last name.
  const positionInserts: VotePositionInsert[] = [];
  for (const mv of parsed.members) {
    const position = mapPosition(mv.vote);
    if (!position) {
      console.warn(
        `  WARN unknown position "${mv.vote}" for ${mv.firstName} ${mv.lastName} senate #${rollNumber}`,
      );
      continue;
    }
    const officialId = await resolveOfficialByName(mv.firstName, mv.lastName);
    if (!officialId) continue;
    positionInserts.push({ vote_id: voteId, official_id: officialId, position });
  }

  await persistPositions(voteId, positionInserts, `senate #${rollNumber}`);
  return { ok: true, done: false };
}

async function importAllSenateVotes(congress: number): Promise<void> {
  console.log('\n--- SENATE ---');
  console.log('  (No list API — enumerating XML files directly)');

  // Determine which sessions to scan based on the current year.
  // Congress 119 spans 2025–2026; session 1 = 2025, session 2 = 2026.
  const currentYear = new Date().getFullYear();
  const sessionsToScan: Array<1 | 2> = [1];
  if (senateSessionForYear(congress, currentYear) === 2) {
    sessionsToScan.push(2);
  }

  let grandOk = 0;
  let grandErr = 0;

  for (const session of sessionsToScan) {
    console.log(`\n  Session ${session} — enumerating …\n`);
    let rollNumber = 1;
    let ok = 0;
    let err = 0;

    while (true) {
      const { ok: voteOk, done } = await importSenateVote(congress, session, rollNumber);

      if (done) {
        process.stdout.write(`\n  [session ${session}] Reached end at roll #${rollNumber - 1}\n`);
        break;
      }

      if (voteOk) {
        ok++;
        process.stdout.write('.');
      } else {
        err++;
        process.stdout.write('E');
      }

      if (rollNumber % BATCH_SIZE === 0) {
        process.stdout.write(`  [roll #${rollNumber}] ok=${ok} err=${err}\n`);
      }

      rollNumber++;
    }

    console.log(`  Session ${session} complete — imported: ${ok}, failed: ${err}`);
    grandOk += ok;
    grandErr += err;
  }

  console.log(`  SENATE complete — imported: ${grandOk}, failed: ${grandErr}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importVotes(): Promise<void> {
  console.log(`=== Import Roll Call Votes (Congress ${TARGET_CONGRESS}) ===\n`);

  const apiKey = process.env.CONGRESS_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing environment variable: CONGRESS_API_KEY\n' +
        'Obtain a free key at https://api.congress.gov/',
    );
  }

  await importAllHouseVotes(TARGET_CONGRESS, apiKey);
  await importAllSenateVotes(TARGET_CONGRESS);

  console.log('\n=== Completed. ===');
}

importVotes().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
