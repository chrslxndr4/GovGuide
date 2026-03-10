/**
 * Import relationship data from LittleSis.org API — power network mapping
 * with 400K+ entities and 1.5M+ relationships.
 *
 * API docs: https://littlesis.org/api
 *
 * Strategy:
 *   1. For each current official without a littlesis_id:
 *      a. Search LittleSis by name, filter to Person type
 *      b. Store matched littlesis_id on the official
 *      c. Ensure an entity record exists for this official
 *      d. Fetch all relationships for the matched entity
 *      e. Create entity + relationship records for each connection
 *
 * Rate limiting: 2-second delay between API requests (public API, no key).
 *
 * Run with:  npm run import:littlesis
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types — LittleSis JSON API response shapes
// ---------------------------------------------------------------------------

interface LittleSisAttributes {
  id: number;
  name: string;
  blurb: string | null;
  summary: string | null;
  primary_ext: string | null; // 'Person' | 'Org'
  start_date: string | null;
  end_date: string | null;
  updated_at: string | null;
  types: string[];
  aliases: string[];
  website: string | null;
}

interface LittleSisEntity {
  type: string;
  id: number;
  attributes: LittleSisAttributes;
}

interface LittleSisRelationshipAttributes {
  id: number;
  entity1_id: number;
  entity2_id: number;
  category_id: number;
  description1: string | null;
  description2: string | null;
  amount: number | null;
  currency: string | null;
  start_date: string | null;
  end_date: string | null;
  is_current: boolean | null;
  updated_at: string | null;
}

interface LittleSisRelationship {
  type: string;
  id: number;
  attributes: LittleSisRelationshipAttributes;
}

interface LittleSisSearchResponse {
  meta: { currentPage: number; pageCount: number };
  data: LittleSisEntity[];
}

interface LittleSisRelationshipsResponse {
  meta?: { currentPage?: number; pageCount?: number };
  data: LittleSisRelationship[];
  included?: LittleSisEntity[];
}

interface LittleSisEntityResponse {
  data: LittleSisEntity;
}

// ---------------------------------------------------------------------------
// Types — DB shapes
// ---------------------------------------------------------------------------

type EntityType =
  | 'individual'
  | 'officeholder'
  | 'judge'
  | 'lobbyist'
  | 'corporation'
  | 'pac'
  | '501c4'
  | '527_org'
  | 'lobbying_firm'
  | 'trade_association'
  | 'foreign_principal'
  | 'jurisdiction'
  | 'office'
  | 'agency'
  | 'committee'
  | 'court'
  // Added via migration 020
  | 'political_party'
  | 'other'
  | 'nonprofit'
  | 'government';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LITTLESIS_API_BASE = 'https://littlesis.org/api';
/** Polite delay between API requests (2 seconds). */
const REQUEST_DELAY_MS = 2000;
/** Max officials to process (0 = unlimited). Set via --limit=N CLI arg. */
let MAX_OFFICIALS = 0;
/** Max relationships per official (0 = unlimited). Set via --max-rels=N CLI arg. */
let MAX_RELS_PER_OFFICIAL = 0;
/** Dry-run mode: search + match but skip DB writes. */
let DRY_RUN = false;

// ---------------------------------------------------------------------------
// LittleSis category_id → our relationship_type
// ---------------------------------------------------------------------------

const CATEGORY_MAP: Record<number, string> = {
  1: 'employed_by',     // Position
  2: 'educated_at',     // Education
  3: 'member_of',       // Membership
  4: 'family_of',       // Family
  5: 'donated_to',      // Donation
  6: 'contributed_to',  // Transaction
  7: 'lobbied_on',      // Lobbying
  8: 'member_of',       // Social
  9: 'employed_by',     // Professional
  10: 'owns',           // Ownership
  11: 'employed_by',    // Hierarchy
  12: 'member_of',      // Generic
};

// ---------------------------------------------------------------------------
// LittleSis extension type → our entity_type
// ---------------------------------------------------------------------------

