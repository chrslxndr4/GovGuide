import { BasePipeline } from '../base.js';
import { SenateLDAClient } from '../clients/senate-lda.js';
import type { LDAFiling, LDALobbyingActivity } from '../clients/senate-lda.js';

// Map LDA filing_period strings to their integer quarter equivalents.
// The LDA API uses period labels like 'Q1', 'Q2', 'H1', 'H2', 'annual', etc.
// Unmapped periods fall back to null so the row is still inserted.
const PERIOD_TO_QUARTER: Record<string, number | null> = {
  Q1: 1,
  Q2: 2,
  Q3: 3,
  Q4: 4,
  // Mid-year/annual reports are not tied to a single quarter.
  H1: null,
  H2: null,
  annual: null,
  year_end: null,
};

function periodToQuarter(period: string): number | null {
  return PERIOD_TO_QUARTER[period.toUpperCase()] ?? null;
}

// Parse a nullable income/expense string from the LDA API to a number.
// The API returns these as string decimals (e.g. "25000.00") or null.
function parseMoney(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? null : parsed;
}

// Derive a single income_or_expense value for the lobbying_activities table.
// Prefer income if present (registrant-reported), fall back to expenses.
function resolveActivityAmount(filing: LDAFiling): number | null {
  const income = parseMoney(filing.income);
  if (income !== null) return income;
  return parseMoney(filing.expenses);
}

// Collect all unique general_issue_codes from a filing's activities.
function collectGeneralIssues(activities: LDALobbyingActivity[]): string[] {
  const codes = activities
    .map(a => a.general_issue_code)
    .filter((c): c is string => Boolean(c));
  return [...new Set(codes)];
}

// Concatenate all activity descriptions into a single specific_issues text blob
// for the lobbying_registrations row (a registration-level summary).
function collectSpecificIssues(activities: LDALobbyingActivity[]): string {
  return activities
    .map(a => a.description?.trim())
    .filter(Boolean)
    .join('\n\n');
}

export class LobbyingPipeline extends BasePipeline {
  private lda: SenateLDAClient;
  private filingYear: string;

  constructor(filingYear?: string) {
    super();
    this.lda = new SenateLDAClient();
    // Default to 2024 filings; callers can override via constructor arg.
    this.filingYear = filingYear ?? '2024';
  }

  getName(): string {
    return 'lobbying';
  }

