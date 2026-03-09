/**
 * Import FEC individual contributions (Schedule A) from the OpenFEC API.
 *
 * Requires environment variable:  FEC_API_KEY
 * Obtain a free key at: https://api.data.gov/signup/
 *
 * For each Schedule A filing this script:
 *   1. Fetches paginated contribution records from
 *      api.open.fec.gov/v1/schedules/schedule_a/ (100/page).
 *   2. Upserts an entity record for the donor (type 'individual' or
 *      'corporation'), keyed on the contributor's name + employer when no
 *      FEC contributor_id is present.
 *   3. Looks up the recipient committee entity by fec_committee_id.
 *   4. Upserts a contribution record linking the donor and recipient.
 *   5. Upserts a relationship record (type 'donated_to').
 *   Records are processed in batches of 500.
 *
 * Optional filter environment variables (passed as query params):
 *   FEC_CYCLE       — two-year election cycle, e.g. "2024"
 *   FEC_COMMITTEE   — specific committee ID to scope the import
 *
 * Run with:  npm run import:fec-contributions
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FecContribution {
  transaction_id: string;               // unique within a filing
  filing_id: number | null;
  committee_id: string;                 // recipient committee
  contributor_id: string | null;        // FEC entity ID for the donor (if known)
  contributor_name: string | null;
  contributor_employer: string | null;
  contributor_occupation: string | null;
  contributor_aggregate_ytd: number | null;
  entity_type: string | null;           // "IND" | "ORG" | "PAC" | "CCM" | "PTY" | "CAN" | "MBR"
  entity_type_desc: string | null;
  contribution_receipt_amount: number | null;
  contribution_receipt_date: string | null; // ISO date
  memo_text: string | null;
  load_date: string | null;
}

interface FecScheduleAResponse {
  results: FecContribution[];
  pagination: {
    page: number;
    pages: number;
    per_page: number;
    count: number;
    last_indexes?: {
      last_index: string;
      last_contribution_receipt_date: string;
    };
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

interface ContributionInsert {
  donor_entity_id: string;
  recipient_entity_id: string;
  amount: number;
  contribution_date: string | null;
  fec_filing_id: string | null;
  contribution_type: string | null;
  employer: string | null;
  occupation: string | null;
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
 * Map FEC entity_type codes to GovGuide entity_type values.
 *
 * FEC entity type codes:
 *   IND = Individual
 *   ORG = Organization (catch-all for corporations/associations)
 *   PAC = Political action committee
 *   CCM = Candidate committee
 *   PTY = Political party
 *   CAN = Candidate
 *   MBR = Membership organization
 */
function fecEntityTypeToGovGuide(fecType: string | null): EntityType {
  switch ((fecType ?? '').toUpperCase()) {
    case 'IND':
    case 'CAN':
      return 'individual';
    case 'ORG':
    case 'MBR':
      return 'corporation';
    case 'PAC':
    case 'CCM':
      return 'pac';
    case 'PTY':
      return 'political_party';
    default:
      return 'other';
  }
}

/**
 * Derive a stable name for a donor entity.
 * Falls back to "UNKNOWN DONOR" so inserts never fail on a null name.
 */
