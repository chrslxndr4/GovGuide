/**
 * Corporate Influence Scorer
 *
 * Computes a composite 0–100 influence score for each corporate entity in the
 * database and writes the result back to the `entities` table via an upsert on
 * `influence_score` and `influence_tier`.
 *
 * Score components
 * ----------------
 * Each component is normalised independently to [0, 100] and then combined
 * with the weights below:
 *
 *   Component              Weight  Normalisation
 *   ─────────────────────  ──────  ─────────────────────────────────────────
 *   Lobbying spend          25 %   Log-scale against dataset max
 *   PAC / Super-PAC spend   20 %   Log-scale against dataset max
 *   Revolving-door count    15 %   +10 pts per person, cap 100
 *   Government contracts    15 %   Log-scale against dataset max
 *   Regulatory comments     10 %   +5 pts per comment, cap 100
 *   Dark money              15 %   Log-scale with 1.5× multiplier, cap 100
 *
 * Tier mapping
 * ────────────
 *   dominant    80 – 100
 *   major       60 –  79
 *   significant 40 –  59
 *   moderate    20 –  39
 *   minor        0 –  19
 *
 * Usage
 * -----
 *   import { calculateCorporateInfluenceScores } from './scorers/corporate-influence.js';
 *   const summary = await calculateCorporateInfluenceScores();
 *
 * Environment variables required (loaded from .env via dotenv/config):
 *   PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Supabase client
// ---------------------------------------------------------------------------

const supabase = createClient(
  process.env.SUPABASE_URL ?? process.env.PUBLIC_SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
);

function assertCredentials(): void {
  const url = process.env.SUPABASE_URL ?? process.env.PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error(
      'Missing environment variable: SUPABASE_URL (or PUBLIC_SUPABASE_URL)\n' +
        'Set it in your shell or pass --env-file=.env to tsx.',
    );
  }
  if (!key) {
    throw new Error(
      'Missing environment variable: SUPABASE_SERVICE_ROLE_KEY\n' +
        'Set it in your shell or pass --env-file=.env to tsx.',
    );
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Entity types considered "corporate" for this scorer.  All other entity
 * types (e.g. official, person, government_body) are excluded.
 */
const CORPORATE_ENTITY_TYPES = [
  'corporation',
  'pac',
  'super_pac',
  'hybrid_pac',
  '501c4',
  'lobbying_firm',
] as const;

type CorporateEntityType = (typeof CORPORATE_ENTITY_TYPES)[number];

/**
 * Relationship types whose `amount` column contributes to monetary component
 * aggregations pulled from the `relationships` table.
 */
const LOBBYING_RELATIONSHIP_TYPES = ['lobbied_via'] as const;
const PAC_RELATIONSHIP_TYPES = ['donated_to', 'contributed_to'] as const;
const DARK_MONEY_RELATIONSHIP_TYPES = ['spent_for', 'spent_against'] as const;

/** Score component weights — must sum to 1.0. */
const WEIGHTS = {
  lobbying_spend: 0.25,
  pac_contributions: 0.20,
  revolving_door: 0.15,
  government_contracts: 0.15,
  regulatory_comments: 0.10,
  dark_money: 0.15,
} as const satisfies Record<string, number>;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface InfluenceComponents {
  lobbying_spend: number;
  pac_contributions: number;
  revolving_door: number;
  government_contracts: number;
  regulatory_comments: number;
  dark_money: number;
}

export interface EntityInfluenceScore {
  entity_id: string;
  entity_name: string;
  /** Composite score in the range [0, 100]. */
  score: number;
  /** Categorical tier derived from the composite score. */
  tier: 'dominant' | 'major' | 'significant' | 'moderate' | 'minor';
  /** Normalised per-component scores (each in [0, 100]). */
  components: InfluenceComponents;
}