function mapEntityType(entity: LittleSisAttributes): EntityType {
  if (entity.primary_ext === 'Person') return 'individual';

  const types = entity.types ?? [];
  if (types.includes('GovernmentBody')) return 'government';
  if (types.includes('LobbyingFirm')) return 'lobbying_firm';
  if (types.includes('NonProfit')) return 'nonprofit';
  if (types.includes('Business') || types.includes('PublicCompany')) return 'corporation';
  if (types.includes('PoliticalFundraising')) return 'pac';
  if (types.includes('LaborUnion')) return 'trade_association'; // closest match
  if (types.includes('TradeAssociation')) return 'trade_association';

  return 'other';
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse CLI args for --limit=N and --dry-run. */
function parseCLIArgs(): void {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--limit=')) {
      MAX_OFFICIALS = parseInt(arg.split('=')[1], 10);
    }
    if (arg.startsWith('--max-rels=')) {
      MAX_RELS_PER_OFFICIAL = parseInt(arg.split('=')[1], 10);
    }
    if (arg === '--dry-run') {
      DRY_RUN = true;
    }
  }
}

// ---------------------------------------------------------------------------
// LittleSis API fetch helpers
// ---------------------------------------------------------------------------

async function fetchLittleSis<T>(path: string): Promise<T | null> {
  const url = `${LITTLESIS_API_BASE}${path}`;

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'GovGuide/1.0 (civic transparency project)',
      },
    });

    if (!res.ok) {
      if (res.status === 429) {
        console.warn(`  Rate limited at ${url}, waiting 10s...`);
        await sleep(10000);
        return fetchLittleSis<T>(path); // retry once
      }
      console.error(`  LittleSis API error ${res.status} at ${url}`);
      return null;
    }

    return (await res.json()) as T;
  } catch (err) {
    console.error(`  Network error fetching ${url}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Search LittleSis for an entity by name. Returns the best Person match, or
 * null if no good match exists.
 */
async function searchPerson(name: string): Promise<LittleSisEntity | null> {
  const encoded = encodeURIComponent(name);
  const response = await fetchLittleSis<LittleSisSearchResponse>(
    `/entities/search?q=${encoded}`,
  );

  if (!response || !response.data || response.data.length === 0) {
    return null;
  }

  // Filter to Person entities only.
  const people = response.data.filter(
    (e) => e.attributes.primary_ext === 'Person',
  );

  if (people.length === 0) return null;

  // Try exact name match first (case-insensitive).
  const nameLower = name.toLowerCase();
  const exactMatch = people.find(
    (e) => e.attributes.name.toLowerCase() === nameLower,
  );

  if (exactMatch) return exactMatch;

  // Accept first result if name is close enough (all words present).
  const nameWords = nameLower.split(/\s+/).filter((w) => w.length > 1);
  const closeMatch = people.find((e) => {
    const candidateLower = e.attributes.name.toLowerCase();
    return nameWords.every((word) => candidateLower.includes(word));
  });

  return closeMatch ?? null;
}

/**
 * Fetch all relationships for a LittleSis entity.
 */
async function fetchRelationships(
  littlesisId: number,
): Promise<LittleSisRelationshipsResponse | null> {
  // The API paginates relationships; fetch page 1 first.
  let allData: LittleSisRelationship[] = [];
  let allIncluded: LittleSisEntity[] = [];
  let page = 1;

  while (true) {
    const response = await fetchLittleSis<LittleSisRelationshipsResponse>(
      `/entities/${littlesisId}/relationships?page=${page}`,
    );

    if (!response || !response.data) break;

    allData = allData.concat(response.data);
    if (response.included) {
      allIncluded = allIncluded.concat(response.included);
    }

    // Check if there are more pages.
    const pageCount = response.meta?.pageCount ?? 1;
    if (page >= pageCount) break;

    page++;
    await sleep(REQUEST_DELAY_MS);
  }

  return { data: allData, included: allIncluded };
}

/**
 * Fetch a single entity's details from LittleSis.
 */
async function fetchEntity(
  littlesisId: number,
): Promise<LittleSisEntity | null> {
  const response = await fetchLittleSis<LittleSisEntityResponse>(
    `/entities/${littlesisId}`,
  );
  return response?.data ?? null;
}

// ---------------------------------------------------------------------------
// In-process caches (littlesis_id → entity UUID in our DB)
// ---------------------------------------------------------------------------

/** Maps LittleSis entity ID → our entities table UUID. */
const entityCache = new Map<number, string>();

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

/**
 * Find or create an entity in our DB for a LittleSis entity.
 * Returns the entity UUID.
 */
async function findOrCreateEntity(
  lsEntity: LittleSisAttributes,
  lsId: number,
): Promise<string | null> {
  // Check cache first.
  if (entityCache.has(lsId)) {
    return entityCache.get(lsId)!;
  }

  // Check if entity already exists by littlesis_id.
  const { data: existing } = await supabase
    .from('entities')
    .select('id')
    .eq('littlesis_id', String(lsId))
    .maybeSingle();

  if (existing) {
    const uuid = (existing as { id: string }).id;
    entityCache.set(lsId, uuid);
    return uuid;
  }

  if (DRY_RUN) {
    return null;
  }

  // Create new entity.
  const entityType = mapEntityType(lsEntity);

  const { data: created, error } = await supabase
    .from('entities')
    .insert({
      entity_type: entityType,
      name: lsEntity.name,
      aliases: lsEntity.aliases ?? [],
      littlesis_id: String(lsId),
      external_ids: {
        littlesis_id: lsId,
        littlesis_url: `https://littlesis.org/entities/${lsId}`,
      },
      metadata: {
        blurb: lsEntity.blurb,
        summary: lsEntity.summary,
        types: lsEntity.types,
        website: lsEntity.website,
        littlesis_updated_at: lsEntity.updated_at,
      },
    })
    .select('id')
    .single();

  if (error || !created) {
    console.error(`  ERROR inserting entity "${lsEntity.name}": ${error?.message}`);
    return null;
  }

  const uuid = (created as { id: string }).id;
  entityCache.set(lsId, uuid);
  return uuid;
}

