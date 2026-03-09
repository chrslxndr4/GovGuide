import { BasePipeline } from '../base.js';
import { FECClient } from '../clients/fec.js';
import type { FECCommittee } from '../clients/fec.js';

// FEC committee_type codes that map to PAC-family entity types.
// All other alphabetic codes (e.g. P = presidential, H = house, S = senate,
// X = party non-qualified, Y = party qualified, Z = national party) are
// excluded because this pipeline focuses on PAC/independent-expenditure
// committees only.
const PAC_COMMITTEE_TYPES = ['O', 'Q', 'V', 'W', 'N', 'U', 'I', 'E'] as const;

type PacCommitteeType = (typeof PAC_COMMITTEE_TYPES)[number];

/**
 * Map an FEC committee_type code to the entity_type enum value stored in the
 * `entities` table.
 *
 * FEC type codes relevant to PACs:
 *   Q  — Qualified non-connected PAC (traditional PAC)
 *   N  — Qualified party committee (non-PAC but mapped as pac here)
 *   O  — Super PAC (independent expenditure only, not connected)
 *   V  — Affiliated super PAC
 *   W  — Hybrid PAC (Carey committee — can make both coordinated and IE)
 *   U  — Single-candidate IE committee (super-PAC variant)
 *   I  — Independent expenditure filer (not a committee; rare)
 *   E  — Electioneering communications organisation
 */
function committeeTypeToEntityType(
  committeeType: string
): 'pac' | 'super_pac' | 'hybrid_pac' {
  switch (committeeType) {
    case 'V':
    case 'O':
    case 'U':
    case 'I':
      return 'super_pac';
    case 'W':
      return 'hybrid_pac';
    default:
      // Q, N, E and any unrecognised codes fall back to 'pac'
      return 'pac';
  }
}

export class FECCommitteesPipeline extends BasePipeline {
  private fec: FECClient;

  constructor() {
    super();
    const apiKey = process.env.FEC_API_KEY;
    if (!apiKey) throw new Error('Missing required env var: FEC_API_KEY');
    this.fec = new FECClient(apiKey);
  }

  getName(): string {
    return 'fec-committees';
  }

  async run(): Promise<void> {
    for (const committeeType of PAC_COMMITTEE_TYPES) {
      console.log(`[${this.getName()}] Fetching committee_type=${committeeType}...`);
      let committees: FECCommittee[];

      try {
        committees = await this.fec.getCommittees({ committee_type: committeeType });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.results.errors.push(
          `Failed to fetch committees for type ${committeeType}: ${msg}`
        );
        console.error(`[${this.getName()}] ${msg}`);
        continue;
      }

      console.log(
        `[${this.getName()}] committee_type=${committeeType}: ${committees.length} records`
      );
      this.results.records_fetched += committees.length;

      for (const committee of committees) {
        try {
          await this.processCommittee(committee);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.results.errors.push(
            `Committee ${committee.committee_id} (${committee.name}): ${msg}`
          );
          console.error(`[${this.getName()}] ${msg}`);
        }
      }
    }
  }

  private async processCommittee(committee: FECCommittee): Promise<void> {
    const entityType = committeeTypeToEntityType(committee.committee_type);

    // --- 1. Upsert the entity row -------------------------------------------
    const entityId = await this.upsertEntity(
      {
        entity_type: entityType,
        name: committee.name,
        external_ids: { fec_committee_id: committee.committee_id },
        metadata: {
          state: committee.state ?? null,
          party: committee.party ?? null,
          treasurer_name: committee.treasurer_name ?? null,
        },
      },
      'fec_committee_id',
      committee.committee_id
    );

    // --- 2. Upsert entity_pacs detail row ------------------------------------
    // Use an upsert keyed on entity_id (primary key of the detail table).
    const pacDetail = {
      entity_id: entityId,
      fec_committee_id: committee.committee_id,
      pac_type: committee.committee_type ?? null,
      designation: committee.designation ?? null,
      treasurer_name: committee.treasurer_name ?? null,
      // filing_frequency and sponsor_entity_id are left null here; the
      // contributions pipeline can enrich them later.
      filing_frequency: null as string | null,
      sponsor_entity_id: null as string | null,
    };

    const { error: pacError } = await this.supabase
      .from('entity_pacs')
      .upsert(pacDetail, { onConflict: 'entity_id' });

    if (pacError) {
      throw new Error(`entity_pacs upsert failed: ${pacError.message}`);
    }

    // Increment updated counter (upsert may have inserted or updated; we
    // track conservatively as updated to avoid double-counting with
    // upsertEntity which increments records_inserted on true inserts).
    this.results.records_updated++;

    // --- 3. Sponsor-candidate affiliated_with relationships ------------------
    if (
      Array.isArray(committee.sponsor_candidate_ids) &&
      committee.sponsor_candidate_ids.length > 0
    ) {
      await this.upsertSponsorRelationships(
        entityId,
        committee.committee_id,
        committee.sponsor_candidate_ids
      );
    }
  }

  /**
   * For each sponsor candidate ID, look up (or skip if not yet loaded) the
   * candidate entity and create an `affiliated_with` relationship from the
   * PAC to the candidate.
   *
   * Candidate entities are expected to be ingested by a separate
   * fec-candidates pipeline. If the candidate entity does not exist yet the
   * relationship is deferred silently — it will be created on the next full
   * sync once both sides are present.
   */
  private async upsertSponsorRelationships(
    pacEntityId: string,
    fecCommitteeId: string,
    sponsorCandidateIds: string[]
  ): Promise<void> {
    for (const candidateId of sponsorCandidateIds) {
      // Look up the candidate entity by their FEC candidate ID.
      const { data: candidateEntity } = await this.supabase
        .from('entities')
        .select('id')
        .contains('external_ids', { fec_candidate_id: candidateId })
        .single();

      if (!candidateEntity) {
        // Candidate not yet ingested — skip without error.
        console.log(
          `[${this.getName()}] Skipping relationship: candidate ${candidateId} not yet in entities`
        );
        continue;
      }

      // Check whether this relationship already exists to avoid duplicates
      // (the relationships table has no unique constraint, so we guard here).
      const { data: existing } = await this.supabase
        .from('relationships')
        .select('id')
        .eq('source_entity_id', pacEntityId)
        .eq('target_entity_id', candidateEntity.id)
        .eq('relationship_type', 'affiliated_with')
        .maybeSingle();

      if (existing) continue;

      const { error: relError } = await this.supabase.from('relationships').insert({
        source_entity_id: pacEntityId,
        target_entity_id: candidateEntity.id,
        relationship_type: 'affiliated_with',
        confidence_score: 1.0,
        source: `fec:committee:${fecCommitteeId}`,
        metadata: {
          fec_committee_id: fecCommitteeId,
          fec_candidate_id: candidateId,
        },
      });

      if (relError) {
        throw new Error(
          `relationship insert failed (${fecCommitteeId} -> ${candidateId}): ${relError.message}`
        );
      }
    }
  }
}
