import { BasePipeline } from '../base.js';
import { CongressClient } from '../clients/congress.js';

export class CongressBillsPipeline extends BasePipeline {
  private client: CongressClient;
  private congress: number;

  constructor(congress: number = 119) {
    super();
    const apiKey = process.env.CONGRESS_API_KEY;
    if (!apiKey) throw new Error('Missing CONGRESS_API_KEY env variable');
    this.client = new CongressClient(apiKey);
    this.congress = congress;
  }

  getName(): string {
    return 'congress-bills';
  }

  async run(): Promise<void> {
    console.log(`[${this.getName()}] Fetching bills for congress ${this.congress}...`);

    const bills = await this.client.getBills(this.congress);
    this.results.records_fetched = bills.length;
    console.log(`[${this.getName()}] Fetched ${bills.length} bills.`);

    for (const bill of bills) {
      try {
        await this.processBill(bill.congress, bill.type.toLowerCase(), bill.number);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.results.errors.push(`bill ${bill.type}${bill.number}: ${msg}`);
        console.error(`[${this.getName()}] Error on ${bill.type}${bill.number}: ${msg}`);
      }
    }
  }

  private async processBill(congress: number, type: string, number: number): Promise<void> {
    const billId = `${type}${number}-${congress}`;

    const { bill } = await this.client.getBillDetail(congress, type, number);

    // Resolve sponsor official UUID from bioguide_id
    let sponsorOfficialId: string | null = null;
    const primarySponsor = bill.sponsors?.[0];
    if (primarySponsor?.bioguideId) {
      const { data: official } = await this.supabase
        .from('officials')
        .select('id')
        .eq('bioguide_id', primarySponsor.bioguideId)
        .maybeSingle();
      sponsorOfficialId = official?.id ?? null;
    }

    // Build subjects array from legislative subjects
    const subjects =
      bill.subjects?.legislativeSubjects?.map((s: { name: string }) => s.name) ?? [];

    // Upsert into bills table
    const { data: upserted, error: billError } = await this.supabase
      .from('bills')
      .upsert(
        {
          bill_id: billId,
          congress: bill.congress,
          bill_type: bill.type,
          bill_number: bill.number,
          title: bill.title,
          policy_area: bill.policyArea?.name ?? null,
          subjects,
          introduced_date: bill.introducedDate ?? null,
          last_action_date: bill.latestAction?.actionDate ?? null,
          last_action_text: bill.latestAction?.text ?? null,
          sponsor_official_id: sponsorOfficialId,
          congress_gov_url: `https://www.congress.gov/bill/${congress}th-congress/${this.billTypeSlug(type)}/${number}`,
          metadata: {
            action_count: bill.actions?.count ?? 0,
            cosponsor_count: bill.cosponsors?.count ?? 0,
          },
        },
        { onConflict: 'bill_id' }
      )
      .select('id')
      .single();

    if (billError) throw new Error(`bills upsert failed: ${billError.message}`);

    const billDbId: string = upserted!.id;

    // Determine insert vs update for result tracking
    // Supabase upsert on conflict always returns the row; we treat any write as a result
    this.results.records_inserted++;

    // Insert bill_actions — delete existing rows first to avoid duplicates on re-runs
    await this.supabase.from('bill_actions').delete().eq('bill_id', billDbId);

    if ((bill.actions?.count ?? 0) > 0) {
      // The summary-level detail only carries a count; fetch the full actions list
      // via a separate paginated endpoint so each action row is complete.
      const actionsData = await this.client.fetch<{
        actions?: {
          actionDate: string;
          text: string;
          type: string;
          sourceSystem?: { name: string };
        }[];
      }>(`/bill/${congress}/${type}/${number}/actions`, { limit: '250' });

      const actionRows = (actionsData.actions ?? []).map(
        (a: {
          actionDate: string;
          text: string;
          type: string;
          sourceSystem?: { name: string };
        }) => ({
          bill_id: billDbId,
          action_date: a.actionDate,
          action_text: a.text,
          action_type: a.type ?? null,
          chamber: this.chamberFromSource(a.sourceSystem?.name),
        })
      );

      if (actionRows.length > 0) {
        const { error: actionsError } = await this.supabase
          .from('bill_actions')
          .insert(actionRows);
        if (actionsError) {
          throw new Error(`bill_actions insert failed for ${billId}: ${actionsError.message}`);
        }
      }
    }
  }

  // Maps Congress.gov bill type strings to URL slugs used on congress.gov
  private billTypeSlug(type: string): string {
    const slugs: Record<string, string> = {
      hr: 'house-bill',
      s: 'senate-bill',
      hjres: 'house-joint-resolution',
      sjres: 'senate-joint-resolution',
      hconres: 'house-concurrent-resolution',
      sconres: 'senate-concurrent-resolution',
      hres: 'house-resolution',
      sres: 'senate-resolution',
    };
    return slugs[type.toLowerCase()] ?? type;
  }

  // Infers chamber from the Congress API sourceSystem name field
  private chamberFromSource(sourceName?: string): string | null {
    if (!sourceName) return null;
    const lower = sourceName.toLowerCase();
    if (lower.includes('house')) return 'house';
    if (lower.includes('senate')) return 'senate';
    return null;
  }
}
