import { BasePipeline } from '../base.js';
import { USAspendingClient } from '../clients/usaspending.js';

// All 50 states plus DC, used to iterate top-contractor lookups.
const STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC',
];

// The US federal government fiscal year runs Oct 1 – Sep 30.
// The fiscal year is identified by the calendar year in which it ends.
// Example: FY2025 runs Oct 1 2024 – Sep 30 2025.
function currentFiscalYear(): number {
  const now = new Date();
  // On or after October 1 the new fiscal year has begun.
  return now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
}

// Normalize a USAspending recipient id to a stable string key.
// The API can return numeric IDs or DUNS-style strings; coerce to string.
function normalizeRecipientId(id: string | number | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  const s = String(id).trim();
  return s.length > 0 ? s : null;
}

export class USASpendingPipeline extends BasePipeline {
  private client: USAspendingClient;
  private fiscalYear: number;
  // Track contractor entity ids seen this run to skip redundant agency lookups.
  private processedContractors: Set<string> = new Set();
  // Count of geographic district records stored.
  private districtRecordsStored = 0;

  constructor(fiscalYear?: number) {
    super();
    this.client = new USAspendingClient();
    this.fiscalYear = fiscalYear ?? currentFiscalYear();
  }

  getName(): string {
    return 'usaspending';
  }

