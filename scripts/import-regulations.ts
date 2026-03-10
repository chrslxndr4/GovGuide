/**
 * Import federal rulemaking documents from the Regulations.gov API v4.
 *
 * Fetches final rules and proposed rules (NPRMs) posted to the Federal
 * Register via the Regulations.gov public API and stores them in the
 * law_sources table alongside executive orders and statutes.
 *
 * Requires environment variable:  REGULATIONS_GOV_API_KEY
 * Obtain a free key at: https://api.data.gov/signup/
 * Rate limit: 1,000 requests / hour (enforced via REQUEST_DELAY_MS between
 * pages and an inter-document delay when fetching full detail records).
 *
 * What this script does:
 *   1. Resolves the federal jurisdiction UUID (slug='usa').
 *   2. Pages through GET /documents filtering for Rule and Proposed Rule
 *      document types, sorted newest-first.
 *   3. For each document stub, optionally fetches the full detail record to
 *      capture comment counts and other enriched fields.
 *   4. Upserts rows into law_sources:
 *        law_type  = 'regulation'
 *        source_url = Regulations.gov document URL (unique key)
 *      All API-specific fields are stored in the metadata JSONB column.
 *   5. Documents are flushed to Supabase in batches of BATCH_SIZE (500).
 *
 * Run with:  npm run import:regulations
 *
 * Optional environment overrides:
 *   REGULATIONS_DAYS_BACK=90   How many days back to fetch (default: 90)
 *   REGULATIONS_MAX_PAGES=0    Page cap (0 = unlimited)
 *   DRY_RUN=true               Print rows but do not upsert to the database
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types — Regulations.gov API v4 shapes
// ---------------------------------------------------------------------------

/** The "attributes" block returned for each item in the /documents list. */
interface RegDocAttributes {
  /** Document title. */
  title: string;
  /** Document type: "Rule", "Proposed Rule", "Notice", "Presidential Document", etc. */
  documentType: string;
  /** Docket ID, e.g. "EPA-HQ-OAR-2021-0627". */
  docketId: string | null;
  /** Federal Register document number, e.g. "2024-12345". */
  frDocNum: string | null;
  /** ISO-8601 date the document was posted to Regulations.gov. */
  postedDate: string | null;
  /** ISO-8601 date the document was published in the Federal Register. */
  federalRegisterNumber: string | null;
  /** Number of public comments received. */
  numberOfCommentsReceived: number | null;
  /** Whether the comment period is open. */
  openForComment: boolean | null;
  /** Comment-period start date (ISO-8601). */
  commentStartDate: string | null;
  /** Comment-period end date (ISO-8601). */
  commentEndDate: string | null;
  /** Short agency name or acronym. */
  agencyId: string | null;
  /** Document subtype, e.g. "Final Rule", "Interim Final Rule". */
  subtype: string | null;
  /** RIN (Regulatory Information Number) for significant rules. */
  rin: string | null;
  /** Raw summary / abstract text. */
  withdrawn: boolean | null;
}

/** A single item in the /documents list response. */
interface RegDocListItem {
  id: string;             // e.g. "EPA-HQ-OAR-2021-0627-0001"
  type: 'documents';
  attributes: RegDocAttributes;
  links: {
    self: string;         // full API URL for this document
  };
}

/** Paginated list response envelope. */
interface RegDocListResponse {
  data: RegDocListItem[];
  meta: {
    totalElements: number;
    totalPages: number;
    pageNumber: number;
    pageSize: number;
    lastPage: boolean;
  };
}

/** Attributes block on a single-document detail response. */
interface RegDocDetailAttributes extends RegDocAttributes {
  /** Additional detail fields available on single-document lookups. */
  topics: string[] | null;
  cfrPart: string | null;
  effectiveDate: string | null;
}

/** Single-document detail response envelope. */
interface RegDocDetailResponse {
  data: {
    id: string;
    type: 'documents';
    attributes: RegDocDetailAttributes;
  };
}

// ---------------------------------------------------------------------------
// Types — DB insert shape
// ---------------------------------------------------------------------------