export interface ScorerSummary {
  entities_evaluated: number;
  entities_upserted: number;
  errors: string[];
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Internal raw data shapes
// ---------------------------------------------------------------------------

interface EntityRow {
  id: string;
  name: string;
  entity_type: string;
}

interface RelationshipAmountRow {
  source_entity_id: string;
  amount: number | null;
}

interface RevolvingDoorRow {
  entity_id: string;
  count: number;
}

interface ContractRow {
  recipient_entity_id: string;
  total_value: number | null;
}

interface RegulatoryCommentRow {
  entity_id: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/**
 * Log-scale normalisation.
 *
 * Maps `value` into [0, 100] using a log10 curve anchored so that the dataset
 * maximum maps to 100.  Values at or below 0 return 0.
 */
function logNormalize(value: number, maxValue: number): number {
  if (value <= 0 || maxValue <= 0) return 0;
  return Math.min(100, (Math.log10(value + 1) / Math.log10(maxValue + 1)) * 100);
}

/**
 * Derive a tier label from a composite score.
 */
function scoreToTier(
  score: number,
): 'dominant' | 'major' | 'significant' | 'moderate' | 'minor' {
  if (score >= 80) return 'dominant';
  if (score >= 60) return 'major';
  if (score >= 40) return 'significant';
  if (score >= 20) return 'moderate';
  return 'minor';
}

// ---------------------------------------------------------------------------
// Data-fetching helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all entities of a corporate type.
 * Pages through results to avoid the default 1,000-row Supabase limit.
 */
async function fetchCorporateEntities(): Promise<EntityRow[]> {
  const PAGE_SIZE = 1000;
  const entities: EntityRow[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('entities')
      .select('id, name, entity_type')
      .in('entity_type', CORPORATE_ENTITY_TYPES as unknown as CorporateEntityType[])
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(`Failed to fetch entities: ${error.message}`);
    if (!data || data.length === 0) break;

    entities.push(...(data as EntityRow[]));
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return entities;
}

/**
 * Aggregate total relationship amounts by source entity for the given
 * relationship type(s).  Returns a map of entity_id → total amount.
 */
async function fetchRelationshipTotals(
  relationshipTypes: readonly string[],
): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  const PAGE_SIZE = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('relationships')
      .select('source_entity_id, amount')
      .in('relationship_type', relationshipTypes as string[])
      .not('amount', 'is', null)
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(`Failed to fetch relationships: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const row of data as RelationshipAmountRow[]) {
      if (row.amount == null || row.amount <= 0) continue;
      totals.set(
        row.source_entity_id,
        (totals.get(row.source_entity_id) ?? 0) + row.amount,
      );
    }

    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return totals;
}

/**
 * Aggregate total lobbying expenditure by entity from
 * `lobbying_registrations` + `lobbying_activities`.
 *
 * The pipeline uses both tables:
 *   - `lobbying_registrations` links an entity to a registrant/client
 *     relationship and may carry a `total_expenses` value.
 *   - `lobbying_activities` carries per-period `expenses` values.
 *
 * We attempt `lobbying_activities` first (more granular) and fall back to
 * `lobbying_registrations` if the activities table is empty or unavailable.
 * Both sources are summed together when present.
 */
async function fetchLobbyingTotals(): Promise<Map<string, number>> {
  const totals = new Map<string, number>();

  // --- lobbying_activities (preferred, per-period expenses) ---
  {
    const PAGE_SIZE = 1000;
    let offset = 0;
    let hasActivitiesData = false;

    while (true) {
      const { data, error } = await supabase
        .from('lobbying_activities')
        .select('entity_id, expenses')
        .not('expenses', 'is', null)
        .range(offset, offset + PAGE_SIZE - 1);

      // Gracefully skip if the table doesn't exist yet.
      if (error) {
        if (
          error.code === '42P01' ||
          error.message.toLowerCase().includes('does not exist')
        ) {
          break;
        }
        throw new Error(`Failed to fetch lobbying_activities: ${error.message}`);
      }

      if (!data || data.length === 0) break;
      hasActivitiesData = true;

      for (const row of data as Array<{ entity_id: string; expenses: number | null }>) {
        if (row.expenses == null || row.expenses <= 0) continue;
        totals.set(row.entity_id, (totals.get(row.entity_id) ?? 0) + row.expenses);
      }

      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    if (hasActivitiesData) {
      console.log(
        `[corporate-influence] Loaded lobbying totals from lobbying_activities (${totals.size} entities).`,
      );
    }
  }

  // --- lobbying_registrations (total_expenses fallback / supplement) ---
  {
    const PAGE_SIZE = 1000;
    let offset = 0;

    while (true) {
      const { data, error } = await supabase
        .from('lobbying_registrations')
        .select('client_entity_id, total_expenses')
        .not('total_expenses', 'is', null)
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        if (
          error.code === '42P01' ||
          error.message.toLowerCase().includes('does not exist')
        ) {
          break;
        }
        throw new Error(`Failed to fetch lobbying_registrations: ${error.message}`);
      }

      if (!data || data.length === 0) break;

      for (const row of data as Array<{
        client_entity_id: string;
        total_expenses: number | null;
      }>) {
        if (row.total_expenses == null || row.total_expenses <= 0) continue;
        totals.set(
          row.client_entity_id,
          (totals.get(row.client_entity_id) ?? 0) + row.total_expenses,
        );
      }

      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }

  // Also pull from the relationships table as a final supplement.
  const relTotals = await fetchRelationshipTotals(LOBBYING_RELATIONSHIP_TYPES);
  for (const [id, amount] of relTotals) {
    totals.set(id, (totals.get(id) ?? 0) + amount);
  }

  return totals;
}

/**
 * Count revolving-door relationships per entity from the `relationships`
 * table.  A revolving-door link is any relationship where a person who was
 * formerly a government official is now (or was recently) employed by, or
 * affiliated with, the entity (relationship_type = 'employed_by',
 * 'affiliated_with', 'revolving_door').
 *
 * Returns a map of entity_id → count of such individuals.
 */
async function fetchRevolvingDoorCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const REVOLVING_DOOR_TYPES = ['employed_by', 'affiliated_with', 'revolving_door'];
  const PAGE_SIZE = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('relationships')
      .select('target_entity_id, source_entity_id')
      .in('relationship_type', REVOLVING_DOOR_TYPES)
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      // Table or relationship type may not yet be populated — skip gracefully.
      if (
        error.code === '42P01' ||
        error.message.toLowerCase().includes('does not exist')
      ) {
        break;
      }
      throw new Error(`Failed to fetch revolving door relationships: ${error.message}`);
    }

    if (!data || data.length === 0) break;

    for (const row of data as Array<{
      target_entity_id: string;
      source_entity_id: string;
    }>) {
      // The corporate entity is the *target* of "person employed_by corp".
      counts.set(row.target_entity_id, (counts.get(row.target_entity_id) ?? 0) + 1);
    }

    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return counts;
}

/**
 * Aggregate total government contract value by recipient entity from the
 * `government_contracts` table.
 */
async function fetchContractTotals(): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  const PAGE_SIZE = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('government_contracts')
      .select('recipient_entity_id, total_value')
      .not('total_value', 'is', null)
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      if (
        error.code === '42P01' ||
        error.message.toLowerCase().includes('does not exist')
      ) {
        break;
      }
      throw new Error(`Failed to fetch government_contracts: ${error.message}`);
    }

    if (!data || data.length === 0) break;

    for (const row of data as ContractRow[]) {
      if (row.total_value == null || row.total_value <= 0) continue;
      totals.set(
        row.recipient_entity_id,
        (totals.get(row.recipient_entity_id) ?? 0) + row.total_value,
      );
    }

    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return totals;
}

/**
 * Count regulatory comment submissions per entity.
 * Looks for relationships of type 'submitted_comment' or equivalent, and also
 * checks a dedicated `regulatory_comments` table if present.
 */
async function fetchRegulatoryCommentCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();

  // --- Dedicated regulatory_comments table ---
  {
    const PAGE_SIZE = 1000;
    let offset = 0;

    while (true) {
      const { data, error } = await supabase
        .from('regulatory_comments')
        .select('entity_id')
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        if (
          error.code === '42P01' ||
          error.message.toLowerCase().includes('does not exist')
        ) {
          break;
        }
        throw new Error(`Failed to fetch regulatory_comments: ${error.message}`);
      }

      if (!data || data.length === 0) break;

      for (const row of data as Array<{ entity_id: string }>) {
        counts.set(row.entity_id, (counts.get(row.entity_id) ?? 0) + 1);
      }

      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }

  // --- Supplement from relationships table ---
  {
    const PAGE_SIZE = 1000;
    let offset = 0;

    while (true) {
      const { data, error } = await supabase
        .from('relationships')
        .select('source_entity_id')
        .in('relationship_type', ['submitted_comment', 'filed_comment', 'commented_on'])
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        if (
          error.code === '42P01' ||
          error.message.toLowerCase().includes('does not exist')
        ) {
          break;
        }
        throw new Error(`Failed to fetch regulatory comment relationships: ${error.message}`);
      }

      if (!data || data.length === 0) break;

      for (const row of data as Array<{ source_entity_id: string }>) {
        counts.set(row.source_entity_id, (counts.get(row.source_entity_id) ?? 0) + 1);
      }

      if (data.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// Dataset-max helpers
// ---------------------------------------------------------------------------

function maxOfMap(map: Map<string, number>): number {
  let max = 0;
  for (const v of map.values()) {
    if (v > max) max = v;
  }
  return max;
}

// ---------------------------------------------------------------------------
// Per-entity component scoring
// ---------------------------------------------------------------------------

function computeComponents(
  entityId: string,
  lobbyingTotals: Map<string, number>,
  pacTotals: Map<string, number>,
  revolvingDoorCounts: Map<string, number>,
  contractTotals: Map<string, number>,
  regulatoryCommentCounts: Map<string, number>,
  darkMoneyTotals: Map<string, number>,
  maxLobbying: number,
  maxPac: number,
  maxContracts: number,
  maxDarkMoney: number,
): InfluenceComponents {
  // Lobbying spend — log-scale
  const lobbying_spend = logNormalize(
    lobbyingTotals.get(entityId) ?? 0,
    maxLobbying,
  );

  // PAC contributions — log-scale
  const pac_contributions = logNormalize(
    pacTotals.get(entityId) ?? 0,
    maxPac,
  );

  // Revolving door — +10 pts per person, cap 100
  const revolving_door = Math.min(
    100,
    (revolvingDoorCounts.get(entityId) ?? 0) * 10,
  );

  // Government contracts — log-scale
  const government_contracts = logNormalize(
    contractTotals.get(entityId) ?? 0,
    maxContracts,
  );

  // Regulatory comments — +5 pts per comment, cap 100
  const regulatory_comments = Math.min(
    100,
    (regulatoryCommentCounts.get(entityId) ?? 0) * 5,
  );

  // Dark money — log-scale with 1.5× multiplier (harder to trace), cap 100
  const dark_money = Math.min(
    100,
    logNormalize(darkMoneyTotals.get(entityId) ?? 0, maxDarkMoney) * 1.5,
  );

  return {
    lobbying_spend,
    pac_contributions,
    revolving_door,
    government_contracts,
    regulatory_comments,
    dark_money,
  };
}

function computeCompositeScore(components: InfluenceComponents): number {
  const raw =
    components.lobbying_spend      * WEIGHTS.lobbying_spend +
    components.pac_contributions   * WEIGHTS.pac_contributions +
    components.revolving_door      * WEIGHTS.revolving_door +
    components.government_contracts * WEIGHTS.government_contracts +
    components.regulatory_comments  * WEIGHTS.regulatory_comments +
    components.dark_money           * WEIGHTS.dark_money;

  // Round to two decimal places and clamp to [0, 100].
  return Math.min(100, Math.max(0, Math.round(raw * 100) / 100));
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Calculate composite influence scores for all corporate entities and write
 * the results back to the `entities` table (`influence_score`,
 * `influence_tier` columns).
 *
 * The function is idempotent — re-running overwrites previous scores with
 * freshly computed values.
 *
 * @returns A summary describing how many entities were evaluated and upserted.
 */
export async function calculateCorporateInfluenceScores(): Promise<ScorerSummary> {
  const start = Date.now();

  const summary: ScorerSummary = {
    entities_evaluated: 0,
    entities_upserted: 0,
    errors: [],
    duration_ms: 0,
  };

  assertCredentials();

  console.log('[corporate-influence] Starting influence score calculation...');

  // ------------------------------------------------------------------
  // 1. Fetch all data sources in parallel.
  // ------------------------------------------------------------------

  let entities: EntityRow[];
  let lobbyingTotals: Map<string, number>;
  let pacTotals: Map<string, number>;
  let revolvingDoorCounts: Map<string, number>;
  let contractTotals: Map<string, number>;
  let regulatoryCommentCounts: Map<string, number>;
  let darkMoneyTotals: Map<string, number>;

  try {
    [
      entities,
      lobbyingTotals,
      pacTotals,
      revolvingDoorCounts,
      contractTotals,
      regulatoryCommentCounts,
      darkMoneyTotals,
    ] = await Promise.all([
      fetchCorporateEntities(),
      fetchLobbyingTotals(),
      fetchRelationshipTotals(PAC_RELATIONSHIP_TYPES),
      fetchRevolvingDoorCounts(),
      fetchContractTotals(),
      fetchRegulatoryCommentCounts(),
      fetchRelationshipTotals(DARK_MONEY_RELATIONSHIP_TYPES),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[corporate-influence] Data fetch failed: ${msg}`);
    summary.errors.push(msg);
    summary.duration_ms = Date.now() - start;
    return summary;
  }

