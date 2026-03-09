/**
 * Import executive orders from the Federal Register API (no auth required).
 *
 * Run with:  npm run import:eos
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FederalRegisterDocument {
  document_number: string;
  title: string;
  type: string;
  presidential_document_type: string | null;
  executive_order_number: string | null;
  signing_date: string | null;           // ISO date string
  html_url: string | null;
  pdf_url: string | null;
  full_text_xml_url: string | null;
  president?: { identifier?: string; name?: string };
  abstract: string | null;
}

interface FederalRegisterResponse {
  results: FederalRegisterDocument[];
  total_pages: number;
  count: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = 'https://www.federalregister.gov/api/v1/documents';
const PER_PAGE = 100;

function buildUrl(page: number): string {
  const params = new URLSearchParams({
    'conditions[type]': 'Presidential Document',
    'conditions[presidential_document_type]': 'Executive Order',
    per_page: String(PER_PAGE),
    page: String(page),
    order: 'newest',
  });
  return `${BASE_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function getFederalJurisdictionId(): Promise<string> {
  const { data, error } = await supabase
    .from('jurisdictions')
    .select('id')
    .eq('slug', 'usa')
    .single();

  if (error || !data) {
    throw new Error(
      `Could not find federal jurisdiction (slug='usa'): ${error?.message}`,
    );
  }
  return (data as { id: string }).id;
}

async function importExecutiveOrders(): Promise<void> {
  console.log('=== Import Executive Orders ===\n');

  const jurisdictionId = await getFederalJurisdictionId();

  let page = 1;
  let totalPages = 1;
  let totalInserted = 0;
  let totalSkipped = 0;

  while (page <= totalPages) {
    const url = buildUrl(page);
    console.log(`Fetching page ${page}/${totalPages === 1 ? '?' : totalPages} …`);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `Federal Register API returned ${res.status} on page ${page}: ${res.statusText}`,
      );
    }

    const body = (await res.json()) as FederalRegisterResponse;
    totalPages = body.total_pages;
    console.log(`  Got ${body.results.length} documents (total pages: ${totalPages})`);

    for (const doc of body.results) {
      // Prefer the HTML URL; fall back to PDF
      const sourceUrl = doc.html_url ?? doc.pdf_url ?? null;

      const insert = {
        jurisdiction_id: jurisdictionId,
        law_type: 'executive_order' as const,
        title: doc.title,
        description: doc.abstract ?? null,
        source_url: sourceUrl,
        api_url: `${BASE_URL}/${doc.document_number}.json`,
        metadata: {
          document_number: doc.document_number,
          executive_order_number: doc.executive_order_number ?? null,
          signing_date: doc.signing_date ?? null,
          president_name: doc.president?.name ?? null,
          president_identifier: doc.president?.identifier ?? null,
          pdf_url: doc.pdf_url ?? null,
          full_text_xml_url: doc.full_text_xml_url ?? null,
        },
      };

      const { error } = await supabase
        .from('law_sources')
        .upsert(insert, { onConflict: 'source_url' });

      if (error) {
        // source_url may be null for very old EOs — fall back to insert only
        if (error.code === '23502' || sourceUrl === null) {
          // Insert without relying on unique constraint
          const { error: insertError } = await supabase
            .from('law_sources')
            .insert(insert);
          if (insertError) {
            console.error(
              `  ERROR inserting EO "${doc.title}": ${insertError.message}`,
            );
            totalSkipped++;
            continue;
          }
        } else {
          console.error(
            `  ERROR upserting EO "${doc.title}": ${error.message}`,
          );
          totalSkipped++;
          continue;
        }
      }

      totalInserted++;
      process.stdout.write('.');
    }

    console.log('');
    page++;
  }

  console.log(
    `\n=== Completed. Inserted/updated: ${totalInserted}, skipped: ${totalSkipped} ===`,
  );
}

importExecutiveOrders().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
