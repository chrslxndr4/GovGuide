/**
 * Import congressional roll call votes from the Congress.gov API.
 *
 * Requires environment variable:  CONGRESS_API_KEY
 * Obtain a free key at: https://api.congress.gov/
 *
 * For each roll call vote in the target congress this script:
 *   1. Pages through /vote/{congress}/{chamber} for both senate and house.
 *   2. Fetches per-vote detail (/vote/{congress}/{chamber}/{rollcallNumber})
 *      to retrieve individual member positions.
 *   3. Upserts a roll_call_votes row (conflict key: vote_number + congress + chamber).
 *   4. Optionally links the vote to an existing bills row if the API provides a
 *      bill reference.
 *   5. Upserts vote_positions rows (conflict key: vote_id + official_id) after
 *      resolving official UUIDs via bioguide_id.
 *   Records are flushed in batches of 100.
 *
 * Run with:  npm run import:votes
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types — Congress.gov API shapes
// ---------------------------------------------------------------------------

interface CongressApiPagination {
  count: number;
  total?: number;
  next?: string | null;
}

type ChamberCode = 'senate' | 'house';

interface VoteStub {
  congress: number;
  chamber: string;          // "Senate" | "House"
  rollNumber: number;       // sequential roll call number within the congress+chamber
  url: string;              // self-referential API link
  date?: string;            // "YYYY-MM-DD" (may be absent on some stubs)
  question?: string;
  description?: string;
  result?: string;
}

interface VoteListResponse {
  votes: VoteStub[];
  pagination: CongressApiPagination;
}

interface MemberVote {
  bioguideId: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  vote: string;             // "Yes" | "No" | "Present" | "Not Voting"
  party?: string;
  state?: string;
}

interface VoteBillRef {
  number?: string;
  type?: string;
  congress?: number;
}

interface VoteDetail {
  congress: number;
  chamber: string;
  rollNumber: number;
  date?: string;
  question?: string;
  description?: string;
  result?: string;
  bill?: VoteBillRef;
  votes?: {
    item?: MemberVote[];
    // The API groups positions by vote value at times; normalise below.
    [key: string]: unknown;
  };
  // Alternative flattened structure returned by some endpoints.
  memberVotes?: MemberVote[];
}

interface VoteDetailResponse {
  vote: VoteDetail;
}

// ---------------------------------------------------------------------------
// Types — DB insert shapes
// ---------------------------------------------------------------------------

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
// Constants
// ---------------------------------------------------------------------------

const CONGRESS_API_BASE = 'https://api.congress.gov/v3';
const PAGE_LIMIT = 250;
const BATCH_SIZE = 100;

// The congress number to import.  Override via env: CONGRESS_NUMBER=119
const TARGET_CONGRESS = parseInt(process.env.CONGRESS_NUMBER ?? '119', 10);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise the Congress.gov chamber string to our DB enum value.
 */
function normaliseChamber(raw: string): ChamberCode | null {
  const lower = raw.toLowerCase();
  if (lower.includes('senate')) return 'senate';
  if (lower.includes('house')) return 'house';
  return null;
}

/**
 * Map Congress.gov vote strings to our position enum.
 *
 * Congress.gov uses:  "Yea" / "Yes" / "No" / "Nay" / "Present" / "Not Voting"
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
 * Extract the flat list of MemberVote entries from the detail object.
 * Congress.gov returns member votes either under votes.item[] or grouped by
 * position ("votes": { "Yea": [...], "Nay": [...], ... }).
 */
function extractMemberVotes(detail: VoteDetail): MemberVote[] {
  // Preferred: flat memberVotes array.
  if (Array.isArray(detail.memberVotes) && detail.memberVotes.length > 0) {
    return detail.memberVotes;
  }

  // Alternative: votes.item flat list.
  if (Array.isArray(detail.votes?.item) && (detail.votes?.item?.length ?? 0) > 0) {
    return detail.votes!.item as MemberVote[];
  }

  // Fallback: votes keyed by position string.
  const grouped = detail.votes ?? {};
  const members: MemberVote[] = [];
  for (const [positionKey, entries] of Object.entries(grouped)) {
    if (positionKey === 'item') continue;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as Partial<MemberVote>[]) {
      if (entry.bioguideId) {
        members.push({ ...entry, vote: positionKey } as MemberVote);
      }
    }
  }
  return members;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string, apiKey: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${CONGRESS_API_BASE}${path}${sep}api_key=${apiKey}&format=json`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Congress.gov API error ${res.status} at ${path}: ${res.statusText}`,
    );
  }
  return res.json() as Promise<T>;
}

/**
 * Page through /vote/{congress}/{chamber} and return all vote stubs.
 */
