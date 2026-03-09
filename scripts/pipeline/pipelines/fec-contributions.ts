import { BasePipeline } from '../base.js';
import { FECClient } from '../clients/fec.js';

// Derive election cycle from a calendar year: FEC cycles are even-numbered years.
// The "current" cycle for a given year is the next even year (or same year if even).
function currentElectionCycle(): string {
  const year = new Date().getFullYear();
  return String(year % 2 === 0 ? year : year + 1);
}

interface CommitteeEntity {
  id: string;
  name: string;
  external_ids: Record<string, string>;
}

export class FECContributionsPipeline extends BasePipeline {
  private fec: FECClient;
  private cycle: string;

  constructor(cycle?: string) {
    super();
    const apiKey = process.env.FEC_API_KEY;
    if (!apiKey) throw new Error('Missing FEC_API_KEY environment variable');
    this.fec = new FECClient(apiKey);
    this.cycle = cycle ?? currentElectionCycle();
  }

  getName(): string {
    return 'fec-contributions';
  }

  async run(): Promise<void> {
    console.log(`[${this.getName()}] Fetching committee entities from Supabase (cycle: ${this.cycle})...`);

    // Step 1: Fetch all committee entities that have a fec_committee_id in external_ids.
    const { data: committees, error: committeesError } = await this.supabase
      .from('entities')
      .select('id, name, external_ids')
      .not('external_ids->fec_committee_id', 'is', null);

    if (committeesError) {
      throw new Error(`Failed to fetch committee entities: ${committeesError.message}`);
    }

    if (!committees || committees.length === 0) {
      console.log(`[${this.getName()}] No committee entities found. Exiting.`);
      return;
    }

    console.log(`[${this.getName()}] Found ${committees.length} committee entities. Processing contributions...`);

    for (const committee of committees as CommitteeEntity[]) {
      const committeeId = committee.external_ids?.fec_committee_id;
      if (!committeeId) continue;

      console.log(`[${this.getName()}] Fetching contributions for committee ${committeeId} (${committee.name})...`);

      let contributions;
      try {
        contributions = await this.fec.getContributions(committeeId, {
          two_year_transaction_period: this.cycle,
          sort: '-contribution_receipt_date',
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[${this.getName()}] Error fetching contributions for ${committeeId}: ${msg}`);
        this.results.errors.push(`Committee ${committeeId}: ${msg}`);
        continue;
      }

      this.results.records_fetched += contributions.length;
      console.log(`[${this.getName()}] Received ${contributions.length} contributions for ${committeeId}.`);

      for (const contribution of contributions) {
        try {
          // Step 3: Check for duplicate via fec_transaction_id (sub_id).
          const { data: existingContribution } = await this.supabase
            .from('contributions')
            .select('fec_transaction_id')
            .eq('fec_transaction_id', contribution.sub_id)
            .maybeSingle();

          if (existingContribution) {
            this.results.records_skipped++;
            continue;
          }

          // Step 4: Upsert a 'person' entity for the donor.
          // Use sub_id as the canonical external ID for this donor record since
          // contributor_name + state + zip can change across filings.
          const donorName = contribution.contributor_name?.trim() || 'Unknown Contributor';
          const donorEntityId = await this.upsertDonorEntity(contribution, donorName);

          // Step 5: Insert into contributions table.
          const { error: insertError } = await this.supabase
            .from('contributions')
            .insert({
              donor_entity_id: donorEntityId,
              recipient_entity_id: committee.id,
              amount: contribution.contribution_receipt_amount,
              contribution_date: contribution.contribution_receipt_date,
              contribution_type: contribution.fec_election_type_desc ?? null,
              employer: contribution.contributor_employer ?? null,
              occupation: contribution.contributor_occupation ?? null,
              fec_filing_id: null,
              fec_transaction_id: contribution.sub_id,
              memo: contribution.memo_text ?? null,
              cycle: this.cycle,
            });

          if (insertError) {
            // Treat unique constraint violations as skips rather than errors.
            if (insertError.code === '23505') {
              this.results.records_skipped++;
              continue;
            }
            throw new Error(`Contribution insert failed: ${insertError.message}`);
          }

          this.results.records_inserted++;

          // Step 6: Create 'donated_to' relationship from donor → recipient entity.
          await this.upsertRelationship({
            source_entity_id: donorEntityId,
            target_entity_id: committee.id,
            relationship_type: 'donated_to',
            amount: contribution.contribution_receipt_amount,
            cycle: this.cycle,
            source: 'fec',
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`[${this.getName()}] Error processing contribution ${contribution.sub_id}: ${msg}`);
          this.results.errors.push(`Contribution ${contribution.sub_id}: ${msg}`);
        }
      }
    }
  }

  // Upsert a 'person' entity for a contributor. The sub_id serves as a stable
  // external key for an individual transaction's contributor record.
  private async upsertDonorEntity(
    contribution: {
      contributor_name: string;
      contributor_state: string;
      contributor_zip: string;
      contributor_city: string;
      contributor_employer: string;
      contributor_occupation: string;
      sub_id: string;
    },
    displayName: string
  ): Promise<string> {
    // First try to match on a known fec_contributor_sub_id to avoid duplicates.
    const { data: existing } = await this.supabase
      .from('entities')
      .select('id')
      .contains('external_ids', { fec_contributor_sub_id: contribution.sub_id })
      .maybeSingle();

    if (existing) return existing.id;

    // No existing record — insert a new donor entity.
    const { data: inserted, error } = await this.supabase
      .from('entities')
      .insert({
        entity_type: 'person',
        name: displayName,
        external_ids: {
          fec_contributor_sub_id: contribution.sub_id,
        },
        metadata: {
          city: contribution.contributor_city ?? null,
          state: contribution.contributor_state ?? null,
          zip: contribution.contributor_zip ?? null,
          employer: contribution.contributor_employer ?? null,
          occupation: contribution.contributor_occupation ?? null,
        },
      })
      .select('id')
      .single();

    if (error) throw new Error(`Donor entity insert failed: ${error.message}`);

    // records_inserted is incremented inside upsertEntity on BasePipeline,
    // but we bypass that method here to control metadata — track manually.
    this.results.records_inserted++;

    return inserted!.id;
  }

  // Upsert a relationship row, skipping if one already exists for the same
  // source + target + type + cycle to keep the table idempotent.
  private async upsertRelationship(rel: {
    source_entity_id: string;
    target_entity_id: string;
    relationship_type: string;
    amount: number;
    cycle: string;
    source: string;
  }): Promise<void> {
    const { error } = await this.supabase
      .from('relationships')
      .upsert(rel, {
        onConflict: 'source_entity_id,target_entity_id,relationship_type,cycle',
        ignoreDuplicates: false,
      });

    if (error && error.code !== '23505') {
      throw new Error(`Relationship upsert failed: ${error.message}`);
    }
  }
}
