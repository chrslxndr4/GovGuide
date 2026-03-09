/**
 * FEC Independent Expenditures Pipeline
 *
 * Fetches independent expenditure records from the FEC API and loads them into
 * the `independent_expenditures`, `entities`, and `relationships` tables.
 *
 * Requires environment variable: FEC_API_KEY
 *
 * Entity look-up/creation uses the `external_ids` JSONB column keyed by
 * `fec_committee_id` (spenders) and `fec_candidate_id` (candidates) so that
 * re-runs are idempotent — existing entities are reused rather than duplicated.
 *
 * support_oppose_indicator mapping:
 *   S → support  → relationship_type 'spent_for'
 *   O → oppose   → relationship_type 'spent_against'
 */

import { BasePipeline } from '../base.js';
import { FECClient } from '../clients/fec.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SupportOppose = 'support' | 'oppose';
type RelationshipType = 'spent_for' | 'spent_against';

interface IndependentExpenditureInsert {
  spender_entity_id: string;
  candidate_entity_id: string;
  amount: number;
  expenditure_date: string | null;
  support_oppose: SupportOppose;
  purpose: string | null;
  payee: string | null;
  fec_filing_id: string | null;
  cycle: string;
}

interface RelationshipInsert {
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: RelationshipType;
  amount: number;
  cycle: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the current two-year election cycle.
 * FEC cycles end on even years (e.g. 2024, 2026).
 */
function currentCycle(): string {
  const year = new Date().getFullYear();
  // If the year is already even that is the cycle end year; otherwise next
  // even year is the cycle end.
  const cycleEnd = year % 2 === 0 ? year : year + 1;
  return String(cycleEnd);
}

function mapSupportOppose(indicator: string): SupportOppose {
  return indicator.toUpperCase() === 'S' ? 'support' : 'oppose';
}

function mapRelationshipType(indicator: string): RelationshipType {
  return indicator.toUpperCase() === 'S' ? 'spent_for' : 'spent_against';
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export class FECIndependentExpendituresPipeline extends BasePipeline {
  private fec: FECClient;
  private readonly cycle: string;

  // In-process entity cache: externalId → entity UUID
  private entityCache = new Map<string, string>();

  constructor(apiKey: string) {
    super();
    this.fec = new FECClient(apiKey);
    this.cycle = currentCycle();
  }

  // ---------------------------------------------------------------------------
  // Entity resolution
  // ---------------------------------------------------------------------------

  /**
   * Look up an entity by a known external ID stored inside the `external_ids`
   * JSONB column, or create a new entity record if one does not exist.
   *
   * @param entityType  - Value for the `entity_type` column
   * @param name        - Human-readable name for new entity creation
   * @param idKey       - The JSONB key used to index the external identifier
   *                      (e.g. 'fec_committee_id' | 'fec_candidate_id')
   * @param idValue     - The external identifier value to match against
   */
  private async resolveEntity(
    entityType: string,
    name: string,
    idKey: string,
    idValue: string,
  ): Promise<string | null> {
    // Return early from the in-memory cache to avoid redundant DB round trips.
    const cacheKey = `${idKey}:${idValue}`;
    if (this.entityCache.has(cacheKey)) {
      return this.entityCache.get(cacheKey)!;
    }

    // Query by JSONB membership: external_ids->>'fec_committee_id' = idValue
    const { data: existing, error: lookupError } = await this.supabase
      .from('entities')
      .select('id')
      .eq(`external_ids->>${idKey}`, idValue)
      .maybeSingle();

    if (lookupError) {
      console.error(
        `  ERROR looking up entity ${idKey}=${idValue}: ${lookupError.message}`,
      );
      this.results.failed++;
      return null;
    }

    if (existing) {
      const id = (existing as { id: string }).id;
      this.entityCache.set(cacheKey, id);
      return id;
    }

    // Create a new entity using the BasePipeline helper.
    const entityId = await this.upsertEntity(
      {
        entity_type: entityType,
        name,
        external_ids: { [idKey]: idValue },
      },
      `external_ids->>${idKey}`,
      idValue,
    );

    if (entityId) {
      this.entityCache.set(cacheKey, entityId);
    }

    return entityId;
  }

  // ---------------------------------------------------------------------------
  // Independent expenditure insertion
  // ---------------------------------------------------------------------------

  private async insertIndependentExpenditure(
    row: IndependentExpenditureInsert,
  ): Promise<boolean> {
    const { error } = await this.supabase
      .from('independent_expenditures')
      .insert(row);

    if (error) {
      console.error(
        `  ERROR inserting independent expenditure ` +
          `(spender=${row.spender_entity_id}, ` +
          `candidate=${row.candidate_entity_id}): ${error.message}`,
      );
      return false;
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Relationship insertion
  // ---------------------------------------------------------------------------

  private async insertRelationship(row: RelationshipInsert): Promise<boolean> {
    const { error } = await this.supabase
      .from('relationships')
      .upsert(row, {
        onConflict: 'source_entity_id,target_entity_id,relationship_type,cycle',
        ignoreDuplicates: false,
      });

    if (error) {
      console.error(
        `  ERROR upserting relationship ` +
          `(${row.source_entity_id} → ${row.target_entity_id}): ${error.message}`,
      );
      return false;
    }

    return true;
  }

  // ---------------------------------------------------------------------------
  // Main run
  // ---------------------------------------------------------------------------

  async run(): Promise<void> {
    console.log(`=== FEC Independent Expenditures Pipeline (cycle ${this.cycle}) ===\n`);

    // Fetch all independent expenditure records for the current cycle.
    let expenditures;
    try {
      expenditures = await this.fec.getIndependentExpenditures({
        cycle: Number(this.cycle),
      });
    } catch (err) {
      console.error('  FATAL: failed to fetch independent expenditures from FEC:', err);
      throw err;
    }

    console.log(`  Fetched ${expenditures.length} independent expenditure record(s).\n`);

    for (const ie of expenditures) {
      // ------------------------------------------------------------------
      // 1. Resolve spender entity (PAC / committee)
      // ------------------------------------------------------------------
      const spenderEntityId = await this.resolveEntity(
        'committee',
        ie.committee_name,
        'fec_committee_id',
        ie.committee_id,
      );

      if (!spenderEntityId) {
        console.warn(
          `  SKIP: could not resolve spender entity for committee_id=${ie.committee_id}`,
        );
        this.results.skipped++;
        continue;
      }

      // ------------------------------------------------------------------
      // 2. Resolve candidate entity
      // ------------------------------------------------------------------
      const candidateEntityId = await this.resolveEntity(
        'candidate',
        ie.candidate_name,
        'fec_candidate_id',
        ie.candidate_id,
      );

      if (!candidateEntityId) {
        console.warn(
          `  SKIP: could not resolve candidate entity for candidate_id=${ie.candidate_id}`,
        );
        this.results.skipped++;
        continue;
      }

      // ------------------------------------------------------------------
      // 3. Insert into independent_expenditures
      // ------------------------------------------------------------------
      const supportOppose = mapSupportOppose(ie.support_oppose_indicator);

      const ieInserted = await this.insertIndependentExpenditure({
        spender_entity_id: spenderEntityId,
        candidate_entity_id: candidateEntityId,
        amount: ie.expenditure_amount,
        expenditure_date: ie.expenditure_date ?? null,
        support_oppose: supportOppose,
        purpose: ie.purpose ?? null,
        payee: ie.payee_name ?? null,
        fec_filing_id: null, // FECClient does not expose a filing ID field
        cycle: this.cycle,
      });

      if (!ieInserted) {
        this.results.failed++;
        continue;
      }

      // ------------------------------------------------------------------
      // 4. Create / update 'spent_for' | 'spent_against' relationship
      // ------------------------------------------------------------------
      const relType = mapRelationshipType(ie.support_oppose_indicator);

      const relInserted = await this.insertRelationship({
        source_entity_id: spenderEntityId,
        target_entity_id: candidateEntityId,
        relationship_type: relType,
        amount: ie.expenditure_amount,
        cycle: this.cycle,
      });

      if (relInserted) {
        this.results.inserted++;
        process.stdout.write('.');
      } else {
        this.results.failed++;
      }
    }

    console.log(
      `\n\n=== Completed. ` +
        `inserted=${this.results.inserted}, ` +
        `skipped=${this.results.skipped}, ` +
        `failed=${this.results.failed} ===`,
    );
  }
}

// ---------------------------------------------------------------------------
// Entrypoint (run directly via tsx)
// ---------------------------------------------------------------------------

const apiKey = process.env['FEC_API_KEY'];
if (!apiKey) {
  console.error(
    'Missing environment variable: FEC_API_KEY\n' +
      'Obtain a free key at https://api.open.fec.gov/developers/',
  );
  process.exit(1);
}

const pipeline = new FECIndependentExpendituresPipeline(apiKey);
pipeline.run().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