function donorName(contribution: FecContribution): string {
  return (contribution.contributor_name ?? 'UNKNOWN DONOR').trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// FEC API pagination
// ---------------------------------------------------------------------------

/**
 * Fetch one page of Schedule A records.
 * The FEC API uses cursor-based pagination via last_index for large result
 * sets, but also supports page-number pagination for smaller queries.  We use
 * page-number pagination here for simplicity and fall back to cursor when
 * the API signals it via pagination.last_indexes.
 */
async function fetchScheduleAPage(
  apiKey: string,
  page: number,
  extraParams: Record<string, string>,
): Promise<FecScheduleAResponse> {
  const params = new URLSearchParams({
    api_key: apiKey,
    per_page: String(PAGE_SIZE),
    page: String(page),
    sort: 'contribution_receipt_date',
    sort_null_only: 'false',
    ...extraParams,
  });

  const url = `${FEC_API_BASE}/schedules/schedule_a/?${params.toString()}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(
      `FEC API error ${res.status} fetching schedule_a page ${page}: ${res.statusText}`,
    );
  }

  return (await res.json()) as FecScheduleAResponse;
}

async function fetchAllContributions(
  apiKey: string,
  extraParams: Record<string, string>,
): Promise<FecContribution[]> {
  const all: FecContribution[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    console.log(`  Fetching schedule_a page ${page}/${totalPages} …`);

    const body = await fetchScheduleAPage(apiKey, page, extraParams);
    totalPages = body.pagination.pages;
    all.push(...body.results);

    if (body.results.length === 0) break;

    page++;
  } while (page <= totalPages);

  console.log(`  Total contributions fetched: ${all.length}`);
  return all;
}

// ---------------------------------------------------------------------------
// Entity resolution helpers
// ---------------------------------------------------------------------------

/**
 * In-process cache: maps a lookup key → entity UUID.
 * Key format for donors without an FEC contributor_id:  "name||employer"
 * Key format for donors with an FEC contributor_id:     "fec::<id>"
 * Key format for recipient committees:                  "committee::<id>"
 */
const entityCache = new Map<string, string>();

/**
 * Resolve (get or create) a donor entity.  Returns the UUID or null on error.
 */
async function resolveDonorEntity(
  contribution: FecContribution,
): Promise<string | null> {
  // Build a stable cache key.
  const cacheKey = contribution.contributor_id
    ? `fec::${contribution.contributor_id}`
    : `name||${donorName(contribution)}||${(contribution.contributor_employer ?? '').toUpperCase()}`;

  if (entityCache.has(cacheKey)) {
    return entityCache.get(cacheKey)!;
  }

  const entityType = fecEntityTypeToGovGuide(contribution.entity_type);
  const name = donorName(contribution);

  const externalIds: Record<string, string> = {};
  if (contribution.contributor_id) {
    externalIds['fec_contributor_id'] = contribution.contributor_id;
  }

  const insert: EntityInsert = {
    entity_type: entityType,
    name,
    aliases: [],
    external_ids: externalIds,
    metadata: {
      employer: contribution.contributor_employer,
      occupation: contribution.contributor_occupation,
    },
  };

  // Try to find an existing entity first to avoid unnecessary writes.
  const lookupField = contribution.contributor_id
    ? { column: 'external_ids->>fec_contributor_id', value: contribution.contributor_id }
    : null;

  if (lookupField) {
    const { data: existing } = await supabase
      .from('entities')
      .select('id')
      .filter(lookupField.column, 'eq', lookupField.value)
      .maybeSingle();

    if (existing) {
      entityCache.set(cacheKey, (existing as { id: string }).id);
      return (existing as { id: string }).id;
    }
  }

  // Upsert on name — for donors without FEC IDs this is the best we can do.
  const { data, error } = await supabase
    .from('entities')
    .upsert(insert, { onConflict: 'name', ignoreDuplicates: false })
    .select('id')
    .single();

  if (error || !data) {
    console.error(
      `  ERROR upserting donor entity "${name}": ${error?.message}`,
    );
    return null;
  }

  const id = (data as { id: string }).id;
  entityCache.set(cacheKey, id);
  return id;
}

/**
 * Look up the recipient committee entity by fec_committee_id.
 * Returns null if the committee was not imported by import-fec-committees.ts.
 */
async function resolveRecipientEntity(
  committeeId: string,
): Promise<string | null> {
  const cacheKey = `committee::${committeeId}`;

  if (entityCache.has(cacheKey)) {
    return entityCache.get(cacheKey)!;
  }

  const { data, error } = await supabase
    .from('entities')
    .select('id')
    .filter('external_ids->>fec_committee_id', 'eq', committeeId)
    .maybeSingle();

  if (error) {
    console.error(
      `  ERROR looking up committee entity "${committeeId}": ${error.message}`,
    );
    return null;
  }

  if (!data) {
    // Committee not yet imported; we cannot link this contribution.
    return null;
  }

  const id = (data as { id: string }).id;
  entityCache.set(cacheKey, id);
  return id;
}

// ---------------------------------------------------------------------------
// Batch upsert helpers
// ---------------------------------------------------------------------------

async function flushContributions(
  batch: ContributionInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('contributions')
    .upsert(batch, { onConflict: 'fec_filing_id,donor_entity_id,recipient_entity_id' });

  if (error) {
    console.error(
      `  BATCH contributions UPSERT ERROR (${batch.length} records): ${error.message}`,
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

async function importFecContributions(): Promise<void> {
  console.log('=== Import FEC Contributions (Schedule A) ===\n');

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

  const contributions = await fetchAllContributions(apiKey, extraParams);

  let totalContributionsOk = 0;
  let totalContributionsErr = 0;
  let totalRelationshipsOk = 0;
  let totalRelationshipsErr = 0;
  let totalSkipped = 0;

  const contributionBatch: ContributionInsert[] = [];
  const relationshipBatch: RelationshipInsert[] = [];

  /**
   * Flush accumulated batches when either reaches BATCH_SIZE.
   */
  async function maybeFlush(force = false): Promise<void> {
    if (
      force ||
      contributionBatch.length >= BATCH_SIZE ||
      relationshipBatch.length >= BATCH_SIZE
    ) {
      if (contributionBatch.length > 0) {
        const { ok, err } = await flushContributions(
          contributionBatch.splice(0, contributionBatch.length),
        );
        totalContributionsOk += ok;
        totalContributionsErr += err;
        process.stdout.write(`  contributions flushed (ok=${ok}, err=${err})\n`);
      }

      if (relationshipBatch.length > 0) {
        const { ok, err } = await flushRelationships(
          relationshipBatch.splice(0, relationshipBatch.length),
        );
        totalRelationshipsOk += ok;
        totalRelationshipsErr += err;
        process.stdout.write(`  relationships flushed (ok=${ok}, err=${err})\n`);
      }
    }
  }

  for (const contribution of contributions) {
    // Skip records without an amount — they cannot be stored meaningfully.
    if (
      contribution.contribution_receipt_amount === null ||
      contribution.contribution_receipt_amount === undefined
    ) {
      totalSkipped++;
      continue;
    }

    // 1. Resolve donor entity.
    const donorEntityId = await resolveDonorEntity(contribution);
    if (!donorEntityId) {
      totalSkipped++;
      continue;
    }

    // 2. Resolve recipient committee entity.
    const recipientEntityId = await resolveRecipientEntity(contribution.committee_id);
    if (!recipientEntityId) {
      // Committee not yet imported; skip.
      totalSkipped++;
      continue;
    }

    // 3. Build contribution row.
    const contributionRow: ContributionInsert = {
      donor_entity_id: donorEntityId,
      recipient_entity_id: recipientEntityId,
      amount: contribution.contribution_receipt_amount,
      contribution_date: contribution.contribution_receipt_date,
      fec_filing_id: contribution.filing_id !== null
        ? String(contribution.filing_id)
        : null,
      contribution_type: contribution.entity_type,
      employer: contribution.contributor_employer,
      occupation: contribution.contributor_occupation,
      metadata: {
        transaction_id: contribution.transaction_id,
        memo_text: contribution.memo_text,
        aggregate_ytd: contribution.contributor_aggregate_ytd,
        load_date: contribution.load_date,
      },
    };

    contributionBatch.push(contributionRow);

    // 4. Build relationship row.
    const relationshipRow: RelationshipInsert = {
      source_entity_id: donorEntityId,
      target_entity_id: recipientEntityId,
      relationship_type: 'donated_to',
      amount: contribution.contribution_receipt_amount,
      date_start: contribution.contribution_receipt_date,
      metadata: {
        fec_transaction_id: contribution.transaction_id,
        fec_filing_id: contribution.filing_id,
        contribution_type: contribution.entity_type,
      },
      confidence_score: 1.0,
    };

    relationshipBatch.push(relationshipRow);

    await maybeFlush();
  }

  // Flush any remaining records.
  await maybeFlush(true);

  console.log('\n=== Completed. ===');
  console.log(`  Contributions inserted/updated: ${totalContributionsOk}, errors: ${totalContributionsErr}`);
  console.log(`  Relationships inserted/updated: ${totalRelationshipsOk}, errors: ${totalRelationshipsErr}`);
  console.log(`  Skipped (missing amount or unresolved entities): ${totalSkipped}`);
}

importFecContributions().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
