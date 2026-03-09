/**
 * Import FEC independent expenditures (Schedule E) from the OpenFEC API.
 *
 * Requires environment variable:  FEC_API_KEY
 * Obtain a free key at: https://api.data.gov/signup/
 *
 * For each Schedule E filing this script:
 *   1. Fetches paginated independent expenditure records from
 *      api.open.fec.gov/v1/schedules/schedule_e/ (100/page).
 *   2. Looks up (or creates) the spender entity by fec_committee_id.
 *   3. Looks up the candidate entity by fec_candidate_id when available.
 *   4. Upserts an independent_expenditures record.
 *   5. Upserts a relationship record (type 'spent_for' or 'spent_against').
 *   Records are processed in batches of 500.
 *
 * Optional filter environment variables (passed as query params):
 *   FEC_CYCLE       — two-year election cycle, e.g. "2024"
 *   FEC_COMMITTEE   — specific spender committee ID to scope the import
 *   FEC_CANDIDATE   — specific candidate ID to scope the import
 *
 * Run with:  npm run import:fec-expenditures
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FecExpenditure {
  transaction_id: string;
  filing_id: number | null;
  committee_id: string;                 // spender committee
  committee: {
    name: string | null;
    committee_type: string | null;
  } | null;
  candidate_id: string | null;          // candidate being supported or opposed
  candidate_name: string | null;
  candidate_office: string | null;      // "H" | "S" | "P"
  candidate_party: string | null;
  candidate_state: string | null;
  candidate_district: string | null;
  support_oppose_indicator: string | null; // "S" = support, "O" = oppose
  expenditure_amount: number | null;
  expenditure_date: string | null;         // ISO date
  payee_name: string | null;
  expenditure_description: string | null;
  memo_text: string | null;
  load_date: string | null;
}

interface FecScheduleEResponse {
  results: FecExpenditure[];
  pagination: {
    page: number;
    pages: number;
    per_page: number;
    count: number;
  };
}

type EntityType =
  | 'individual'
  | 'corporation'
  | 'pac'
  | 'political_party'
  | 'government'
  | 'nonprofit'
  | 'other';

interface EntityInsert {
  entity_type: EntityType;
  name: string;
  aliases: string[];
  external_ids: Record<string, string>;
  metadata: Record<string, unknown>;
}

interface IndependentExpenditureInsert {
  spender_entity_id: string;
  candidate_entity_id: string | null;
  amount: number;
  expenditure_date: string | null;
  support_oppose: string | null;  // "support" | "oppose"
  payee: string | null;
  purpose: string | null;
  fec_filing_id: string | null;
  metadata: Record<string, unknown>;
}

interface RelationshipInsert {
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: string;
  amount: number | null;
  date_start: string | null;
  metadata: Record<string, unknown>;
  confidence_score: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FEC_API_BASE = 'https://api.open.fec.gov/v1';
const PAGE_SIZE = 100;
const BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map a FEC committee_type character to a GovGuide entity_type.
 * Mirrors the mapping used in import-fec-committees.ts.
 */
function committeeTypeToEntityType(committeeType: string | null): EntityType {
  switch ((committeeType ?? '').toUpperCase()) {
    case 'X':
    case 'Y':
    case 'Z':
      return 'political_party';
    case 'P':
    case 'H':
    case 'S':
    case 'Q':
    case 'N':
    case 'V':
    case 'W':
    case 'U':
    case 'O':
    case 'D':
    case 'E':
    case 'I':
      return 'pac';
    default:
      return 'other';
  }
}

/**
 * Normalise the FEC support/oppose indicator to a human-readable string.
 *   "S" → "support"
 *   "O" → "oppose"
 *   anything else → null
 */
function normaliseSupportOppose(indicator: string | null): string | null {
  switch ((indicator ?? '').toUpperCase()) {
    case 'S':
      return 'support';
    case 'O':
      return 'oppose';
    default:
      return null;
  }
}

/**
 * Derive the relationship_type from the support/oppose indicator.
 *   "support" → "spent_for"
 *   "oppose"  → "spent_against"
 *   unknown   → "spent_for"   (safe default)
 */
function supportOpposeToRelationshipType(
  supportOppose: string | null,
): 'spent_for' | 'spent_against' {
  return supportOppose === 'oppose' ? 'spent_against' : 'spent_for';
}

// ---------------------------------------------------------------------------
// FEC API pagination
// ---------------------------------------------------------------------------