  console.log(
    `[corporate-influence] Loaded ${entities.length} corporate entities.`,
  );

  if (entities.length === 0) {
    console.warn(
      '[corporate-influence] No corporate entities found. ' +
        'Ensure the entities table contains rows with entity_type in: ' +
        CORPORATE_ENTITY_TYPES.join(', '),
    );
    summary.duration_ms = Date.now() - start;
    return summary;
  }

  // ------------------------------------------------------------------
  // 2. Compute dataset maxima for log-scale normalisation.
  // ------------------------------------------------------------------

  const maxLobbying   = maxOfMap(lobbyingTotals);
  const maxPac        = maxOfMap(pacTotals);
  const maxContracts  = maxOfMap(contractTotals);
  const maxDarkMoney  = maxOfMap(darkMoneyTotals);

  console.log('[corporate-influence] Dataset maxima:', {
    lobbying:   maxLobbying,
    pac:        maxPac,
    contracts:  maxContracts,
    dark_money: maxDarkMoney,
  });

  // ------------------------------------------------------------------
  // 3. Score each entity.
  // ------------------------------------------------------------------

  const scores: EntityInfluenceScore[] = [];

  for (const entity of entities) {
    const components = computeComponents(
      entity.id,
      lobbyingTotals,
      pacTotals,
      revolvingDoorCounts,
      contractTotals,
      regulatoryCommentCounts,
      darkMoneyTotals,
      maxLobbying,
      maxPac,
      maxContracts,
      maxDarkMoney,
    );

    const score = computeCompositeScore(components);
    const tier  = scoreToTier(score);

    scores.push({
      entity_id:   entity.id,
      entity_name: entity.name,
      score,
      tier,
      components,
    });
  }