/**
 * Find an entity for an official. The official may already have an entity
 * record via their officials table id, or we need to create one.
 */
async function findOrCreateOfficialEntity(
  officialId: string,
  officialName: string,
  littlesisId: number,
): Promise<string | null> {
  // Check if there's already an entity linked to this official's littlesis_id.
  if (entityCache.has(littlesisId)) {
    return entityCache.get(littlesisId)!;
  }

  const { data: existing } = await supabase
    .from('entities')
    .select('id')
    .eq('littlesis_id', String(littlesisId))
    .maybeSingle();

  if (existing) {
    const uuid = (existing as { id: string }).id;
    entityCache.set(littlesisId, uuid);
    return uuid;
  }

  if (DRY_RUN) {
    return null;
  }

  // Create entity for this official.
  const { data: created, error } = await supabase
    .from('entities')
    .insert({
      entity_type: 'officeholder' as EntityType,
      name: officialName,
      aliases: [],
      littlesis_id: String(littlesisId),
      external_ids: {
        littlesis_id: littlesisId,
        littlesis_url: `https://littlesis.org/entities/${littlesisId}`,
        official_id: officialId,
      },
      metadata: {
        source: 'littlesis_official_match',
      },
    })
    .select('id')
    .single();

  if (error || !created) {
    console.error(`  ERROR inserting official entity "${officialName}": ${error?.message}`);
    return null;
  }

  const uuid = (created as { id: string }).id;
  entityCache.set(littlesisId, uuid);
  return uuid;
}

/**
 * Format a LittleSis date string (which may be partial like "2020-00-00")
 * into a valid date or null.
 */
function parseLittleSisDate(raw: string | null): string | null {
  if (!raw) return null;
  // LittleSis uses "YYYY-MM-DD" but month/day can be "00".
  const cleaned = raw.replace(/-00/g, '-01');
  // Validate it's a real date.
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return null;
  return cleaned;
}

// ---------------------------------------------------------------------------
// Stats tracking
// ---------------------------------------------------------------------------

const stats = {
  officialsProcessed: 0,
  officialsMatched: 0,
  officialsSkipped: 0,
  entitiesCreated: 0,
  relationshipsCreated: 0,
  errors: 0,
};

// ---------------------------------------------------------------------------
// Main processing
// ---------------------------------------------------------------------------

