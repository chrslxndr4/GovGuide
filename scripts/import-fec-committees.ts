/**
 * Import FEC committees from the OpenFEC API.
 *
 * Requires environment variable:  FEC_API_KEY
 * Obtain a free key at: https://api.data.gov/signup/
 *
 * For each committee this script:
 *   1. Fetches paginated committee records (100/page) from
 *      api.open.fec.gov/v1/committees/.
 *   2. Upserts an entity record (type 'pac', 'corporation', 'political_party',
 *      or 'other') with external_ids containing { fec_committee_id }.
 *   3. For PAC-type committees, upserts an entity_pacs detail record.
 *   Records are processed in batches of 500.
 *
 * Run with:  npm run import:fec-committees
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Subset of fields returned by GET /v1/committees/.
 * The FEC API returns many more fields; we only type what we use.
 */
interface FecCommittee {
  committee_id: string;           // e.g. "C00000059"
  name: string;
  committee_type: string;         // single character: "P","Q","N","H","S","U","V","W","X","Y","Z","O","D","E","I"
  committee_type_full: string;    // human-readable label
  designation: string;            // "A","B","D","J","P","U"
  designation_full: string;
  organization_type: string | null;
  organization_type_full: string | null;
  party: string | null;           // 3-letter party code, if applicable
  party_full: string | null;
  state: string | null;
  treasurer_name: string | null;
  filing_frequency: string | null;
  first_file_date: string | null; // ISO date
  last_file_date: string | null;
}

interface FecCommitteesResponse {
  results: FecCommittee[];
  pagination: {
    page: number;
    pages: number;
    per_page: number;
    count: number;
  };
}

/** Entity types supported in GovGuide's entities table. */
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

