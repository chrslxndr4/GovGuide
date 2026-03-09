/**
 * Import bills and resolutions from the Congress.gov API.
 *
 * Requires environment variable:  CONGRESS_API_KEY
 * Obtain a free key at: https://api.congress.gov/
 *
 * For each bill in the target congress this script:
 *   1. Pages through /bill/{congress} to collect bill stubs.
 *   2. Fetches full detail (/bill/{congress}/{type}/{number}) for each stub,
 *      including sponsors, cosponsors, and subjects.
 *   3. Fetches the action history (/bill/{congress}/{type}/{number}/actions).
 *   4. Upserts a bills row (conflict key: bill_number + congress).
 *   5. Upserts bill_actions rows (conflict key: bill_id + action_date + action_text).
 *   6. Upserts bill_sponsors rows after resolving official UUIDs via bioguide_id.
 *   Records are flushed in batches of 100.
 *
 * Run with:  npm run import:bills
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

interface BillStub {
  number: string;
  type: string;           // "HR" | "S" | "HJRES" | "SJRES" | "HCONRES" | "SCONRES" | "HRES" | "SRES"
  congress: number;
  title: string;
  originChamber: string;
  originChamberCode: string;
  introducedDate: string; // "YYYY-MM-DD"
  latestAction?: {
    actionDate: string;
    text: string;
  };
  url: string;            // self-referential API link
}

interface BillListResponse {
  bills: BillStub[];
  pagination: CongressApiPagination;
}

interface Sponsor {
  bioguideId: string;
  fullName: string;
  isByRequest?: string;  // "Y" / "N"
}

interface PolicyArea {
  name: string;
}

interface Subject {
  name: string;
}

interface LegislativeSubjects {
  item?: Subject[];
}

interface SubjectWrapper {
  legislativeSubjects?: LegislativeSubjects;
  policyArea?: PolicyArea;
}

interface TextVersion {
  formats?: Array<{ url: string; type: string }>;
}

interface Summaries {
  summary?: Array<{ text: string; actionDate: string }>;
}

interface BillDetail {
  number: string;
  type: string;
  congress: number;
  title: string;
  introducedDate: string;
  latestAction?: { actionDate: string; text: string };
  sponsors?: Sponsor[];
  cosponsors?: {
    item?: Sponsor[];
    count?: number;
  };
  subjects?: SubjectWrapper;
  textVersions?: { item?: TextVersion[] };
  summaries?: Summaries;
  policyArea?: PolicyArea;
}

interface BillDetailResponse {
  bill: BillDetail;
}

interface CosponsorItem {
  bioguideId: string;
  fullName: string;
}

interface CosponsorResponse {
  cosponsors: CosponsorItem[];
  pagination: CongressApiPagination;
}

interface ActionItem {
  actionDate: string;  // "YYYY-MM-DD"
  text: string;
  type: string;
}

interface ActionsResponse {
  actions: ActionItem[];
  pagination: CongressApiPagination;
}

// ---------------------------------------------------------------------------
// Types — DB insert shapes
// ---------------------------------------------------------------------------

interface BillInsert {
  bill_number: string;
  congress: number;
  session: number | null;
  title: string;
  summary: string | null;
  status: string | null;
  subjects: string[];
  policy_area: string | null;
  text_url: string | null;
  introduced_date: string | null;
  last_action_date: string | null;
  metadata: Record<string, unknown>;
}

interface BillActionInsert {
  bill_id: string;
  action_date: string | null;
  action_text: string;
  action_type: string | null;
  metadata: Record<string, unknown>;
}

interface BillSponsorInsert {
  bill_id: string;
  official_id: string;
  sponsor_type: 'sponsor' | 'cosponsor';
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
 * Derive a human-readable bill_number from type + number.
 * e.g. type="HR", number="1" → "HR 1"
 */
function formatBillNumber(type: string, number: string): string {
  return `${type} ${number}`;
}

/**
 * Map congress number to a session number (1 = odd year, 2 = even year within
 * a two-year Congress).  This is a best-effort approximation.
 */