interface LawSourceInsert {
  jurisdiction_id: string;
  law_type: 'regulation';
  title: string;
  description: string | null;
  source_url: string;
  api_url: string;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = 'https://api.regulations.gov/v4';
const PAGE_SIZE = 250;   // max page size the v4 API supports
const BATCH_SIZE = 500;  // DB upsert batch size, consistent with other importers

/**
 * Milliseconds to wait between API requests.
 * 1,000 req/hr = ~3.6 sec/req; we use 4 s to stay comfortably under the cap.
 * Requests within a single page fetch (list + optional detail) add up, so the
 * delay is applied between page fetches and between individual detail calls.
 */
const REQUEST_DELAY_MS = 4_000;

/**
 * Only import document types that represent genuine regulatory actions.
 * "Notice" covers Advance Notices of Proposed Rulemaking (ANPRMs) and other
 * significant Federal Register items worth tracking.
 */
const TARGET_DOCUMENT_TYPES = new Set(['Rule', 'Proposed Rule']);

/**
 * Significant federal agencies to include when filtering by agency.
 * Set to an empty Set to import all agencies (much larger volume).
 * These are the agency codes used by Regulations.gov.
 */
const SIGNIFICANT_AGENCIES = new Set([
  'EPA',   // Environmental Protection Agency
  'FDA',   // Food and Drug Administration
  'FCC',   // Federal Communications Commission
  'FTC',   // Federal Trade Commission
  'SEC',   // Securities and Exchange Commission
  'CFPB',  // Consumer Financial Protection Bureau
  'OSHA',  // Occupational Safety and Health Administration
  'FAA',   // Federal Aviation Administration
  'CMS',   // Centers for Medicare & Medicaid Services
  'HHS',   // Dept. of Health and Human Services
  'DOJ',   // Dept. of Justice
  'DOE',   // Dept. of Energy
  'DOT',   // Dept. of Transportation
  'USDA',  // Dept. of Agriculture
  'FED',   // Federal Reserve System
  'FDIC',  // Federal Deposit Insurance Corporation
  'OCC',   // Office of the Comptroller of the Currency
  'FERC',  // Federal Energy Regulatory Commission
  'NRC',   // Nuclear Regulatory Commission
  'CPSC',  // Consumer Product Safety Commission
  'EEOC',  // Equal Employment Opportunity Commission
  'NLRB',  // National Labor Relations Board
  'FRA',   // Federal Railroad Administration
  'NHTSA', // National Highway Traffic Safety Administration
  'FHWA',  // Federal Highway Administration
  'HUD',   // Dept. of Housing and Urban Development
  'DOL',   // Dept. of Labor
  'DHS',   // Dept. of Homeland Security
  'DOS',   // Dept. of State
  'DOD',   // Dept. of Defense (via DFARS etc.)
  'VA',    // Dept. of Veterans Affairs
  'SBA',   // Small Business Administration
  'IRS',   // Internal Revenue Service / Treasury
  'Treasury',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the canonical Regulations.gov web URL for a document.
 * Pattern: https://www.regulations.gov/document/{documentId}
 */
function buildDocumentUrl(documentId: string): string {
  return `https://www.regulations.gov/document/${documentId}`;
}

/**
 * Build the API URL for a single document's detail record.
 */
function buildDetailApiUrl(documentId: string, apiKey: string): string {
  return `${BASE_URL}/documents/${encodeURIComponent(documentId)}?api_key=${apiKey}`;
}

/**
 * Return an ISO date string for N days before today, used to bound the fetch.
 */
function daysAgoIso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

/**
 * Determine whether an agency code (from the API) is in the significant-
 * agencies list.  Returns true when SIGNIFICANT_AGENCIES is empty (fetch all).
 */
function isSignificantAgency(agencyId: string | null): boolean {
  if (SIGNIFICANT_AGENCIES.size === 0) return true;
  if (!agencyId) return false;
  // Match on prefix to catch sub-agencies like "EPA-R05" → "EPA"
  for (const sig of Array.from(SIGNIFICANT_AGENCIES)) {
    if (agencyId.toUpperCase().startsWith(sig.toUpperCase())) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

/**
 * Fetch one page of /documents from the Regulations.gov API.
 */
async function fetchDocumentPage(
  apiKey: string,
  page: number,
  postedDateGte: string,
): Promise<RegDocListResponse> {
  const params = new URLSearchParams({
    'filter[documentType]': 'Rule,Proposed Rule',
    'filter[postedDate][ge]': postedDateGte,
    'page[size]': String(PAGE_SIZE),
    'page[number]': String(page),
    'sort': '-postedDate',  // newest first
    'api_key': apiKey,
  });

  const url = `${BASE_URL}/documents?${params.toString()}`;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });

  if (res.status === 429) {
    throw new Error(
      `Regulations.gov rate limit hit (HTTP 429).\n` +
      `  The free tier allows 1,000 requests/hour.\n` +
      `  Wait an hour or reduce REGULATIONS_MAX_PAGES / REGULATIONS_DAYS_BACK.`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `Regulations.gov API error ${res.status} on page ${page}: ${res.statusText}\n` +
      `  URL: ${url}`,
    );
  }

  return (await res.json()) as RegDocListResponse;
}

/**
 * Fetch the full detail record for a single document.
 * Returns null on any non-fatal error so the caller can fall back to the
 * list-level attributes.
 */
async function fetchDocumentDetail(
  documentId: string,
  apiKey: string,
): Promise<RegDocDetailAttributes | null> {
  const url = buildDetailApiUrl(documentId, apiKey);

  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (res.status === 429) {
      // Propagate rate-limit errors so the main loop can abort gracefully.
      throw new Error(`Rate limit hit fetching detail for ${documentId}`);
    }

    if (!res.ok) {
      console.warn(
        `  WARN: detail fetch returned ${res.status} for ${documentId} — using list attributes`,
      );
      return null;
    }

    const body = (await res.json()) as RegDocDetailResponse;
    return body.data.attributes;
  } catch (err) {
    // Re-throw rate limit errors; swallow all others.
    if ((err as Error).message.startsWith('Rate limit hit')) throw err;
    console.warn(
      `  WARN: detail fetch failed for ${documentId}: ${(err as Error).message}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function getFederalJurisdictionId(): Promise<string> {
  const { data, error } = await supabase
    .from('jurisdictions')
    .select('id')
    .eq('slug', 'usa')
    .single();

  if (error || !data) {
    throw new Error(
      `Could not find federal jurisdiction (slug='usa'): ${error?.message ?? 'not found'}\n` +
      `  Run import:states first to seed the jurisdictions table.`,
    );
  }

  return (data as { id: string }).id;
}

/**
 * Flush a batch of law_source rows to Supabase via upsert.
 * Conflict key: source_url (the canonical Regulations.gov web URL).
 */
async function flushBatch(
  batch: LawSourceInsert[],
  dryRun: boolean,
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  if (dryRun) {
    console.log(`  [DRY RUN] Would upsert ${batch.length} row(s).`);
    return { ok: batch.length, err: 0 };
  }

  const { error } = await supabase
    .from('law_sources')
    .upsert(batch, { onConflict: 'source_url' });

  if (error) {
    console.error(
      `  BATCH ERROR law_sources (${batch.length} rows): ${error.message}`,
    );
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

// ---------------------------------------------------------------------------
// Document processing
// ---------------------------------------------------------------------------

/**
 * Build a LawSourceInsert from a document's attributes (list or detail).
 */
function buildInsertRow(
  documentId: string,
  apiKey: string,
  jurisdictionId: string,
  attrs: RegDocAttributes | RegDocDetailAttributes,
): LawSourceInsert {
  const sourceUrl = buildDocumentUrl(documentId);
  const apiUrl = buildDetailApiUrl(documentId, apiKey);

  // Derive a concise description from available fields.
  const descriptionParts: string[] = [];
  if (attrs.documentType) descriptionParts.push(attrs.documentType);
  if (attrs.subtype && attrs.subtype !== attrs.documentType) {
    descriptionParts.push(`(${attrs.subtype})`);
  }
  if (attrs.agencyId) descriptionParts.push(`— ${attrs.agencyId}`);
  if (attrs.docketId) descriptionParts.push(`| Docket: ${attrs.docketId}`);

  const description = descriptionParts.length > 0 ? descriptionParts.join(' ') : null;

  // Build the metadata JSONB, including all fields the UI / future scripts may need.
  const metadata: Record<string, unknown> = {
    document_id: documentId,
    document_type: attrs.documentType ?? null,
    subtype: attrs.subtype ?? null,
    agency_id: attrs.agencyId ?? null,
    docket_id: attrs.docketId ?? null,
    fr_doc_num: attrs.frDocNum ?? null,
    rin: attrs.rin ?? null,
    posted_date: attrs.postedDate ?? null,
    comment_count: attrs.numberOfCommentsReceived ?? null,
    open_for_comment: attrs.openForComment ?? null,
    comment_start_date: attrs.commentStartDate ?? null,
    comment_end_date: attrs.commentEndDate ?? null,
    withdrawn: attrs.withdrawn ?? false,
  };

  // Enrich with detail-only fields when available.
  const detailAttrs = attrs as RegDocDetailAttributes;
  if (detailAttrs.topics !== undefined) {
    metadata['topics'] = detailAttrs.topics ?? [];
  }
  if (detailAttrs.cfrPart !== undefined) {
    metadata['cfr_part'] = detailAttrs.cfrPart ?? null;
  }
  if (detailAttrs.effectiveDate !== undefined) {
    metadata['effective_date'] = detailAttrs.effectiveDate ?? null;
  }

  return {
    jurisdiction_id: jurisdictionId,
    law_type: 'regulation',
    title: attrs.title,
    description,
    source_url: sourceUrl,
    api_url: apiUrl,
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importRegulations(): Promise<void> {
  console.log('=== Import Federal Rulemaking (Regulations.gov API v4) ===\n');

  // ---- Configuration -------------------------------------------------------

  const apiKey = process.env['REGULATIONS_GOV_API_KEY'];
  if (!apiKey) {
    throw new Error(
      'Missing environment variable: REGULATIONS_GOV_API_KEY\n' +
      '  Obtain a free key at: https://api.data.gov/signup/\n' +
      '  Then add it to .env: REGULATIONS_GOV_API_KEY=your_key_here',
    );
  }

  const daysBack = parseInt(process.env['REGULATIONS_DAYS_BACK'] ?? '90', 10);
  const maxPages = parseInt(process.env['REGULATIONS_MAX_PAGES'] ?? '0', 10);
  const dryRun = process.env['DRY_RUN'] === 'true';

  const postedDateGte = daysAgoIso(daysBack);

  console.log(`Config:`);
  console.log(`  Days back:     ${daysBack} (from ${postedDateGte})`);
  console.log(`  Max pages:     ${maxPages === 0 ? 'unlimited' : maxPages}`);
  console.log(`  Document types: ${Array.from(TARGET_DOCUMENT_TYPES).join(', ')}`);
  console.log(`  Agency filter: ${SIGNIFICANT_AGENCIES.size > 0 ? `${SIGNIFICANT_AGENCIES.size} agencies` : 'all'}`);
  console.log(`  Dry run:       ${dryRun}`);
  console.log('');

  // ---- Resolve federal jurisdiction UUID -----------------------------------

  const jurisdictionId = await getFederalJurisdictionId();
  console.log(`Federal jurisdiction UUID: ${jurisdictionId}\n`);

  // ---- Pagination state ----------------------------------------------------

  let page = 1;
  let totalPages = 1; // updated after first response
  let totalElements = 0;

  // Batch accumulator and running totals.
  const batch: LawSourceInsert[] = [];
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let detailFetchCount = 0;

  // ---- Main fetch loop -----------------------------------------------------

  while (page <= totalPages) {
    if (maxPages > 0 && page > maxPages) {
      console.log(`\nMax pages (${maxPages}) reached — stopping.`);
      break;
    }

    console.log(
      `Fetching page ${page}/${totalPages === 1 && page === 1 ? '?' : totalPages} ` +
      `(${totalElements > 0 ? `${totalElements} total documents` : 'unknown total'}) …`,
    );

    const body = await fetchDocumentPage(apiKey, page, postedDateGte);

    // Capture pagination metadata from first response.
    totalPages = body.meta.totalPages;
    totalElements = body.meta.totalElements;

    console.log(
      `  Page ${page}/${totalPages}: ${body.data.length} documents ` +
      `(${totalElements} total across all pages)`,
    );

    // ---- Process each document in this page --------------------------------

    for (const item of body.data) {
      const { id: documentId, attributes } = item;

      // Apply document-type filter (the API filter[documentType] param is a
      // hint but the API sometimes returns adjacent types, so double-check).
      if (!TARGET_DOCUMENT_TYPES.has(attributes.documentType)) {
        totalSkipped++;
        continue;
      }

      // Apply agency significance filter.
      if (!isSignificantAgency(attributes.agencyId)) {
        totalSkipped++;
        continue;
      }

      // Skip withdrawn rules — they are no longer in effect.
      if (attributes.withdrawn === true) {
        totalSkipped++;
        continue;
      }

      // Fetch full detail record to enrich the row.
      // We respect the 1,000 req/hr cap with REQUEST_DELAY_MS between calls.
      let rowAttrs: RegDocAttributes | RegDocDetailAttributes = attributes;

      try {
        await sleep(REQUEST_DELAY_MS);
        const detail = await fetchDocumentDetail(documentId, apiKey);
        if (detail) {
          rowAttrs = detail;
          detailFetchCount++;
        }
      } catch (err) {
        // Rate limit or unexpected error — stop gracefully.
        console.error(`\nAborting detail fetch: ${(err as Error).message}`);
        // Flush what we have before exiting.
        if (batch.length > 0) {
          const { ok, err: flushErr } = await flushBatch(batch, dryRun);
          totalInserted += ok;
          totalErrors += flushErr;
          batch.length = 0;
        }
        console.log(
          `\n=== Partial import. Inserted/updated: ${totalInserted}, ` +
          `skipped: ${totalSkipped}, errors: ${totalErrors} ===`,
        );
        return;
      }

      const row = buildInsertRow(documentId, apiKey, jurisdictionId, rowAttrs);
      batch.push(row);

      process.stdout.write('.');

      // Flush batch when it reaches BATCH_SIZE.
      if (batch.length >= BATCH_SIZE) {
        console.log(''); // newline after dots
        const { ok, err } = await flushBatch(batch, dryRun);
        totalInserted += ok;
        totalErrors += err;
        batch.length = 0;
        console.log(
          `  Flushed batch — inserted/updated: ${ok}, errors: ${err} ` +
          `(running total: ${totalInserted})`,
        );
      }
    }

    console.log(''); // newline after dots for this page

    page++;

    // Delay between page fetches to stay within rate limits.
    if (page <= totalPages && (maxPages === 0 || page <= maxPages)) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  // ---- Flush any remaining rows --------------------------------------------

  if (batch.length > 0) {
    console.log(`Flushing final batch of ${batch.length} row(s) …`);
    const { ok, err } = await flushBatch(batch, dryRun);
    totalInserted += ok;
    totalErrors += err;
    console.log(`  Final batch — inserted/updated: ${ok}, errors: ${err}`);
  }

  // ---- Summary -------------------------------------------------------------

  console.log('\n=== Completed ===');
  console.log(`Documents fetched (all pages): ${totalElements}`);
  console.log(`Detail records fetched:        ${detailFetchCount}`);
  console.log(`Inserted / updated:            ${totalInserted}`);
  console.log(`Skipped (filtered out):        ${totalSkipped}`);
  console.log(`Errors:                        ${totalErrors}`);
}

importRegulations().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