async function processOfficial(official: {
  id: string;
  full_name: string;
}): Promise<void> {
  const { id: officialId, full_name: name } = official;

  console.log(`\nSearching LittleSis for "${name}"...`);
  await sleep(REQUEST_DELAY_MS);

  const match = await searchPerson(name);

  if (!match) {
    console.log(`  No match found for "${name}"`);
    stats.officialsSkipped++;
    return;
  }

  const littlesisId = match.id;
  console.log(
    `  MATCHED: "${name}" → LittleSis #${littlesisId} "${match.attributes.name}"` +
      (match.attributes.blurb ? ` (${match.attributes.blurb})` : ''),
  );
  stats.officialsMatched++;

  // Update the official record with littlesis_id.
  if (!DRY_RUN) {
    const { error: updateErr } = await supabase
      .from('officials')
      .update({ littlesis_id: String(littlesisId) })
      .eq('id', officialId);

    if (updateErr) {
      console.error(`  ERROR updating official littlesis_id: ${updateErr.message}`);
      stats.errors++;
    }
  }

  // Find or create entity for this official.
  const officialEntityId = await findOrCreateOfficialEntity(
    officialId,
    name,
    littlesisId,
  );
  if (!officialEntityId && !DRY_RUN) {
    stats.errors++;
    return;
  }

  // Fetch relationships for this entity from LittleSis.
  await sleep(REQUEST_DELAY_MS);
  const relData = await fetchRelationships(littlesisId);

  if (!relData || relData.data.length === 0) {
    console.log(`  No relationships found for LittleSis #${littlesisId}`);
    return;
  }

  // Apply max-rels limit if set.
  const relsToProcess =
    MAX_RELS_PER_OFFICIAL > 0
      ? relData.data.slice(0, MAX_RELS_PER_OFFICIAL)
      : relData.data;

  console.log(
    `  Found ${relData.data.length} relationships` +
      (MAX_RELS_PER_OFFICIAL > 0
        ? `, processing first ${relsToProcess.length}`
        : ''),
  );

  // Build a lookup map from included entities.
  const includedEntities = new Map<number, LittleSisEntity>();
  for (const ent of relData.included ?? []) {
    includedEntities.set(ent.id, ent);
  }

  // Process each relationship.
  const relationshipBatch: Array<{
    source_entity_id: string;
    target_entity_id: string;
    relationship_type: string;
    amount: number | null;
    date_start: string | null;
    date_end: string | null;
    metadata: Record<string, unknown>;
    confidence_score: number;
  }> = [];

  for (const rel of relsToProcess) {
    const attrs = rel.attributes;
    const categoryId = attrs.category_id;
    const relType = CATEGORY_MAP[categoryId] ?? 'member_of';

    // Determine which end is the "other" entity (not our official).
    const otherId =
      attrs.entity1_id === littlesisId ? attrs.entity2_id : attrs.entity1_id;

    // Look up the other entity — first from included, then fetch if needed.
    let otherEntity = includedEntities.get(otherId);
    if (!otherEntity) {
      await sleep(REQUEST_DELAY_MS);
      otherEntity = (await fetchEntity(otherId)) ?? undefined;
    }

    if (!otherEntity) {
      console.log(`  Skipping relationship — could not resolve entity #${otherId}`);
      stats.errors++;
      continue;
    }

    // Find or create entity in our DB for the other side.
    const otherEntityId = await findOrCreateEntity(
      otherEntity.attributes,
      otherId,
    );
    if (!otherEntityId) {
      if (!DRY_RUN) stats.errors++;
      continue;
    }

    if (DRY_RUN) {
      console.log(
        `  [DRY RUN] Would create: ${name} --[${relType}]--> ${otherEntity.attributes.name}`,
      );
      continue;
    }

    // Determine direction. entity1 is usually the "source" in LittleSis.
    const sourceId =
      attrs.entity1_id === littlesisId ? officialEntityId! : otherEntityId;
    const targetId =
      attrs.entity1_id === littlesisId ? otherEntityId : officialEntityId!;

    relationshipBatch.push({
      source_entity_id: sourceId,
      target_entity_id: targetId,
      relationship_type: relType,
      amount: attrs.amount ?? null,
      date_start: parseLittleSisDate(attrs.start_date),
      date_end: parseLittleSisDate(attrs.end_date),
      source: 'littlesis',
      metadata: {
        littlesis_relationship_id: attrs.id,
        category_id: categoryId,
        description1: attrs.description1,
        description2: attrs.description2,
        currency: attrs.currency,
        is_current: attrs.is_current,
      },
      confidence_score: 0.9,
    });
  }

  // Insert relationships (skip duplicates by checking littlesis_relationship_id).
  if (relationshipBatch.length > 0 && !DRY_RUN) {
    // First, collect all littlesis_relationship_ids to check for existing rows.
    const lsRelIds = relationshipBatch.map(
      (r) => (r.metadata as Record<string, unknown>).littlesis_relationship_id as number,
    );

    // Check which ones already exist.
    const { data: existingRels } = await supabase
      .from('relationships')
      .select('metadata->littlesis_relationship_id')
      .in('metadata->>littlesis_relationship_id', lsRelIds.map(String));

    const existingIds = new Set(
      (existingRels ?? []).map(
        (r: Record<string, unknown>) => String(r.littlesis_relationship_id),
      ),
    );

    const newRels = relationshipBatch.filter(
      (r) =>
        !existingIds.has(
          String((r.metadata as Record<string, unknown>).littlesis_relationship_id),
        ),
    );

    if (newRels.length > 0) {
      const CHUNK_SIZE = 100;
      for (let i = 0; i < newRels.length; i += CHUNK_SIZE) {
        const chunk = newRels.slice(i, i + CHUNK_SIZE);
        const { error } = await supabase.from('relationships').insert(chunk);

        if (error) {
          console.error(
            `  ERROR inserting relationships batch: ${error.message}`,
          );
          stats.errors++;
        } else {
          stats.relationshipsCreated += chunk.length;
          console.log(`  Inserted ${chunk.length} relationships`);
        }
      }
    } else {
      console.log(`  All ${relationshipBatch.length} relationships already exist, skipping`);
    }
  }
}