async function fetchScheduleEPage(
  apiKey: string,
  page: number,
  extraParams: Record<string, string>,
): Promise<FecScheduleEResponse> {
  const params = new URLSearchParams({
    api_key: apiKey,
    per_page: String(PAGE_SIZE),
    page: String(page),
    sort: 'expenditure_date',
    sort_null_only: 'false',
    ...extraParams,
  });

  const url = `${FEC_API_BASE}/schedules/schedule_e/?${params.toString()}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(
      `FEC API error ${res.status} fetching schedule_e page ${page}: ${res.statusText}`,
    );
  }

  return (await res.json()) as FecScheduleEResponse;
}

async function fetchAllExpenditures(
  apiKey: string,
  extraParams: Record<string, string>,
): Promise<FecExpenditure[]> {
  const all: FecExpenditure[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    console.log(`  Fetching schedule_e page ${page}/${totalPages} …`);

    const body = await fetchScheduleEPage(apiKey, page, extraParams);
    totalPages = body.pagination.pages;
    all.push(...body.results);

    if (body.results.length === 0) break;

    page++;
  } while (page <= totalPages);

  console.log(`  Total expenditures fetched: ${all.length}`);
  return all;
}

// ---------------------------------------------------------------------------
// Entity resolution helpers
// ---------------------------------------------------------------------------

/**
 * In-process cache: maps a lookup key → entity UUID.
 * Key format for committee entities:  "committee::<fec_committee_id>"
 * Key format for candidate entities:  "candidate::<fec_candidate_id>"
 */
const entityCache = new Map<string, string>();

/**
 * Resolve (get or create) the spender committee entity.
 * Prefers finding an existing entity imported by import-fec-committees.ts.
 * Creates a minimal entity if not found.
 */
async function resolveSpenderEntity(
  expenditure: FecExpenditure,
): Promise<string | null> {
  const committeeId = expenditure.committee_id;
  const cacheKey = `committee::${committeeId}`;

  if (entityCache.has(cacheKey)) {
    return entityCache.get(cacheKey)!;
  }

  // Try to find a pre-existing entity imported by import-fec-committees.ts.
  const { data: existing, error: lookupError } = await supabase
    .from('entities')
    .select('id')
    .filter('external_ids->>fec_committee_id', 'eq', committeeId)
    .maybeSingle();

  if (lookupError) {
    console.error(
      `  ERROR looking up spender entity "${committeeId}": ${lookupError.message}`,
    );
    return null;
  }

  if (existing) {
    const id = (existing as { id: string }).id;
    entityCache.set(cacheKey, id);
    return id;
  }

  // Committee not previously imported — create a minimal entity so the
  // expenditure can still be stored.
  const committeeName =
    expenditure.committee?.name ?? `FEC Committee ${committeeId}`;
  const entityType = committeeTypeToEntityType(
    expenditure.committee?.committee_type ?? null,
  );

  const insert: EntityInsert = {
    entity_type: entityType,
    name: committeeName,
    aliases: [],
    external_ids: { fec_committee_id: committeeId },
    metadata: {
      committee_type: expenditure.committee?.committee_type ?? null,
      source: 'schedule_e_import',
    },
  };

  const { data: created, error: insertError } = await supabase
    .from('entities')
    .upsert(insert, { onConflict: 'name', ignoreDuplicates: false })
    .select('id')
    .single();

  if (insertError || !created) {
    console.error(
      `  ERROR creating spender entity for committee "${committeeId}": ${insertError?.message}`,
    );
    return null;
  }

  const id = (created as { id: string }).id;
  entityCache.set(cacheKey, id);
  return id;
}

/**
 * Resolve the candidate entity by fec_candidate_id.
 * Returns null if no candidate ID is present or the entity is not found.
 * We do not auto-create candidate entities here — candidates should be
 * imported separately from the /candidates/ endpoint.
 */
async function resolveCandidateEntity(
  candidateId: string | null,
): Promise<string | null> {
  if (!candidateId) return null;

  const cacheKey = `candidate::${candidateId}`;

  if (entityCache.has(cacheKey)) {
    return entityCache.get(cacheKey)!;
  }

  const { data, error } = await supabase
    .from('entities')
    .select('id')
    .filter('external_ids->>fec_candidate_id', 'eq', candidateId)
    .maybeSingle();

  if (error) {
    console.error(
      `  ERROR looking up candidate entity "${candidateId}": ${error.message}`,
    );
    return null;
  }

  if (!data) {
    // Candidate not yet imported; return null rather than auto-creating.
    return null;
  }

  const id = (data as { id: string }).id;
  entityCache.set(cacheKey, id);
  return id;
}

// ---------------------------------------------------------------------------
// Batch upsert helpers
// ---------------------------------------------------------------------------

async function flushExpenditures(
  batch: IndependentExpenditureInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('independent_expenditures')
    .upsert(batch, {
      onConflict: 'fec_filing_id,spender_entity_id,candidate_entity_id',
    });

  if (error) {
    console.error(
      `  BATCH independent_expenditures UPSERT ERROR (${batch.length} records): ${error.message}`,
    );
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

async function flushRelationships(
  batch: RelationshipInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('relationships')
    .upsert(batch, {
      onConflict: 'source_entity_id,target_entity_id,relationship_type',
    });

  if (error) {
    console.error(
      `  BATCH relationships UPSERT ERROR (${batch.length} records): ${error.message}`,
    );
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importFecExpenditures(): Promise<void> {
  console.log('=== Import FEC Independent Expenditures (Schedule E) ===\n');

  const apiKey = process.env.FEC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing environment variable: FEC_API_KEY\n' +
        'Obtain a free key at https://api.data.gov/signup/',
    );
  }

  // Optional scoping filters from environment.
  const extraParams: Record<string, string> = {};
  if (process.env.FEC_CYCLE) {
    extraParams['two_year_transaction_period'] = process.env.FEC_CYCLE;
  }
  if (process.env.FEC_COMMITTEE) {
    extraParams['committee_id'] = process.env.FEC_COMMITTEE;
  }
  if (process.env.FEC_CANDIDATE) {
    extraParams['candidate_id'] = process.env.FEC_CANDIDATE;
  }

  const expenditures = await fetchAllExpenditures(apiKey, extraParams);

  let totalExpendituresOk = 0;
  let totalExpendituresErr = 0;
  let totalRelationshipsOk = 0;
  let totalRelationshipsErr = 0;
  let totalSkipped = 0;

  const expenditureBatch: IndependentExpenditureInsert[] = [];
  const relationshipBatch: RelationshipInsert[] = [];

  /**
   * Flush accumulated batches when either reaches BATCH_SIZE, or when forced.
   */
  async function maybeFlush(force = false): Promise<void> {
    if (
      force ||
      expenditureBatch.length >= BATCH_SIZE ||
      relationshipBatch.length >= BATCH_SIZE
    ) {
      if (expenditureBatch.length > 0) {
        const { ok, err } = await flushExpenditures(
          expenditureBatch.splice(0, expenditureBatch.length),
        );
        totalExpendituresOk += ok;
        totalExpendituresErr += err;
        process.stdout.write(
          `  independent_expenditures flushed (ok=${ok}, err=${err})\n`,
        );
      }

      if (relationshipBatch.length > 0) {
        const { ok, err } = await flushRelationships(
          relationshipBatch.splice(0, relationshipBatch.length),
        );
        totalRelationshipsOk += ok;
        totalRelationshipsErr += err;
        process.stdout.write(
          `  relationships flushed (ok=${ok}, err=${err})\n`,
        );
      }
    }
  }

  for (const expenditure of expenditures) {
    // Skip records without an amount.
    if (
      expenditure.expenditure_amount === null ||
      expenditure.expenditure_amount === undefined
    ) {
      totalSkipped++;
      continue;
    }

    // 1. Resolve spender entity.
    const spenderEntityId = await resolveSpenderEntity(expenditure);
    if (!spenderEntityId) {
      totalSkipped++;
      continue;
    }

    // 2. Resolve candidate entity (may be null — expenditures targeting issues
    //    rather than named candidates will have no candidate_id).
    const candidateEntityId = await resolveCandidateEntity(expenditure.candidate_id);

    // 3. Normalise support/oppose.
    const supportOppose = normaliseSupportOppose(
      expenditure.support_oppose_indicator,
    );

    // 4. Build independent_expenditures row.
    const expenditureRow: IndependentExpenditureInsert = {
      spender_entity_id: spenderEntityId,
      candidate_entity_id: candidateEntityId,
      amount: expenditure.expenditure_amount,
      expenditure_date: expenditure.expenditure_date,
      support_oppose: supportOppose,
      payee: expenditure.payee_name,
      purpose: expenditure.expenditure_description,
      fec_filing_id: expenditure.filing_id !== null
        ? String(expenditure.filing_id)
        : null,
      metadata: {
        transaction_id: expenditure.transaction_id,
        memo_text: expenditure.memo_text,
        candidate_name: expenditure.candidate_name,
        candidate_office: expenditure.candidate_office,
        candidate_party: expenditure.candidate_party,
        candidate_state: expenditure.candidate_state,
        candidate_district: expenditure.candidate_district,
        load_date: expenditure.load_date,
      },
    };

    expenditureBatch.push(expenditureRow);

    // 5. Build relationship row (only when we have a candidate to link to).
    if (candidateEntityId) {
      const relationshipType = supportOpposeToRelationshipType(supportOppose);

      const relationshipRow: RelationshipInsert = {
        source_entity_id: spenderEntityId,
        target_entity_id: candidateEntityId,
        relationship_type: relationshipType,
        amount: expenditure.expenditure_amount,
        date_start: expenditure.expenditure_date,
        metadata: {
          fec_transaction_id: expenditure.transaction_id,
          fec_filing_id: expenditure.filing_id,
          support_oppose_indicator: expenditure.support_oppose_indicator,
          payee: expenditure.payee_name,
          purpose: expenditure.expenditure_description,
        },
        confidence_score: 1.0,
      };

      relationshipBatch.push(relationshipRow);
    }

    await maybeFlush();
  }

  // Flush remaining records.
  await maybeFlush(true);

  console.log('\n=== Completed. ===');
  console.log(
    `  Independent expenditures inserted/updated: ${totalExpendituresOk}, errors: ${totalExpendituresErr}`,
  );
  console.log(
    `  Relationships inserted/updated: ${totalRelationshipsOk}, errors: ${totalRelationshipsErr}`,
  );
  console.log(
    `  Skipped (missing amount or unresolvable spender): ${totalSkipped}`,
  );
}

importFecExpenditures().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