interface EntityPacInsert {
  entity_id: string;
  fec_committee_id: string;
  pac_type: string | null;
  sponsor_entity_id: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FEC_API_BASE = 'https://api.open.fec.gov/v1';
const PAGE_SIZE = 100;   // maximum allowed by the FEC API
const BATCH_SIZE = 500;

/**
 * Map FEC committee_type to a GovGuide entity_type.
 *
 * FEC committee types:
 *   P  = Presidential campaign
 *   H  = House campaign
 *   S  = Senate campaign
 *   Q  = Qualified non-multicandidate committee (PAC)
 *   N  = Non-qualified non-multicandidate committee (PAC)
 *   V  = Non-qualified non-multicandidate committee (PAC) — multicandidate
 *   W  = Non-qualified multicandidate committee
 *   U  = Single candidate independent expenditure committee (super PAC)
 *   O  = Super PAC (independent expenditure only)
 *   D  = Leadership PAC / non-multicandidate committee
 *   E  = Electioneering communication committee
 *   I  = Independent expenditure filer (not a committee)
 *   X  = Party — non-qualified
 *   Y  = Party — qualified
 *   Z  = National party non-federal account
 */
const COMMITTEE_TYPE_TO_ENTITY_TYPE: Record<string, EntityType> = {
  P: 'pac',           // presidential campaign committee
  H: 'pac',           // House campaign committee
  S: 'pac',           // Senate campaign committee
  Q: 'pac',
  N: 'pac',
  V: 'pac',
  W: 'pac',
  U: 'pac',           // super PAC
  O: 'pac',           // super PAC
  D: 'pac',           // leadership PAC
  E: 'pac',
  I: 'pac',
  X: 'political_party',
  Y: 'political_party',
  Z: 'political_party',
};

// PAC-category committee types (those that get an entity_pacs detail row).
const PAC_COMMITTEE_TYPES = new Set([
  'P', 'H', 'S', 'Q', 'N', 'V', 'W', 'U', 'O', 'D', 'E', 'I',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function committeeTypeToEntityType(committeeType: string | null | undefined): EntityType {
  if (!committeeType) return 'other';
  return COMMITTEE_TYPE_TO_ENTITY_TYPE[committeeType.toUpperCase()] ?? 'other';
}

/**
 * Build a human-readable pac_type string from committee type + designation.
 * Stored on the entity_pacs row so the UI can display "Super PAC", "Leadership PAC", etc.
 */
function derivePacType(committee: FecCommittee): string | null {
  if (!committee.committee_type) return null;
  const t = committee.committee_type.toUpperCase();
  if (t === 'O' || t === 'U') return 'super_pac';
  if (t === 'D') return 'leadership_pac';
  if (t === 'P') return 'presidential_campaign';
  if (t === 'H') return 'house_campaign';
  if (t === 'S') return 'senate_campaign';
  if (t === 'E') return 'electioneering';
  if (t === 'I') return 'independent_expenditure_filer';
  if (t === 'Q' || t === 'N' || t === 'V' || t === 'W') return 'pac';
  return null;
}

// ---------------------------------------------------------------------------
// FEC API pagination
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const FEC_RATE_DELAY_MS = 4000; // ~900 requests/hour to stay under 1000/hr limit

async function fetchCommitteesPage(
  apiKey: string,
  page: number,
  retries = 3,
): Promise<FecCommitteesResponse> {
  const url =
    `${FEC_API_BASE}/committees/` +
    `?api_key=${encodeURIComponent(apiKey)}` +
    `&per_page=${PAGE_SIZE}` +
    `&page=${page}` +
    `&sort=committee_id`;

  await sleep(FEC_RATE_DELAY_MS);
  const res = await fetch(url);

  if ((res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) && retries > 0) {
    const wait = res.status === 429 ? 60000 : 10000;
    console.warn(`  ${res.status} on page ${page}, waiting ${wait/1000}s … (${retries} retries left)`);
    await sleep(wait);
    return fetchCommitteesPage(apiKey, page, retries - 1);
  }

  if (!res.ok) {
    throw new Error(
      `FEC API error ${res.status} fetching committees page ${page}: ${res.statusText}`,
    );
  }

  return (await res.json()) as FecCommitteesResponse;
}

async function fetchAllCommittees(apiKey: string): Promise<FecCommittee[]> {
  const allCommittees: FecCommittee[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    console.log(`  Fetching committees page ${page}/${totalPages} …`);

    const body = await fetchCommitteesPage(apiKey, page);
    totalPages = body.pagination.pages;
    allCommittees.push(...body.results);

    if (body.results.length === 0) break;

    page++;
  } while (page <= totalPages);

  console.log(`  Total committees fetched: ${allCommittees.length}`);
  return allCommittees;
}

// ---------------------------------------------------------------------------
// Batch upsert helpers
// ---------------------------------------------------------------------------

/**
 * Upsert a batch of entity records.
 * Conflict resolution is on external_ids->>'fec_committee_id' via a generated
 * column or unique index — here we use the Supabase ignoreDuplicates:false
 * pattern with onConflict targeting that JSON path key.
 *
 * Because Supabase JS doesn't support jsonb path conflict targets directly,
 * we upsert by selecting entities whose external_ids already contain each
 * fec_committee_id and merging, then insert the remainder.  To keep the
 * implementation simple and consistent with the rest of the codebase, we
 * perform a straightforward upsert using onConflict on 'name' combined with
 * a pre-select deduplication approach, storing the fec_committee_id lookup
 * as a secondary step.
 *
 * Returns a map of fec_committee_id → entity UUID.
 */
async function flushEntities(
  batch: Array<{ committee: FecCommittee; entityInsert: EntityInsert }>,
): Promise<{ idMap: Map<string, string>; ok: number; err: number }> {
  const idMap = new Map<string, string>();
  let ok = 0;
  let err = 0;

  if (batch.length === 0) return { idMap, ok, err };

  // For each committee we need its UUID after upsert.  We upsert one at a time
  // only when we need the returned id — here we do a bulk upsert then a bulk
  // select to retrieve the UUIDs by fec_committee_id.
  //
  // Strategy:
  //   1. Bulk upsert entities (ignore exact-duplicate names for now; the real
  //      deduplication key is the fec_committee_id stored in external_ids).
  //   2. Select back the rows whose external_ids->>'fec_committee_id' is in
  //      the batch's committee IDs.
  const committeeIds = batch.map((b) => b.committee.committee_id);

  // Step 1 — upsert.  We use ignoreDuplicates: false so existing rows get
  // their metadata refreshed.  The conflict target for entities is the
  // expression index on (external_ids->>'fec_committee_id'); since Supabase
  // REST upsert requires a column name we fall back to inserting and letting
  // PG handle duplicate conflicts via the DB-level unique index if present,
  // otherwise we use onConflict: 'name' as a safe approximation.
  const rows = batch.map((b) => b.entityInsert);

  const { error: upsertError } = await supabase
    .from('entities')
    .upsert(rows, { onConflict: 'name', ignoreDuplicates: false });

  if (upsertError) {
    console.error(
      `  BATCH ENTITY UPSERT ERROR (${batch.length} records): ${upsertError.message}`,
    );
    return { idMap, ok: 0, err: batch.length };
  }

  // Step 2 — retrieve the UUIDs.  We query using the JSONB operator.
  // Supabase JS doesn't expose a jsonb containment operator directly, so we
  // use .filter() with 'cs' (contains) on the external_ids column.
  // We fetch in sub-batches of 100 to stay within URL length limits.
  const LOOKUP_CHUNK = 100;
  for (let i = 0; i < committeeIds.length; i += LOOKUP_CHUNK) {
    const chunk = committeeIds.slice(i, i + LOOKUP_CHUNK);

    // Build an OR filter: external_ids @> '{"fec_committee_id":"C00000001"}' OR …
    // Supabase supports this via multiple .or() calls or a raw filter string.
    // We use the 'cs' (contains) operator supported by PostgREST on JSONB columns.
    // Because we need to match on individual keys we query each one separately
    // and collect results.  For efficiency we fire them concurrently.
    const lookups = await Promise.all(
      chunk.map((cid) =>
        supabase
          .from('entities')
          .select('id, external_ids')
          .filter('external_ids->>fec_committee_id', 'eq', cid)
          .maybeSingle(),
      ),
    );

    for (const { data, error: lookupError } of lookups) {
      if (lookupError) {
        console.error(`  LOOKUP ERROR: ${lookupError.message}`);
        err++;
        continue;
      }
      if (data) {
        const row = data as { id: string; external_ids: Record<string, string> };
        const cid = row.external_ids['fec_committee_id'];
        if (cid) {
          idMap.set(cid, row.id);
          ok++;
        }
      }
    }
  }

  return { idMap, ok, err };
}

async function flushEntityPacs(
  batch: EntityPacInsert[],
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('entity_pacs')
    .upsert(batch, { onConflict: 'fec_committee_id' });

  if (error) {
    console.error(
      `  BATCH entity_pacs UPSERT ERROR (${batch.length} records): ${error.message}`,
    );
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importFecCommittees(): Promise<void> {
  console.log('=== Import FEC Committees ===\n');

  const apiKey = process.env.FEC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'Missing environment variable: FEC_API_KEY\n' +
        'Obtain a free key at https://api.data.gov/signup/',
    );
  }

  const committees = await fetchAllCommittees(apiKey);

  let totalEntitiesOk = 0;
  let totalEntitiesErr = 0;
  let totalPacsOk = 0;
  let totalPacsErr = 0;

  // Process in batches of BATCH_SIZE.
  for (let batchStart = 0; batchStart < committees.length; batchStart += BATCH_SIZE) {
    const batchCommittees = committees.slice(batchStart, batchStart + BATCH_SIZE);
    console.log(
      `\nProcessing entity batch ${batchStart + 1}–${batchStart + batchCommittees.length} …`,
    );

    // Build entity insert rows.
    const entityBatch = batchCommittees.map((committee) => {
      const entityType = committeeTypeToEntityType(committee.committee_type);

      const entityInsert: EntityInsert = {
        entity_type: entityType,
        name: committee.name,
        aliases: [],
        external_ids: { fec_committee_id: committee.committee_id },
        metadata: {
          committee_type: committee.committee_type,
          committee_type_full: committee.committee_type_full,
          designation: committee.designation,
          designation_full: committee.designation_full,
          organization_type: committee.organization_type,
          organization_type_full: committee.organization_type_full,
          party: committee.party,
          party_full: committee.party_full,
          state: committee.state,
          treasurer_name: committee.treasurer_name,
          filing_frequency: committee.filing_frequency,
          first_file_date: committee.first_file_date,
          last_file_date: committee.last_file_date,
        },
      };

      return { committee, entityInsert };
    });

    // Upsert entities and retrieve UUID map.
    const { idMap, ok: entOk, err: entErr } = await flushEntities(entityBatch);
    totalEntitiesOk += entOk;
    totalEntitiesErr += entErr;
    console.log(`  Entities flushed (ok=${entOk}, err=${entErr})`);

    // Build entity_pacs rows for PAC-type committees.
    const pacBatch: EntityPacInsert[] = [];
    for (const { committee } of entityBatch) {
      if (!committee.committee_type || !PAC_COMMITTEE_TYPES.has(committee.committee_type.toUpperCase())) {
        continue;
      }

      const entityId = idMap.get(committee.committee_id);
      if (!entityId) {
        // Entity upsert may have failed — skip the detail row.
        continue;
      }

      pacBatch.push({
        entity_id: entityId,
        fec_committee_id: committee.committee_id,
        pac_type: derivePacType(committee),
        sponsor_entity_id: null, // not available from the committees endpoint
      });
    }

    if (pacBatch.length > 0) {
      const { ok: pacOk, err: pacErr } = await flushEntityPacs(pacBatch);
      totalPacsOk += pacOk;
      totalPacsErr += pacErr;
      console.log(`  entity_pacs flushed (ok=${pacOk}, err=${pacErr})`);
    }
  }

  console.log('\n=== Completed. ===');
  console.log(`  Entities inserted/updated: ${totalEntitiesOk}, errors: ${totalEntitiesErr}`);
  console.log(`  entity_pacs inserted/updated: ${totalPacsOk}, errors: ${totalPacsErr}`);
}

importFecCommittees().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