async function importLittleSis(): Promise<void> {
  parseCLIArgs();

  console.log('=== Import LittleSis Relationship Data ===\n');
  if (DRY_RUN) {
    console.log('*** DRY RUN MODE — no DB writes ***\n');
  }
  if (MAX_OFFICIALS > 0) {
    console.log(`Processing up to ${MAX_OFFICIALS} officials.\n`);
  }

  // Probe the API.
  console.log('Probing LittleSis API...');
  const probe = await fetchLittleSis<LittleSisSearchResponse>(
    '/entities/search?q=test',
  );
  if (!probe) {
    throw new Error('LittleSis API is unreachable. Aborting.');
  }
  console.log('  API probe OK\n');

  // Fetch current officials without a littlesis_id.
  console.log('Fetching current officials without LittleSis ID...');
  const { data: officials, error: fetchErr } = await supabase
    .from('officials')
    .select('id, full_name')
    .eq('is_current', true)
    .is('littlesis_id', null)
    .order('full_name');

  if (fetchErr) {
    throw new Error(`Failed to fetch officials: ${fetchErr.message}`);
  }

  if (!officials || officials.length === 0) {
    console.log('No officials to process. All current officials already have a LittleSis ID.');
    return;
  }

  const toProcess = MAX_OFFICIALS > 0
    ? officials.slice(0, MAX_OFFICIALS)
    : officials;

  console.log(
    `Found ${officials.length} officials without LittleSis ID. Processing ${toProcess.length}.\n`,
  );

  // Process each official.
  for (const official of toProcess) {
    stats.officialsProcessed++;
    try {
      await processOfficial(official);
    } catch (err) {
      console.error(
        `  UNEXPECTED ERROR processing "${official.full_name}": ${(err as Error).message}`,
      );
      stats.errors++;
    }
  }

  // Summary.
  console.log('\n=== Import Complete ===');
  console.log(`Officials processed: ${stats.officialsProcessed}`);
  console.log(`Officials matched:   ${stats.officialsMatched}`);
  console.log(`Officials skipped:   ${stats.officialsSkipped}`);
  console.log(`Relationships created: ${stats.relationshipsCreated}`);
  console.log(`Errors:              ${stats.errors}`);
}

importLittleSis().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