  async run(): Promise<void> {
    console.log(
      `[${this.getName()}] Starting USAspending pipeline for FY${this.fiscalYear}. ` +
      `Processing ${STATE_CODES.length} states...`
    );

    // Phase 1: Top contractors by state → entities + relationships.
    for (const state of STATE_CODES) {
      try {
        await this.processStateContractors(state);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[${this.getName()}] Error processing contractors for state ${state}: ${msg}`);
        this.results.errors.push(`State ${state} contractors: ${msg}`);
      }
    }

    // Phase 2: Geographic spending aggregates by congressional district.
    // We store these as aggregate metadata on existing contractor entities
    // and as standalone aggregate rows rather than individual award records.
    // This phase is best-effort; failures do not abort the pipeline.
    await this.processDistrictSpending();

    console.log(
      `[${this.getName()}] Phase summary — ` +
      `contractors processed: ${this.processedContractors.size}, ` +
      `district records stored: ${this.districtRecordsStored}`
    );
  }

  // ---------------------------------------------------------------------------
  // Phase 1: Top contractors per state
  // ---------------------------------------------------------------------------

  private async processStateContractors(state: string): Promise<void> {
    console.log(`[${this.getName()}] Fetching top contractors for ${state} FY${this.fiscalYear}...`);

    const response = await this.client.getTopContractors(state, this.fiscalYear, 20);

    if (!response.results || response.results.length === 0) {
      console.log(`[${this.getName()}] No contractor results for ${state}.`);
      return;
    }

    this.results.records_fetched += response.results.length;
    console.log(`[${this.getName()}] ${state}: received ${response.results.length} contractors.`);

    for (const contractor of response.results) {
      try {
        await this.processContractor(contractor, state);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const label = contractor.name ?? contractor.id ?? 'unknown';
        console.error(`[${this.getName()}] Error processing contractor "${label}" (${state}): ${msg}`);
        this.results.errors.push(`Contractor "${label}" (${state}): ${msg}`);
      }
    }
  }

  private async processContractor(
    contractor: { name: string; amount: number; id: string },
    state: string
  ): Promise<void> {
    const recipientId = normalizeRecipientId(contractor.id);
    const contractorName = contractor.name?.trim() || 'Unknown Contractor';

    // Step 1 — Upsert a 'corporation' entity for the contractor.
    // The usaspending_id in external_ids is used as the stable dedup key.
    const contractorEntityId = await this.upsertContractorEntity(
      contractorName,
      recipientId,
      contractor.amount,
      state
    );

    this.processedContractors.add(contractorEntityId);

    // Step 2 — Look up the awarding agency entity in the agencies table.
    // USAspending's spending_by_category/recipient endpoint aggregates across
    // all awarding agencies; we link to the generic federal government entity
    // as the payer when no specific agency is resolvable from the contractor
    // record alone.  A dedicated awards-level fetch (searchAwards) can later
    // enrich individual award→agency links.
    const agencyEntityId = await this.resolveAwardingAgencyEntity();

    if (!agencyEntityId) {
      // No federal agency anchor found — still record the contractor entity
      // but skip the relationship rather than inserting a dangling FK.
      console.warn(
        `[${this.getName()}] No awarding agency entity found in DB; skipping relationship for "${contractorName}".`
      );
      return;
    }

    // Step 3 — Upsert a 'paid_by' relationship: contractor ← agency.
    // The relationship direction is: agency paid contractor, meaning
    //   source = contractor (recipient of funds)
    //   target = agency (source of funds)
    // matching the 'paid_by' semantic ("contractor is paid_by agency").
    await this.upsertPaidByRelationship(
      contractorEntityId,
      agencyEntityId,
      contractor.amount,
      state
    );
  }

  // Upsert a corporation entity for a USAspending contractor recipient.
  // Stores aggregate spending metadata on the entity for quick lookups.
  private async upsertContractorEntity(
    name: string,
    recipientId: string | null,
    amount: number,
    state: string
  ): Promise<string> {
    // Prefer matching on usaspending_id; fall back to name-only insert when
    // the API does not provide a stable recipient id.
    if (recipientId) {
      const { data: existing } = await this.supabase
        .from('entities')
        .select('id, metadata')
        .contains('external_ids', { usaspending_id: recipientId })
        .maybeSingle();

      if (existing) {
        // Update the aggregate spending metadata for this fiscal year.
        await this.mergeContractorMetadata(existing.id, existing.metadata, amount, state);
        this.results.records_updated++;
        return existing.id;
      }
    }

    // No existing entity — insert.
    const { data: inserted, error } = await this.supabase
      .from('entities')
      .insert({
        entity_type: 'corporation',
        name,
        external_ids: recipientId ? { usaspending_id: recipientId } : {},
        metadata: {
          usaspending: {
            fiscal_year: this.fiscalYear,
            states: [state],
            total_amount: amount,
          },
        },
      })
      .select('id')
      .single();

    if (error) throw new Error(`Contractor entity insert failed: ${error.message}`);

    this.results.records_inserted++;
    return inserted!.id;
  }

  // Merge the latest aggregate spending values into an existing entity's
  // metadata JSONB without overwriting unrelated keys.
  private async mergeContractorMetadata(
    entityId: string,
    existingMetadata: Record<string, unknown> | null,
    amount: number,
    state: string
  ): Promise<void> {
    const current = (existingMetadata ?? {}) as Record<string, unknown>;
    const spending = (current['usaspending'] ?? {}) as Record<string, unknown>;

    // Accumulate states seen across fiscal year runs.
    const statesSet = new Set<string>(
      Array.isArray(spending['states']) ? (spending['states'] as string[]) : []
    );
    statesSet.add(state);

    // Sum amounts across states for the same fiscal year.
    const previousAmount =
      typeof spending['total_amount'] === 'number' ? spending['total_amount'] : 0;

    const updated = {
      ...current,
      usaspending: {
        ...spending,
        fiscal_year: this.fiscalYear,
        states: Array.from(statesSet),
        total_amount: previousAmount + amount,
      },
    };

    const { error } = await this.supabase
      .from('entities')
      .update({ metadata: updated })
      .eq('id', entityId);

    if (error) {
      throw new Error(`Contractor metadata update failed: ${error.message}`);
    }
  }

  // Resolve the awarding agency entity from the `agencies` table.
  // For the category-level endpoint we use the US federal government as the
  // canonical payer.  Returns null if no suitable agency entity is found.
  private async resolveAwardingAgencyEntity(): Promise<string | null> {
    // First check the entities table for a pre-existing federal government entry
    // that may have been seeded by the congress-members or other pipelines.
    const { data: entityResult } = await this.supabase
      .from('entities')
      .select('id')
      .eq('entity_type', 'government')
      .ilike('name', '%federal%')
      .limit(1)
      .maybeSingle();

    if (entityResult) return entityResult.id;

    // Fall back to the agencies table: look for a top-level federal record.
    const { data: agencyResult } = await this.supabase
      .from('agencies')
      .select('id')
      .ilike('name', '%united states%')
      .limit(1)
      .maybeSingle();

    if (agencyResult) return agencyResult.id;

    return null;
  }

  // Upsert the 'paid_by' relationship between a contractor entity and an
  // agency entity.  Conflicts on source+target+type+cycle are treated as
  // updates so that re-running the pipeline refreshes the amount.
  private async upsertPaidByRelationship(
    contractorEntityId: string,
    agencyEntityId: string,
    amount: number,
    state: string
  ): Promise<void> {
    const cycleStr = String(this.fiscalYear);

    const { error } = await this.supabase
      .from('relationships')
      .upsert(
        {
          source_entity_id: contractorEntityId,
          target_entity_id: agencyEntityId,
          relationship_type: 'paid_by',
          amount,
          cycle: cycleStr,
          metadata: {
            source: 'usaspending',
            fiscal_year: this.fiscalYear,
            state,
          },
        },
        {
          onConflict: 'source_entity_id,target_entity_id,relationship_type,cycle',
          ignoreDuplicates: false,
        }
      );

    if (error && error.code !== '23505') {
      throw new Error(`Relationship upsert failed: ${error.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 2: Geographic spending by congressional district
  // ---------------------------------------------------------------------------

  // Fetch spending aggregates for a representative sample of congressional
  // districts and store them as metadata on the relevant contractor entities.
  // We iterate the 50 states (not DC, which has no voting districts) and a
  // fixed set of single-digit district numbers as a lightweight probe.  A
  // full district enumeration is left for a dedicated enrichment pass.
  private async processDistrictSpending(): Promise<void> {
    console.log(`[${this.getName()}] Fetching district-level spending aggregates...`);

    // Probe a limited set of districts per state to stay within rate limits.
    // District '00' is used by states with a single at-large representative.
    const SAMPLE_DISTRICTS = ['00', '01', '02', '03', '04', '05'];
    const GEO_STATES = STATE_CODES.filter(s => s !== 'DC');

    for (const state of GEO_STATES) {
      for (const district of SAMPLE_DISTRICTS) {
        try {
          await this.processDistrict(state, district);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          // District-level failures are soft errors — log and continue.
          console.warn(
            `[${this.getName()}] District ${state}-${district} skipped: ${msg}`
          );
        }
      }
    }
  }

  private async processDistrict(state: string, district: string): Promise<void> {
    const response = await this.client.getSpendingByDistrict(state, district, this.fiscalYear);

    if (!response.results || response.results.length === 0) return;

    this.results.records_fetched += response.results.length;

    for (const result of response.results) {
      // Store the geographic aggregate as a metadata annotation on the entity
      // that corresponds to this district display_name if one already exists.
      // If no matching entity is found, record the count but do not create
      // synthetic entity records for geographic aggregates.
      const { data: geoEntity } = await this.supabase
        .from('entities')
        .select('id, metadata')
        .ilike('name', `%${result.display_name}%`)
        .limit(1)
        .maybeSingle();

      if (!geoEntity) continue;

      const current = (geoEntity.metadata ?? {}) as Record<string, unknown>;
      const districtSpending = (current['district_spending'] ?? {}) as Record<string, unknown>;

      const updatedMetadata = {
        ...current,
        district_spending: {
          ...districtSpending,
          [`${state}-${district}-fy${this.fiscalYear}`]: {
            display_name: result.display_name,
            aggregated_amount: result.aggregated_amount,
            per_capita: result.per_capita,
            fiscal_year: this.fiscalYear,
          },
        },
      };

      const { error } = await this.supabase
        .from('entities')
        .update({ metadata: updatedMetadata })
        .eq('id', geoEntity.id);

      if (error) {
        throw new Error(`District metadata update failed: ${error.message}`);
      }

      this.districtRecordsStored++;
      this.results.records_updated++;
    }
  }
}