  async run(): Promise<void> {
    console.log(`[${this.getName()}] Fetching LDA filings for year ${this.filingYear}...`);

    const filings = await this.lda.getFilings({ filing_year: this.filingYear });
    this.results.records_fetched = filings.length;

    console.log(`[${this.getName()}] Received ${filings.length} filings. Processing...`);

    for (const filing of filings) {
      try {
        await this.processFiling(filing);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[${this.getName()}] Error on filing ${filing.filing_uuid}: ${msg}`);
        this.results.errors.push(`Filing ${filing.filing_uuid}: ${msg}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Core per-filing processing
  // -------------------------------------------------------------------------

  private async processFiling(filing: LDAFiling): Promise<void> {
    // Step 1 — Upsert lobbying_firm entity for the registrant.
    const firmEntityId = await this.upsertEntity(
      {
        entity_type: 'lobbying_firm',
        name: filing.registrant.name,
        external_ids: { lda_registrant_id: String(filing.registrant.id) },
      },
      'lda_registrant_id',
      String(filing.registrant.id)
    );

    // Step 2 — Upsert client entity.
    // Clients can be corporations, trade associations, foreign governments, etc.
    // We use the generic 'corporation' type as a safe default; operators can
    // reclassify manually or via a follow-up enrichment pipeline.
    const clientEntityId = await this.upsertEntity(
      {
        entity_type: 'corporation',
        name: filing.client.name,
        external_ids: { lda_client_id: String(filing.client.id) },
      },
      'lda_client_id',
      String(filing.client.id)
    );

    // Step 3 — Create or update the lobbying_registrations record for this
    // filing.  The senate_registration_id is the filing_uuid; each filing is
    // a point-in-time report tied to a registration.
    const registrationId = await this.upsertRegistration(filing, firmEntityId, clientEntityId);

    // Step 4 — Insert activity rows for each lobbying_activity in the filing.
    for (const activity of filing.lobbying_activities) {
      await this.insertActivity(filing, registrationId, activity);
    }

    // Step 5 — Extract covered_position lobbyists from all activities for
    // revolving-door tracking.  We log these here; a dedicated enrichment
    // pipeline can later link them to entity records.
    this.trackRevolvingDoor(filing);

    // Step 6 — Create 'registered_for' relationship: firm → client.
    await this.upsertRelationship({
      source_entity_id: firmEntityId,
      target_entity_id: clientEntityId,
      relationship_type: 'registered_for',
      metadata: {
        filing_uuid: filing.filing_uuid,
        filing_year: filing.filing_year,
        filing_period: filing.filing_period,
        filing_type: filing.filing_type,
      },
    });
  }

  // -------------------------------------------------------------------------
  // lobbying_registrations upsert
  // -------------------------------------------------------------------------

  private async upsertRegistration(
    filing: LDAFiling,
    firmEntityId: string,
    clientEntityId: string
  ): Promise<string> {
    // Check for an existing registration keyed on senate_registration_id
    // (which we store as the filing_uuid).
    const { data: existing, error: selectError } = await this.supabase
      .from('lobbying_registrations')
      .select('id')
      .eq('senate_registration_id', filing.filing_uuid)
      .maybeSingle();

    if (selectError) {
      throw new Error(`Registration lookup failed: ${selectError.message}`);
    }

    if (existing) {
      // Update the existing row to keep income/expense and issue lists current.
      const { error: updateError } = await this.supabase
        .from('lobbying_registrations')
        .update({
          general_issues: collectGeneralIssues(filing.lobbying_activities),
          specific_issues: collectSpecificIssues(filing.lobbying_activities),
          metadata: this.buildRegistrationMetadata(filing),
        })
        .eq('id', existing.id);

      if (updateError) {
        throw new Error(`Registration update failed: ${updateError.message}`);
      }

      this.results.records_updated++;
      return existing.id;
    }

    // Insert a new registration row.
    const { data: inserted, error: insertError } = await this.supabase
      .from('lobbying_registrations')
      .insert({
        firm_entity_id: firmEntityId,
        client_entity_id: clientEntityId,
        senate_registration_id: filing.filing_uuid,
        // LDA filings do not carry explicit effective/termination dates at
        // the filing level — use dt_posted as a best-effort effective_date.
        effective_date: filing.dt_posted ? filing.dt_posted.split('T')[0] : null,
        termination_date: null,
        general_issues: collectGeneralIssues(filing.lobbying_activities),
        specific_issues: collectSpecificIssues(filing.lobbying_activities),
        // The LDA API does not expose a foreign entity flag at filing level;
        // default to false and allow manual or enrichment override.
        foreign_entity_involved: false,
        metadata: this.buildRegistrationMetadata(filing),
      })
      .select('id')
      .single();

    if (insertError) {
      throw new Error(`Registration insert failed: ${insertError.message}`);
    }

    this.results.records_inserted++;
    return inserted!.id;
  }

  private buildRegistrationMetadata(filing: LDAFiling): Record<string, unknown> {
    return {
      filing_type: filing.filing_type,
      filing_year: filing.filing_year,
      filing_period: filing.filing_period,
      income: parseMoney(filing.income),
      expenses: parseMoney(filing.expenses),
      dt_posted: filing.dt_posted,
    };
  }

  // -------------------------------------------------------------------------
  // lobbying_activities insert (one row per LDALobbyingActivity)
  // -------------------------------------------------------------------------

  private async insertActivity(
    filing: LDAFiling,
    registrationId: string,
    activity: LDALobbyingActivity
  ): Promise<void> {
    // Each activity row gets a deduplicated check to keep the pipeline
    // idempotent on re-runs.  We key on registration_id + general_issue_code
    // + report_year + report_quarter since the LDA API provides no activity UUID.
    const quarter = periodToQuarter(filing.filing_period);

    const { data: existing } = await this.supabase
      .from('lobbying_activities')
      .select('id')
      .eq('registration_id', registrationId)
      .eq('report_year', filing.filing_year)
      .eq('general_issues', [activity.general_issue_code])
      .maybeSingle();

    if (existing) {
      this.results.records_skipped++;
      return;
    }

    // Build the lobbyists JSONB payload, including covered_position for
    // revolving-door tracking stored directly on the activity row.
    const lobbyistsPayload = activity.lobbyists.map(l => ({
      id: l.lobbyist.id,
      name: l.lobbyist.name,
      covered_position: l.covered_position ?? null,
    }));

    // agencies_contacted is derived from government_entities on the activity.
    const agenciesContacted = activity.government_entities.map(e => e.name);

    const { error: insertError } = await this.supabase
      .from('lobbying_activities')
      .insert({
        registration_id: registrationId,
        report_year: filing.filing_year,
        report_quarter: quarter,
        income_or_expense: resolveActivityAmount(filing),
        bills_lobbied: [],
        agencies_contacted: agenciesContacted,
        lobbyists: lobbyistsPayload,
        general_issues: activity.general_issue_code ? [activity.general_issue_code] : [],
        specific_issues: activity.description?.trim() ?? null,
      });

    if (insertError) {
      // Treat unique constraint violations as idempotent skips.
      if (insertError.code === '23505') {
        this.results.records_skipped++;
        return;
      }
      throw new Error(`Activity insert failed: ${insertError.message}`);
    }

    this.results.records_inserted++;
  }

  // -------------------------------------------------------------------------
  // Revolving door: log covered_position lobbyists for downstream tracking
  // -------------------------------------------------------------------------

  private trackRevolvingDoor(filing: LDAFiling): void {
    for (const activity of filing.lobbying_activities) {
      for (const entry of activity.lobbyists) {
        if (entry.covered_position?.trim()) {
          console.log(
            `[${this.getName()}] Revolving door — ` +
            `lobbyist=${entry.lobbyist.name} (id=${entry.lobbyist.id}) ` +
            `covered_position="${entry.covered_position}" ` +
            `filing=${filing.filing_uuid}`
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // relationships upsert
  // -------------------------------------------------------------------------

  private async upsertRelationship(rel: {
    source_entity_id: string;
    target_entity_id: string;
    relationship_type: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const { error } = await this.supabase
      .from('relationships')
      .upsert(
        {
          source_entity_id: rel.source_entity_id,
          target_entity_id: rel.target_entity_id,
          relationship_type: rel.relationship_type,
          metadata: rel.metadata ?? {},
        },
        {
          onConflict: 'source_entity_id,target_entity_id,relationship_type',
          ignoreDuplicates: false,
        }
      );

    if (error && error.code !== '23505') {
      throw new Error(`Relationship upsert failed: ${error.message}`);
    }
  }
}