  summary.entities_evaluated = scores.length;

  // ------------------------------------------------------------------
  // 4. Upsert scores back into the entities table.
  //    Process in batches to stay well under Supabase's request size limits.
  // ------------------------------------------------------------------

  const BATCH_SIZE = 200;

  for (let i = 0; i < scores.length; i += BATCH_SIZE) {
    const batch = scores.slice(i, i + BATCH_SIZE);

    const rows = batch.map((s) => ({
      id:               s.entity_id,
      influence_score:  s.score,
      influence_tier:   s.tier,
      // Persist per-component breakdown for downstream consumers.
      influence_components: s.components,
    }));

    const { error } = await supabase
      .from('entities')
      .upsert(rows, { onConflict: 'id' });

    if (error) {
      const msg =
        `Upsert failed for batch starting at index ${i}: ${error.message}`;
      console.error(`[corporate-influence] ${msg}`);
      summary.errors.push(msg);
      // Continue processing remaining batches rather than aborting entirely.
      continue;
    }

    summary.entities_upserted += batch.length;

    console.log(
      `[corporate-influence] Upserted batch ${Math.floor(i / BATCH_SIZE) + 1} ` +
        `(${batch.length} entities, cumulative: ${summary.entities_upserted}).`,
    );
  }

  summary.duration_ms = Date.now() - start;

  console.log('[corporate-influence] Scoring complete.', {
    evaluated: summary.entities_evaluated,
    upserted:  summary.entities_upserted,
    errors:    summary.errors.length,
    duration:  `${summary.duration_ms}ms`,
  });

  // Log the top-10 most influential entities for visibility.
  const top10 = [...scores]
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  if (top10.length > 0) {
    console.log('[corporate-influence] Top 10 most influential entities:');
    for (const e of top10) {
      console.log(
        `  [${e.tier.padEnd(11)}] ${e.score.toFixed(2).padStart(6)}  ${e.entity_name}`,
      );
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
// Allows direct execution:
//   npx tsx scripts/pipeline/scorers/corporate-influence.ts

if (
  process.argv[1] &&
  (process.argv[1].endsWith('corporate-influence.ts') ||
    process.argv[1].endsWith('corporate-influence.js'))
) {
  calculateCorporateInfluenceScores()
    .then((summary) => {
      if (summary.errors.length > 0) {
        console.error(
          '[corporate-influence] Completed with errors:',
          summary.errors,
        );
        process.exit(1);
      }
    })
    .catch((err) => {
      console.error('[corporate-influence] Unhandled error:', err);
      process.exit(1);
    });
}