async function fetchAllVoteStubs(
  congress: number,
  chamber: ChamberCode,
  apiKey: string,
): Promise<VoteStub[]> {
  const stubs: VoteStub[] = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    console.log(`  [${chamber}] Fetching vote list offset=${offset} …`);
    const body = await apiFetch<VoteListResponse>(
      `/vote/${congress}/${chamber}?limit=${PAGE_LIMIT}&offset=${offset}`,
      apiKey,
    );
    total = body.pagination.total ?? body.pagination.count;
    stubs.push(...body.votes);
    offset += body.votes.length;
    if (body.votes.length === 0) break;
  }

  console.log(`  [${chamber}] Total vote stubs: ${stubs.length}`);
  return stubs;
}

/**
 * Fetch detail for a single roll call vote.
 */
async function fetchVoteDetail(
  congress: number,
  chamber: ChamberCode,
  rollNumber: number,
  apiKey: string,
): Promise<VoteDetail> {
  const body = await apiFetch<VoteDetailResponse>(
    `/vote/${congress}/${chamber}/${rollNumber}`,
    apiKey,
  );
  return body.vote;
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

/** bioguide_id → officials.id UUID (null = confirmed not found) */
const officialCache = new Map<string, string | null>();

async function resolveOfficialId(bioguideId: string): Promise<string | null> {
  if (officialCache.has(bioguideId)) return officialCache.get(bioguideId)!;

  const { data, error } = await supabase
    .from('officials')
    .select('id')
    .eq('bioguide_id', bioguideId)
    .maybeSingle();

  if (error) {
    console.warn(
      `  WARN looking up official bioguide_id="${bioguideId}": ${error.message}`,
    );
  }

  const id = (data as { id: string } | null)?.id ?? null;
  officialCache.set(bioguideId, id);
  return id;
}

/** "billNumber:congress" → bills.id UUID (null = not found) */
const billCache = new Map<string, string | null>();

async function resolveBillId(
  billRef: VoteBillRef | undefined,
): Promise<string | null> {
  if (!billRef?.number || !billRef?.type) return null;

  const billNumber = `${billRef.type.toUpperCase()} ${billRef.number}`;
  const congress = billRef.congress ?? TARGET_CONGRESS;
  const cacheKey = `${billNumber}:${congress}`;

  if (billCache.has(cacheKey)) return billCache.get(cacheKey)!;

  const { data, error } = await supabase
    .from('bills')
    .select('id')
    .eq('bill_number', billNumber)
    .eq('congress', congress)
    .maybeSingle();

  if (error) {
    console.warn(`  WARN looking up bill "${billNumber}" congress=${congress}: ${error.message}`);
  }

  const id = (data as { id: string } | null)?.id ?? null;
  billCache.set(cacheKey, id);
  return id;
}

// ---------------------------------------------------------------------------
// Batch flush helpers
// ---------------------------------------------------------------------------

async function flushVotePositions(
  batch: VotePositionInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('vote_positions')
    .upsert(batch, { onConflict: 'vote_id,official_id' });

  if (error) {
    console.error(
      `  BATCH ERROR vote_positions (${batch.length}): ${error.message}`,
    );
    return { ok: 0, err: batch.length };
  }
  return { ok: batch.length, err: 0 };
}

// ---------------------------------------------------------------------------
// Core import logic for a single roll call vote
// ---------------------------------------------------------------------------

async function importVote(
  stub: VoteStub,
  chamber: ChamberCode,
  apiKey: string,
): Promise<{ ok: boolean }> {
  const { congress, rollNumber } = stub;

  // 1. Fetch full vote detail.
  let detail: VoteDetail;
  try {
    detail = await fetchVoteDetail(congress, chamber, rollNumber, apiKey);
  } catch (err) {
    console.error(
      `  ERROR fetching vote ${chamber} #${rollNumber}: ${(err as Error).message}`,
    );
    return { ok: false };
  }

  // 2. Optionally link to a bill.
  const billId = await resolveBillId(detail.bill);

  // 3. Upsert roll_call_votes row.
  const voteInsert: RollCallVoteInsert = {
    bill_id: billId,
    chamber,
    vote_date: detail.date ?? stub.date ?? null,
    result: detail.result ?? stub.result ?? null,
    vote_number: rollNumber,
    congress,
    metadata: {
      question: detail.question ?? stub.question ?? null,
      description: detail.description ?? stub.description ?? null,
      congress_api_url: stub.url,
    },
  };

  const { data: upserted, error: voteErr } = await supabase
    .from('roll_call_votes')
    .upsert(voteInsert, { onConflict: 'vote_number,congress,chamber' })
    .select('id')
    .single();

  if (voteErr || !upserted) {
    console.error(
      `  ERROR upserting vote ${chamber} #${rollNumber}: ${voteErr?.message}`,
    );
    return { ok: false };
  }

  const voteId = (upserted as { id: string }).id;

  // 4. Resolve and upsert vote_positions.
  const memberVotes = extractMemberVotes(detail);
  const positionInserts: VotePositionInsert[] = [];

  for (const mv of memberVotes) {
    if (!mv.bioguideId) continue;

    const position = mapPosition(mv.vote);
    if (!position) {
      console.warn(
        `  WARN unknown position "${mv.vote}" for bioguide_id="${mv.bioguideId}" on vote #${rollNumber}`,
      );
      continue;
    }

    const officialId = await resolveOfficialId(mv.bioguideId);
    if (!officialId) {
      // Don't warn for every missing member — delegates / vacancies are common.
      continue;
    }

    positionInserts.push({ vote_id: voteId, official_id: officialId, position });
  }

  for (let i = 0; i < positionInserts.length; i += BATCH_SIZE) {
    const chunk = positionInserts.slice(i, i + BATCH_SIZE);
    const { err } = await flushVotePositions(chunk);
    if (err > 0) {
      console.warn(`  WARN ${err} position(s) failed for ${chamber} vote #${rollNumber}`);
    }
  }

  // 5. Create official→bill relationship records for the primary sponsor/bill link.
  //    Only write if both a bill and member positions resolved successfully.
  if (billId && positionInserts.length > 0) {
    // Collect unique official IDs that successfully resolved.
    const resolvedOfficialIds = positionInserts.map((p) => p.official_id);
    const uniqueOfficialIds = [...new Set(resolvedOfficialIds)];

    const relationshipInserts = uniqueOfficialIds.map((officialId) => ({
      from_entity_type: 'official',
      from_entity_id: officialId,
      to_entity_type: 'bill',
      to_entity_id: billId,
      relationship_type: 'voted_on',
      metadata: {
        vote_id: voteId,
        congress,
        chamber,
        roll_number: rollNumber,
      },
    }));

    // Insert relationships in batches; use onConflict to skip duplicates.
    for (let i = 0; i < relationshipInserts.length; i += BATCH_SIZE) {
      const chunk = relationshipInserts.slice(i, i + BATCH_SIZE);
      const { error: relErr } = await supabase
        .from('relationships')
        .upsert(chunk, {
          onConflict: 'from_entity_type,from_entity_id,to_entity_type,to_entity_id,relationship_type',
        });

      if (relErr) {
        // Relationship writes are best-effort; log but don't fail the vote import.
        console.warn(
          `  WARN relationships batch for vote #${rollNumber}: ${relErr.message}`,
        );
      }
    }
  }

  return { ok: true };
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

  const chambers: ChamberCode[] = ['senate', 'house'];
  let grandTotalOk = 0;
  let grandTotalErr = 0;

  for (const chamber of chambers) {
    console.log(`\n--- ${chamber.toUpperCase()} ---`);

    let stubs: VoteStub[];
    try {
      stubs = await fetchAllVoteStubs(TARGET_CONGRESS, chamber, apiKey);
    } catch (err) {
      console.error(
        `  ERROR fetching ${chamber} vote list: ${(err as Error).message}`,
      );
      continue;
    }

    console.log(`\nProcessing ${stubs.length} ${chamber} votes …\n`);

    let chamberOk = 0;
    let chamberErr = 0;

    for (let i = 0; i < stubs.length; i++) {
      const stub = stubs[i];

      // Normalise the chamber string from the stub (may differ from our loop var).
      const resolvedChamber = normaliseChamber(stub.chamber ?? chamber);
      if (!resolvedChamber) {
        console.warn(`  WARN unrecognised chamber "${stub.chamber}" on roll #${stub.rollNumber} — skipping`);
        chamberErr++;
        continue;
      }

      const { ok } = await importVote(stub, resolvedChamber, apiKey);

      if (ok) {
        chamberOk++;
        process.stdout.write('.');
      } else {
        chamberErr++;
        process.stdout.write('E');
      }

      // Print a progress line every BATCH_SIZE votes.
      if ((i + 1) % BATCH_SIZE === 0 || i === stubs.length - 1) {
        process.stdout.write(
          `  [${i + 1}/${stubs.length}] ok=${chamberOk} err=${chamberErr}\n`,
        );
      }
    }

    console.log(
      `  ${chamber.toUpperCase()} complete — imported: ${chamberOk}, failed: ${chamberErr}`,
    );

    grandTotalOk += chamberOk;
    grandTotalErr += chamberErr;
  }

  console.log(
    `\n=== Completed. Total imported: ${grandTotalOk}, total failed: ${grandTotalErr} ===`,
  );
}

importVotes().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