function congressToSession(congress: number): number | null {
  // 119th Congress began in 2025 (odd = session 1).  Each congress spans two
  // calendar years, so we can't determine the session without the actual date.
  // Return null to let the database default handle it.
  return null;
}

/**
 * Extract the most recent summary text from the summaries array.
 */
function extractSummary(summaries: Summaries | undefined): string | null {
  if (!summaries?.summary?.length) return null;
  // Sort descending by actionDate and return the first entry's text.
  const sorted = [...summaries.summary].sort((a, b) =>
    b.actionDate.localeCompare(a.actionDate),
  );
  // Strip HTML tags that Congress.gov includes in summary text.
  return sorted[0].text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract subjects from the nested SubjectWrapper structure.
 */
function extractSubjects(subjects: SubjectWrapper | undefined): string[] {
  return (subjects?.legislativeSubjects?.item ?? []).map((s) => s.name);
}

/**
 * Pick the best available text URL (preferring Enrolled, then PDF, then any).
 */
function extractTextUrl(versions: { item?: TextVersion[] } | undefined): string | null {
  const items = versions?.item ?? [];
  if (items.length === 0) return null;
  // Prefer enrolled bill text; fall back to any available format.
  const enrolled = items.find((v) =>
    v.formats?.some((f) => f.type?.toLowerCase().includes('enrolled')),
  );
  const target = enrolled ?? items[0];
  // Prefer PDF over HTML over plain text.
  const formats = target.formats ?? [];
  const pdf = formats.find((f) => f.type?.toLowerCase() === 'pdf');
  const html = formats.find((f) => f.type?.toLowerCase().includes('html'));
  return pdf?.url ?? html?.url ?? formats[0]?.url ?? null;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function apiFetch<T>(path: string, apiKey: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${CONGRESS_API_BASE}${path}${sep}api_key=${apiKey}&format=json`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Congress.gov API error ${res.status} at ${path}: ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Page through /bill/{congress} and return all bill stubs.
 */
async function fetchAllBillStubs(
  congress: number,
  apiKey: string,
): Promise<BillStub[]> {
  const stubs: BillStub[] = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    console.log(`  Fetching bill list offset=${offset} …`);
    const body = await apiFetch<BillListResponse>(
      `/bill/${congress}?limit=${PAGE_LIMIT}&offset=${offset}`,
      apiKey,
    );
    total = body.pagination.total ?? body.pagination.count;
    stubs.push(...body.bills);
    offset += body.bills.length;
    if (body.bills.length === 0) break;
  }

  console.log(`  Total stubs fetched: ${stubs.length}`);
  return stubs;
}

/**
 * Fetch the full detail record for a single bill.
 */
async function fetchBillDetail(
  congress: number,
  type: string,
  number: string,
  apiKey: string,
): Promise<BillDetail> {
  const body = await apiFetch<BillDetailResponse>(
    `/bill/${congress}/${type.toLowerCase()}/${number}`,
    apiKey,
  );
  return body.bill;
}

/**
 * Fetch all actions for a bill, handling pagination.
 */
async function fetchBillActions(
  congress: number,
  type: string,
  number: string,
  apiKey: string,
): Promise<ActionItem[]> {
  const actions: ActionItem[] = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const body = await apiFetch<ActionsResponse>(
      `/bill/${congress}/${type.toLowerCase()}/${number}/actions?limit=${PAGE_LIMIT}&offset=${offset}`,
      apiKey,
    );
    total = body.pagination.total ?? body.pagination.count;
    actions.push(...body.actions);
    offset += body.actions.length;
    if (body.actions.length === 0) break;
  }

  return actions;
}

/**
 * Fetch all cosponsors for a bill, handling pagination.
 */
async function fetchCosponsors(
  congress: number,
  type: string,
  number: string,
  apiKey: string,
): Promise<CosponsorItem[]> {
  const cosponsors: CosponsorItem[] = [];
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const body = await apiFetch<CosponsorResponse>(
      `/bill/${congress}/${type.toLowerCase()}/${number}/cosponsors?limit=${PAGE_LIMIT}&offset=${offset}`,
      apiKey,
    );
    total = body.pagination.total ?? body.pagination.count;
    cosponsors.push(...body.cosponsors);
    offset += body.cosponsors.length;
    if (body.cosponsors.length === 0) break;
  }

  return cosponsors;
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

/** bioguide_id → officials.id UUID */
const officialCache = new Map<string, string | null>();

async function resolveOfficialId(bioguideId: string): Promise<string | null> {
  if (officialCache.has(bioguideId)) return officialCache.get(bioguideId)!;

  const { data, error } = await supabase
    .from('officials')
    .select('id')
    .eq('bioguide_id', bioguideId)
    .maybeSingle();

  if (error) {
    console.warn(`  WARN looking up official bioguide_id="${bioguideId}": ${error.message}`);
  }

  const id = (data as { id: string } | null)?.id ?? null;
  officialCache.set(bioguideId, id);
  return id;
}

// ---------------------------------------------------------------------------
// Batch flush helpers
// ---------------------------------------------------------------------------

async function flushBillActions(
  batch: BillActionInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  // Use upsert with composite conflict key to avoid duplicates on re-runs.
  const { error } = await supabase
    .from('bill_actions')
    .upsert(batch, { onConflict: 'bill_id,action_date,action_text' });

  if (error) {
    console.error(`  BATCH ERROR bill_actions (${batch.length}): ${error.message}`);
    return { ok: 0, err: batch.length };
  }
  return { ok: batch.length, err: 0 };
}

async function flushBillSponsors(
  batch: BillSponsorInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('bill_sponsors')
    .upsert(batch, { onConflict: 'bill_id,official_id' });

  if (error) {
    console.error(`  BATCH ERROR bill_sponsors (${batch.length}): ${error.message}`);
    return { ok: 0, err: batch.length };
  }
  return { ok: batch.length, err: 0 };
}

// ---------------------------------------------------------------------------
// Core import logic for a single bill
// ---------------------------------------------------------------------------

async function importBill(
  stub: BillStub,
  apiKey: string,
): Promise<{ ok: boolean }> {
  const { type, number, congress } = stub;

  // 1. Fetch full detail and action history concurrently.
  let detail: BillDetail;
  let actions: ActionItem[];

  try {
    [detail, actions] = await Promise.all([
      fetchBillDetail(congress, type, number, apiKey),
      fetchBillActions(congress, type, number, apiKey),
    ]);
  } catch (err) {
    console.error(
      `  ERROR fetching detail/actions for ${type} ${number}: ${(err as Error).message}`,
    );
    return { ok: false };
  }

  // 2. Fetch full cosponsor list if the detail record shows a count > 0.
  let cosponsors: CosponsorItem[] = [];
  const cosponsorCount = detail.cosponsors?.count ?? detail.cosponsors?.item?.length ?? 0;
  if (cosponsorCount > 0) {
    try {
      cosponsors = await fetchCosponsors(congress, type, number, apiKey);
    } catch (err) {
      console.warn(
        `  WARN fetching cosponsors for ${type} ${number}: ${(err as Error).message}`,
      );
    }
  }

  // 3. Build bills row.
  const subjects = extractSubjects(detail.subjects);
  const policyArea =
    detail.policyArea?.name ?? detail.subjects?.policyArea?.name ?? null;
  const textUrl = extractTextUrl(detail.textVersions);
  const summary = extractSummary(detail.summaries);
  const lastActionDate =
    detail.latestAction?.actionDate ?? stub.latestAction?.actionDate ?? null;

  const billInsert: BillInsert = {
    bill_number: formatBillNumber(type, number),
    congress,
    session: congressToSession(congress),
    title: detail.title ?? stub.title,
    summary,
    status: detail.latestAction?.text ?? stub.latestAction?.text ?? null,
    subjects,
    policy_area: policyArea,
    text_url: textUrl,
    introduced_date: detail.introducedDate ?? stub.introducedDate ?? null,
    last_action_date: lastActionDate ?? null,
    metadata: {
      type,
      number,
      origin_chamber: stub.originChamber,
      origin_chamber_code: stub.originChamberCode,
      congress_api_url: stub.url,
    },
  };

  // 4. Upsert the bills row and retrieve its UUID.
  const { data: upserted, error: billErr } = await supabase
    .from('bills')
    .upsert(billInsert, { onConflict: 'bill_number,congress' })
    .select('id')
    .single();

  if (billErr || !upserted) {
    console.error(
      `  ERROR upserting bill ${type} ${number}: ${billErr?.message}`,
    );
    return { ok: false };
  }

  const billId = (upserted as { id: string }).id;

  // 5. Upsert bill_actions.
  if (actions.length > 0) {
    const actionInserts: BillActionInsert[] = actions.map((a) => ({
      bill_id: billId,
      action_date: a.actionDate ?? null,
      action_text: a.text,
      action_type: a.type ?? null,
      metadata: {},
    }));

    for (let i = 0; i < actionInserts.length; i += BATCH_SIZE) {
      const chunk = actionInserts.slice(i, i + BATCH_SIZE);
      const { err } = await flushBillActions(chunk);
      if (err > 0) {
        console.warn(`  WARN ${err} action(s) failed for ${type} ${number}`);
      }
    }
  }

  // 6. Resolve sponsor official UUIDs and upsert bill_sponsors.
  const sponsorInserts: BillSponsorInsert[] = [];

  // Primary sponsors from the detail record.
  for (const sponsor of detail.sponsors ?? []) {
    const officialId = await resolveOfficialId(sponsor.bioguideId);
    if (!officialId) {
      console.warn(
        `  WARN sponsor bioguide_id="${sponsor.bioguideId}" not found in officials`,
      );
      continue;
    }
    sponsorInserts.push({ bill_id: billId, official_id: officialId, sponsor_type: 'sponsor' });
  }

  // Cosponsors.
  for (const cosponsor of cosponsors) {
    const officialId = await resolveOfficialId(cosponsor.bioguideId);
    if (!officialId) {
      console.warn(
        `  WARN cosponsor bioguide_id="${cosponsor.bioguideId}" not found in officials`,
      );
      continue;
    }
    // Avoid duplicating a sponsor who also appears as a cosponsor.
    if (!sponsorInserts.some((s) => s.official_id === officialId)) {
      sponsorInserts.push({ bill_id: billId, official_id: officialId, sponsor_type: 'cosponsor' });
    }
  }

  for (let i = 0; i < sponsorInserts.length; i += BATCH_SIZE) {
    const chunk = sponsorInserts.slice(i, i + BATCH_SIZE);
    const { err } = await flushBillSponsors(chunk);
    if (err > 0) {
      console.warn(`  WARN ${err} sponsor(s) failed for ${type} ${number}`);
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importBills(): Promise<void> {
  console.log(`=== Import Bills (Congress ${TARGET_CONGRESS}) ===\n`);

  const apiKey = process.env.CONGRESS_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing environment variable: CONGRESS_API_KEY\n' +
        'Obtain a free key at https://api.congress.gov/',
    );
  }

  // Fetch the full list of bill stubs for the target congress.
  const stubs = await fetchAllBillStubs(TARGET_CONGRESS, apiKey);
  console.log(`\nProcessing ${stubs.length} bills …\n`);

  let totalOk = 0;
  let totalErr = 0;

  // Process stubs in groups of BATCH_SIZE so we log progress regularly.
  for (let i = 0; i < stubs.length; i++) {
    const stub = stubs[i];
    const { ok } = await importBill(stub, apiKey);

    if (ok) {
      totalOk++;
      process.stdout.write('.');
    } else {
      totalErr++;
      process.stdout.write('E');
    }

    // Print a progress line every BATCH_SIZE bills.
    if ((i + 1) % BATCH_SIZE === 0 || i === stubs.length - 1) {
      process.stdout.write(
        `  [${i + 1}/${stubs.length}] ok=${totalOk} err=${totalErr}\n`,
      );
    }
  }

  console.log(
    `\n=== Completed. Imported: ${totalOk}, failed: ${totalErr} ===`,
  );
}

importBills().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
