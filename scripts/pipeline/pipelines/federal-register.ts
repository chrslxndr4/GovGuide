import { BasePipeline } from '../base.js';
import { FederalRegisterClient } from '../clients/federal-register.js';
import type { FRDocument } from '../clients/federal-register.js';

// Maps Federal Register document type strings to the law_type DB enum.
// PRESDOCU with presidential_document_type === 'executive_order' is handled
// separately before this map is consulted.
const LAW_TYPE_MAP: Record<string, string> = {
  RULE: 'regulation',
  PRORULE: 'regulation',
  NOTICE: 'administrative_code',
  PRESDOCU: 'administrative_code',
};

function toISODateOrNull(value: string | undefined | null): string | null {
  if (!value) return null;
  // The FR API returns dates as YYYY-MM-DD; pass through as-is.
  return value;
}

// Normalise an agency raw_name to a slug for fuzzy lookup in the agencies table.
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export class FederalRegisterPipeline extends BasePipeline {
  private client: FederalRegisterClient;
  private daysBack: number;

  // Cache federal jurisdiction_id and agency lookups across documents.
  private federalJurisdictionId: string | null = null;
  private agencyCache: Map<string, string | null> = new Map();

  constructor(daysBack: number = 30) {
    super();
    this.client = new FederalRegisterClient();
    this.daysBack = daysBack;
  }

  getName(): string {
    return 'federal-register';
  }

  async run(): Promise<void> {
    // ------------------------------------------------------------------
    // 1. Resolve the federal jurisdiction_id once up front.
    // ------------------------------------------------------------------
    this.federalJurisdictionId = await this.resolveFederalJurisdictionId();
    if (!this.federalJurisdictionId) {
      throw new Error(
        'Could not resolve a jurisdiction row with level = \'federal\'. Ensure the jurisdictions table is seeded.'
      );
    }

    // ------------------------------------------------------------------
    // 2. Fetch recent rules / proposed rules and executive orders in
    //    parallel. De-duplicate by document_number so that a document
    //    appearing in both result sets is only processed once.
    // ------------------------------------------------------------------
    console.log(
      `[${this.getName()}] Fetching recent rules (last ${this.daysBack} days) and executive orders...`
    );

    const [recentRules, executiveOrders] = await Promise.all([
      this.client.getRecentRules(this.daysBack).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${this.getName()}] Error fetching recent rules: ${msg}`);
        this.results.errors.push(`fetch recent-rules: ${msg}`);
        return [] as FRDocument[];
      }),
      this.client.getExecutiveOrders().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${this.getName()}] Error fetching executive orders: ${msg}`);
        this.results.errors.push(`fetch executive-orders: ${msg}`);
        return [] as FRDocument[];
      }),
    ]);

    // Also fetch proposed rules by querying PRORULE type for the same window.
    const proposedRules = await this.client
      .getDocuments({
        'conditions[type][]': 'PRORULE',
        'conditions[publication_date][gte]': new Date(
          Date.now() - this.daysBack * 86400000
        )
          .toISOString()
          .split('T')[0],
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${this.getName()}] Error fetching proposed rules: ${msg}`);
        this.results.errors.push(`fetch proposed-rules: ${msg}`);
        return [] as FRDocument[];
      });

    // Merge and de-duplicate.
    const seen = new Set<string>();
    const documents: FRDocument[] = [];
    for (const doc of [...recentRules, ...proposedRules, ...executiveOrders]) {
      if (!seen.has(doc.document_number)) {
        seen.add(doc.document_number);
        documents.push(doc);
      }
    }

    this.results.records_fetched = documents.length;
    console.log(`[${this.getName()}] Processing ${documents.length} unique documents...`);

    // ------------------------------------------------------------------
    // 3. Upsert each document.
    // ------------------------------------------------------------------
    for (const doc of documents) {
      try {
        await this.processDocument(doc);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.results.errors.push(`doc ${doc.document_number}: ${msg}`);
        console.error(
          `[${this.getName()}] Error processing ${doc.document_number}: ${msg}`
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Per-document processing
  // -----------------------------------------------------------------------
  private async processDocument(doc: FRDocument): Promise<void> {
    const lawType = this.mapLawType(doc);

    // Resolve the primary agency UUID (first agency in the array, best-effort).
    const primaryAgency = doc.agencies?.[0] ?? null;
    const agencyId = primaryAgency
      ? await this.resolveAgencyId(primaryAgency.raw_name)
      : null;

    const metadata: Record<string, unknown> = {
      document_number: doc.document_number,
      type: doc.type,
      publication_date: doc.publication_date,
      effective_on: toISODateOrNull(doc.effective_on),
      significant: doc.significant ?? false,
      agencies: doc.agencies ?? [],
      docket_ids: doc.docket_ids ?? [],
      cfr_references: doc.cfr_references ?? [],
      pdf_url: doc.pdf_url ?? null,
    };

    // Executive-order specific fields.
    if (doc.executive_order_number != null) {
      metadata['executive_order_number'] = doc.executive_order_number;
    }
    if (doc.presidential_document_type) {
      metadata['presidential_document_type'] = doc.presidential_document_type;
    }
    if (doc.signing_date) {
      metadata['signing_date'] = doc.signing_date;
    }

    const payload = {
      jurisdiction_id: this.federalJurisdictionId,
      law_type: lawType,
      title: doc.title ?? `Federal Register ${doc.document_number}`,
      description: doc.abstract ?? null,
      source_url: doc.html_url,
      api_url: `https://www.federalregister.gov/api/v1/documents/${doc.document_number}.json`,
      metadata,
    };

    // Upsert on source_url (html_url is stable and unique per document).
    const { data: existing } = await this.supabase
      .from('law_sources')
      .select('id')
      .eq('source_url', doc.html_url)
      .maybeSingle();

    if (existing) {
      const { error } = await this.supabase
        .from('law_sources')
        .update(payload)
        .eq('id', existing.id);

      if (error) throw new Error(`law_sources update failed: ${error.message}`);
      this.results.records_updated++;

      // Refresh any agency relationship.
      if (agencyId) {
        await this.upsertAgencyRelationship(existing.id, agencyId);
      }
      return;
    }

    // Insert new row.
    const { data: inserted, error: insertError } = await this.supabase
      .from('law_sources')
      .insert(payload)
      .select('id')
      .single();

    if (insertError) throw new Error(`law_sources insert failed: ${insertError.message}`);
    this.results.records_inserted++;

    if (agencyId && inserted) {
      await this.upsertAgencyRelationship(inserted.id, agencyId);
    }
  }

  // -----------------------------------------------------------------------
  // Type mapping
  // -----------------------------------------------------------------------
  private mapLawType(doc: FRDocument): string {
    // Presidential documents with executive_order type map directly.
    if (
      doc.type === 'PRESDOCU' &&
      doc.presidential_document_type === 'executive_order'
    ) {
      return 'executive_order';
    }
    return LAW_TYPE_MAP[doc.type] ?? 'administrative_code';
  }

  // -----------------------------------------------------------------------
  // Jurisdiction lookup — cached after first resolution.
  // -----------------------------------------------------------------------
  private async resolveFederalJurisdictionId(): Promise<string | null> {
    const { data } = await this.supabase
      .from('jurisdictions')
      .select('id')
      .eq('level', 'federal')
      .maybeSingle();

    return data?.id ?? null;
  }

  // -----------------------------------------------------------------------
  // Agency lookup — cached per raw_name. Tries exact name match first,
  // then slug-based fuzzy match. Returns null when no agency row is found
  // so the document is still written without an agency link.
  // -----------------------------------------------------------------------
  private async resolveAgencyId(rawName: string): Promise<string | null> {
    const trimmed = rawName.trim();

    if (this.agencyCache.has(trimmed)) {
      return this.agencyCache.get(trimmed)!;
    }

    // 1. Exact name match (case-insensitive via ilike).
    const { data: exactMatch } = await this.supabase
      .from('agencies')
      .select('id')
      .ilike('name', trimmed)
      .maybeSingle();

    if (exactMatch) {
      this.agencyCache.set(trimmed, exactMatch.id);
      return exactMatch.id;
    }

    // 2. Slug-based match — useful when the raw_name differs slightly from
    //    how the agency was seeded (e.g. "Dept. of Defense" vs "Department of Defense").
    const slug = toSlug(trimmed);
    const { data: slugMatch } = await this.supabase
      .from('agencies')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();

    const resolvedId = slugMatch?.id ?? null;
    this.agencyCache.set(trimmed, resolvedId);

    if (!resolvedId) {
      console.warn(
        `[${this.getName()}] No agency match for "${trimmed}" (slug: "${slug}"). Document will be saved without agency link.`
      );
    }

    return resolvedId;
  }

  // -----------------------------------------------------------------------
  // Agency → law_source relationship via the relationships table.
  // Stored as source = agency, target = law_source.
  // -----------------------------------------------------------------------
  private async upsertAgencyRelationship(
    lawSourceId: string,
    agencyId: string
  ): Promise<void> {
    const { error } = await this.supabase
      .from('relationships')
      .upsert(
        {
          source_entity_id: agencyId,
          target_entity_id: lawSourceId,
          relationship_type: 'regulates',
          source: 'federal_register',
        },
        {
          onConflict: 'source_entity_id,target_entity_id,relationship_type',
          ignoreDuplicates: true,
        }
      );

    // 23505 = unique_violation; treat as a no-op.
    if (error && error.code !== '23505') {
      console.warn(
        `[${this.getName()}] Agency relationship upsert failed (agency ${agencyId} → law_source ${lawSourceId}): ${error.message}`
      );
    }
  }
}
