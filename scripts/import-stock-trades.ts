/**
 * Import congressional stock trades (STOCK Act / PTR disclosures) from
 * FREE public sources — no third-party API key required.
 *
 * Data sources:
 *   House PTRs: House Clerk FD ZIP index
 *     https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{YEAR}FD.zip
 *     The ZIP contains {YEAR}FD.xml with <Member> elements.  FilingType=P
 *     entries are PTR (Periodic Transaction Report = stock trade) filings.
 *     Because actual trade details (ticker, amount, buy/sell) are only in
 *     individual PDFs, we create one stock_trades record per PTR filing
 *     using only the index metadata.
 *
 *   Senate eFD: https://efdsearch.senate.gov
 *     The Senate publishes a CSV export of PTR filings via:
 *       https://efdsearch.senate.gov/search/report/annual/?submitted_start_date=...
 *     However the most reliable machine-readable source is a bulk CSV that
 *     the clerk publishes at:
 *       https://efdsearch.senate.gov/search/home/  (manual search)
 *     Since the Senate does NOT provide a bulk ZIP download equivalent to the
 *     House, this importer fetches the Senate search API JSON endpoint which
 *     is publicly accessible without authentication.
 *
 * Required environment variables:
 *   PUBLIC_SUPABASE_URL       — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Service-role key (bypasses RLS)
 *
 * Optional environment variables:
 *   IMPORT_YEAR     — Four-digit year to import (default: current year)
 *   IMPORT_CHAMBER  — "house" | "senate" | "both" (default: "both")
 *   DRY_RUN         — Set to "1" to skip DB writes and only log counts
 *
 * Run with:  npm run import:stock-trades
 *
 * What this script does:
 *   1. Downloads the House Clerk FD ZIP for the target year, parses the XML
 *      index for PTR filings (FilingType=P), and creates one record per filing.
 *   2. Fetches Senate PTR records from the eFD search JSON API (paginated).
 *   3. Resolves each trade to an existing official via name matching
 *      (cache-warmed exact match → ILIKE fallback → Jaro-Winkler fuzzy match).
 *   4. Upserts stock_trades rows in batches of 500.
 *   5. For each trade linked to a corporation entity (via ticker lookup in
 *      entity_corporations), upserts a relationships row of type 'traded'
 *      connecting the official's entity to the corporation entity.
 */

import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import { supabase } from './lib/supabase-admin.js';
import { jaroWinkler } from './lib/entity-resolver.js';

// crypto is imported for its stable hashing utilities (available for future
// deduplication / content-addressed ID generation if needed).
void crypto;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 500;

/**
 * STOCK Act statutory disclosure window in calendar days.
 * The generated column `days_late` in the DB computes this automatically;
 * the constant is kept here as documentation and for any client-side logic.
 */
const STOCK_ACT_DISCLOSURE_DAYS = 45; // referenced in JSDoc only — DB handles computation
void STOCK_ACT_DISCLOSURE_DAYS;

/**
 * House Clerk Financial Disclosure ZIP index.
 * The ZIP contains {YEAR}FD.xml listing all PTR filings for the year.
 * Individual trade details are only available in per-filing PDFs.
 */
const HOUSE_CLERK_FD_ZIP_URL = (year: number) =>
  `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`;

/**
 * Base URL for individual House PTR PDFs.
 */
const HOUSE_CLERK_PTR_PDF_BASE = (year: number, docId: string) =>
  `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`;

/**
 * Senate eFD search API — returns JSON for PTR (Periodic Transaction Report)
 * filings.  No authentication required; rate-limits apply.
 * doc_type=11 → Periodic Transaction Reports (STOCK Act filings)
 */
const SENATE_EFD_API =
  'https://efdsearch.senate.gov/search/report/annual/';

/** Fuzzy-match threshold (Jaro-Winkler score 0–1). */
const FUZZY_THRESHOLD = 0.88;

// ---------------------------------------------------------------------------
// DB insert shapes (targeting 013_stock_trading.sql schema)
// ---------------------------------------------------------------------------

interface StockTradeInsert {
  official_id: string;
  ticker: string | null;
  asset_name: string;
  asset_type: string | null;
  trade_type: 'buy' | 'sell' | 'exchange' | 'receive';
  amount_range_low: number | null;
  amount_range_high: number | null;
  trade_date: string;
  disclosure_date: string;
  // days_late is a GENERATED ALWAYS column — must NOT be in insert payload
  filing_url: string | null;
  owner: string | null;
  comment: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
}

interface RelationshipInsert {
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: 'traded';
  amount: number | null;
  date_start: string | null;
  metadata: Record<string, unknown>;
  confidence_score: number;
}

// ---------------------------------------------------------------------------
// STOCK Act amount range buckets → numeric bounds
// ---------------------------------------------------------------------------

const AMOUNT_RANGE_MAP: Record<string, { low: number; high: number | null }> = {
  '$1,001 - $15,000':        { low: 1_001,     high: 15_000 },
  '$15,001 - $50,000':       { low: 15_001,    high: 50_000 },
  '$50,001 - $100,000':      { low: 50_001,    high: 100_000 },
  '$100,001 - $250,000':     { low: 100_001,   high: 250_000 },
  '$250,001 - $500,000':     { low: 250_001,   high: 500_000 },
  '$500,001 - $1,000,000':   { low: 500_001,   high: 1_000_000 },
  '$1,000,001 - $5,000,000': { low: 1_000_001, high: 5_000_000 },
  '$5,000,001 - $25,000,000':{ low: 5_000_001, high: 25_000_000 },
  'Over $25,000,000':        { low: 25_000_001, high: null },
  'Over $1,000,000':         { low: 1_000_001, high: null },
  // Compact variants (no spaces around commas) sometimes seen in raw XML
  '$1001 - $15000':          { low: 1_001,     high: 15_000 },
  '$15001 - $50000':         { low: 15_001,    high: 50_000 },
  '$50001 - $100000':        { low: 50_001,    high: 100_000 },
  '$100001 - $250000':       { low: 100_001,   high: 250_000 },
  '$250001 - $500000':       { low: 250_001,   high: 500_000 },
  '$500001 - $1000000':      { low: 500_001,   high: 1_000_000 },
};

function parseAmountRange(
  raw: string | null | undefined,
): { low: number | null; high: number | null } {
  if (!raw) return { low: null, high: null };

  const trimmed = raw.trim();
  const mapped = AMOUNT_RANGE_MAP[trimmed];
  if (mapped) return mapped;

  // Generic "X - Y" pattern after stripping currency symbols and commas.
  const clean = trimmed.replace(/[$,]/g, '');
  const rangeMatch = clean.match(/^(\d+)\s*-\s*(\d+)$/);
  if (rangeMatch) {
    return { low: Number(rangeMatch[1]), high: Number(rangeMatch[2]) };
  }

  const overMatch = clean.match(/^[Oo]ver\s+(\d+)$/);
  if (overMatch) {
    return { low: Number(overMatch[1]) + 1, high: null };
  }

  const single = Number(clean);
  if (!Number.isNaN(single) && single > 0) return { low: single, high: single };

  return { low: null, high: null };
}

// ---------------------------------------------------------------------------
// Trade-type normalisation
// ---------------------------------------------------------------------------

/**
 * Map raw XML/JSON transaction type strings to the schema CHECK values.
 * Returns null for unrecognised values (row is skipped).
 */
function normaliseTradeType(
  raw: string | null | undefined,
): 'purchase' | 'sale' | 'exchange' | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().trim();
  if (lower === 'purchase' || lower === 'buy' || lower === 'p') return 'purchase';
  if (
    lower === 'sale' ||
    lower === 'sell' ||
    lower === 's' ||
    lower === 'sale_full' ||
    lower === 'sale_partial' ||
    lower.startsWith('sale (') ||
    lower === 'sale (full)' ||
    lower === 'sale (partial)' ||
    lower === 'receive' || lower === 'received'
  )
    return 'sale';
  if (lower === 'exchange' || lower === 'e') return 'exchange';
  return null;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to parse a variety of date formats into an ISO date string.
 * House XML uses "MM/DD/YYYY"; Senate JSON/CSV uses "YYYY-MM-DD" or
 * "Month DD, YYYY".  Returns null on failure.
 */
function parseIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;

  // Already ISO yyyy-mm-dd
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // MM/DD/YYYY
  const mdyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdyMatch) {
    const mm = mdyMatch[1].padStart(2, '0');
    const dd = mdyMatch[2].padStart(2, '0');
    return `${mdyMatch[3]}-${mm}-${dd}`;
  }

  // "Month DD, YYYY" — e.g. "March 15, 2024"
  const longMatch = s.match(
    /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/,
  );
  if (longMatch) {
    const months: Record<string, string> = {
      january: '01', february: '02', march: '03', april: '04',
      may: '05', june: '06', july: '07', august: '08',
      september: '09', october: '10', november: '11', december: '12',
    };
    const month = months[longMatch[1].toLowerCase()];
    if (month) {
      const dd = longMatch[2].padStart(2, '0');
      return `${longMatch[3]}-${month}-${dd}`;
    }
  }

  // Last resort: let Date parse it and reformat.
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }

  return null;
}

// ---------------------------------------------------------------------------
// In-process caches
// ---------------------------------------------------------------------------

/**
 * Normalised official name → officials.id
 * Populated by warmOfficialCaches().
 */
const officialByNameCache = new Map<
  string,
  { id: string; normFirst: string; normLast: string; normFull: string }
>();

/** officials.id → entity_id from entities table */
const officialEntityCache = new Map<string, string>();

/** ticker.toUpperCase() → entity_id from entity_corporations */
const corpEntityByTickerCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// Official resolution
// ---------------------------------------------------------------------------

/**
 * Strip titles and punctuation from a name string for comparison.
 * Intentionally distinct from entity-resolver's normalizeName which is
 * designed for organisation names (strips "Inc", "LLC", etc.).
 */
function normaliseMemberName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\b(sen|rep|dr|mr|mrs|ms|hon|jr|sr|ii|iii|iv)\.?\b/g, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pre-load all officials into the in-process name cache so that the
 * per-trade resolution loop avoids N+1 DB queries.
 */
async function warmOfficialCaches(): Promise<void> {
  console.log('  Warming official lookup caches ...');

  let page = 0;
  const limit = 1000;
  let totalFetched = 0;

  while (true) {
    const { data, error } = await supabase
      .from('officials')
      .select('id, first_name, last_name, full_name')
      .range(page * limit, (page + 1) * limit - 1);

    if (error) {
      throw new Error(`Failed to load officials for cache: ${error.message}`);
    }

    if (!data || data.length === 0) break;

    for (const row of data as {
      id: string;
      first_name: string | null;
      last_name: string | null;
      full_name: string | null;
    }[]) {
      const normFull = row.full_name ? normaliseMemberName(row.full_name) : '';
      const normFirst = row.first_name ? normaliseMemberName(row.first_name) : '';
      const normLast = row.last_name ? normaliseMemberName(row.last_name) : '';

      const entry = { id: row.id, normFirst, normLast, normFull };

      if (normFull) {
        officialByNameCache.set(normFull, entry);
      }
      // Also index "last first" form that some sources use.
      if (normLast && normFirst) {
        const lastFirst = `${normLast} ${normFirst}`;
        if (!officialByNameCache.has(lastFirst)) {
          officialByNameCache.set(lastFirst, entry);
        }
      }
    }

    totalFetched += data.length;
    page++;
    if (data.length < limit) break;
  }

  console.log(
    `  Cached ${officialByNameCache.size} name variants for ${totalFetched} officials.`,
  );
}

/**
 * Resolve a raw member name to an officials.id UUID.
 * Resolution order:
 *   1. Exact cache hit on normalised full name.
 *   2. Exact cache hit on "last first" form (for "Last, First" source names).
 *   3. Jaro-Winkler fuzzy match across cache keys (above FUZZY_THRESHOLD).
 *   4. DB ILIKE fallback on last_name + first_name prefix.
 */
async function resolveOfficialId(rawName: string): Promise<string | null> {
  const norm = normaliseMemberName(rawName);
  if (!norm) return null;

  // 1. Exact cache hit
  const direct = officialByNameCache.get(norm);
  if (direct) return direct.id;

  // 2. Decompose "Last, First" → try as "last first"
  const commaIdx = rawName.indexOf(',');
  if (commaIdx !== -1) {
    const lastName = normaliseMemberName(rawName.slice(0, commaIdx));
    const firstName = normaliseMemberName(
      rawName.slice(commaIdx + 1).trim().split(/\s+/)[0],
    );
    const lastFirstKey = `${lastName} ${firstName}`;
    const entry = officialByNameCache.get(lastFirstKey);
    if (entry) {
      officialByNameCache.set(norm, entry);
      return entry.id;
    }
  }

  // 3. Jaro-Winkler fuzzy match across all cache keys
  let bestScore = 0;
  let bestEntry: { id: string } | null = null;
  for (const [key, entry] of Array.from(officialByNameCache)) {
    const score = jaroWinkler(norm, key);
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }
  if (bestScore >= FUZZY_THRESHOLD && bestEntry) {
    // Cache hit — bestEntry is guaranteed non-null at this branch; cast to the
    // full cache value shape so future lookups via this key also get first/last.
    officialByNameCache.set(norm, bestEntry as {
      id: string; normFirst: string; normLast: string; normFull: string;
    });
    return bestEntry.id;
  }

  // 4. DB fallback: ILIKE on last name + first name prefix
  const parts = rawName
    .replace(/,/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length >= 2) {
    const lastName = parts[0];
    const firstName = parts[1];
    const { data } = await supabase
      .from('officials')
      .select('id, first_name, last_name, full_name')
      .ilike('last_name', lastName)
      .ilike('first_name', `${firstName}%`)
      .limit(1)
      .maybeSingle();

    if (data) {
      const row = data as {
        id: string;
        first_name: string | null;
        last_name: string | null;
        full_name: string | null;
      };
      const entry = {
        id: row.id,
        normFirst: normaliseMemberName(row.first_name ?? ''),
        normLast: normaliseMemberName(row.last_name ?? ''),
        normFull: normaliseMemberName(row.full_name ?? ''),
      };
      officialByNameCache.set(norm, entry);
      return row.id;
    }
  }

  return null;
}

async function resolveOfficialEntityId(
  officialId: string,
): Promise<string | null> {
  const cached = officialEntityCache.get(officialId);
  if (cached !== undefined) return cached || null;

  const { data } = await supabase
    .from('entities')
    .select('id')
    .contains('external_ids', { officials_id: officialId })
    .maybeSingle();

  const id = (data as { id: string } | null)?.id ?? null;
  officialEntityCache.set(officialId, id ?? '');
  return id;
}

async function resolveCorpEntityId(ticker: string | null): Promise<string | null> {
  if (!ticker) return null;
  const upper = ticker.toUpperCase();

  const cached = corpEntityByTickerCache.get(upper);
  if (cached !== undefined) return cached || null;

  const { data } = await supabase
    .from('entity_corporations')
    .select('entity_id')
    .eq('ticker', upper)
    .maybeSingle();

  const id = (data as { entity_id: string } | null)?.entity_id ?? null;
  corpEntityByTickerCache.set(upper, id ?? '');
  return id;
}

// ---------------------------------------------------------------------------
// Batch upsert helpers
// ---------------------------------------------------------------------------

async function flushTrades(
  batch: StockTradeInsert[],
  dryRun: boolean,
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  if (dryRun) {
    return { ok: batch.length, err: 0 };
  }

  const { error } = await supabase.from('stock_trades').upsert(batch, {
    onConflict: 'official_id,ticker,trade_date,trade_type,amount_range_low',
    ignoreDuplicates: false,
  });

  if (error) {
    console.error(`\n  BATCH ERROR flushing ${batch.length} trades: ${error.message}`);
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

async function flushRelationships(
  batch: RelationshipInsert[],
  dryRun: boolean,
): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  if (dryRun) {
    return { ok: batch.length, err: 0 };
  }

  const { error } = await supabase.from('relationships').upsert(batch, {
    onConflict: 'source_entity_id,target_entity_id,relationship_type,date_start',
    ignoreDuplicates: false,
  });

  if (error) {
    console.error(`\n  BATCH ERROR flushing ${batch.length} relationships: ${error.message}`);
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

// ---------------------------------------------------------------------------
// Parsed trade record (intermediate — both chambers map into this)
// ---------------------------------------------------------------------------

interface ParsedTrade {
  memberName: string;
  /** PTR document ID from the source — used for filing_url construction. */
  docId: string | null;
  ticker: string | null;
  assetName: string;
  assetType: string | null;
  rawTradeType: string | null;
  rawAmount: string | null;
  tradeDate: string | null;  // ISO date string
  disclosureDate: string | null; // ISO date string
  owner: string | null;
  comment: string | null;
  filingUrl: string | null;
  chamber: 'house' | 'senate';
}

// ---------------------------------------------------------------------------
// House PTR — House Clerk FD ZIP index
// ---------------------------------------------------------------------------

/**
 * Minimal ZIP local-file-header parser.
 *
 * ZIP local file header layout (per PKWARE spec):
 *   Offset  Size  Description
 *   0       4     Signature: PK\x03\x04
 *   4       2     Version needed
 *   6       2     General purpose bit flag
 *   8       2     Compression method (0=stored, 8=deflate)
 *   10      2     Last mod file time
 *   12      2     Last mod file date
 *   14      4     CRC-32
 *   18      4     Compressed size
 *   22      4     Uncompressed size
 *   26      2     File name length
 *   28      2     Extra field length
 *   30      n     File name
 *   30+n    m     Extra field
 *   30+n+m  ...   File data
 *
 * We iterate through all local file headers to find the entry whose name
 * matches the target filename, then decompress using Node's zlib.
 */
function extractFileFromZip(
  zipBuffer: Buffer,
  targetName: string,
): Buffer | null {
  const SIG = 0x04034b50; // PK\x03\x04 in little-endian uint32
  let offset = 0;

  while (offset + 30 <= zipBuffer.length) {
    const sig = zipBuffer.readUInt32LE(offset);

    if (sig !== SIG) {
      // Not a local file header — skip one byte and scan forward.
      // In practice signatures are always aligned; this handles any padding.
      offset++;
      continue;
    }

    const method         = zipBuffer.readUInt16LE(offset + 8);
    const compressedSize = zipBuffer.readUInt32LE(offset + 18);
    const fileNameLen    = zipBuffer.readUInt16LE(offset + 26);
    const extraLen       = zipBuffer.readUInt16LE(offset + 28);

    const dataOffset = offset + 30 + fileNameLen + extraLen;

    const fileName = zipBuffer.toString('utf8', offset + 30, offset + 30 + fileNameLen);

    if (fileName.toLowerCase() === targetName.toLowerCase()) {
      const compressed = zipBuffer.subarray(dataOffset, dataOffset + compressedSize);

      if (method === 0) {
        // Stored — no compression.
        return Buffer.from(compressed);
      }

      if (method === 8) {
        // Deflate (raw — no zlib wrapper).
        return zlib.inflateRawSync(compressed);
      }

      console.warn(
        `  WARN: ZIP entry "${fileName}" uses unsupported compression method ${method}.`,
      );
      return null;
    }

    // Advance past this entry.
    offset = dataOffset + compressedSize;
  }

  return null;
}

/**
 * Extract all <Member> elements from the FD XML string and return an array
 * of plain objects keyed by element name.  We use regex because the XML is
 * simple and flat — no namespace, no attributes on data elements, no nesting
 * beyond a single wrapper — and avoids pulling in a full XML parser.
 */
function parseMembersFromXml(
  xml: string,
): Array<Record<string, string>> {
  const members: Array<Record<string, string>> = [];

  // Match each <Member>...</Member> block (DOTALL via [\s\S]).
  const memberRe = /<Member>([\s\S]*?)<\/Member>/gi;
  let memberMatch: RegExpExecArray | null;

  while ((memberMatch = memberRe.exec(xml)) !== null) {
    const block = memberMatch[1];
    const record: Record<string, string> = {};

    // Extract each <Tag>value</Tag> pair within the block.
    const fieldRe = /<([A-Za-z_][A-Za-z0-9_]*)>([^<]*)<\/\1>/g;
    let fieldMatch: RegExpExecArray | null;

    while ((fieldMatch = fieldRe.exec(block)) !== null) {
      record[fieldMatch[1]] = fieldMatch[2].trim();
    }

    members.push(record);
  }

  return members;
}

/**
 * Download the House Clerk FD ZIP for the given year, parse the XML index,
 * filter to PTR filings (FilingType=P), and return one ParsedTrade per filing.
 *
 * Note: The actual trade details (ticker, amount, buy/sell) are only available
 * in the individual PDF filings.  Until PDF parsing is implemented we create a
 * single placeholder record per PTR filing using the index metadata only.
 */
async function fetchAllHousePtrs(year: number): Promise<ParsedTrade[]> {
  const zipUrl = HOUSE_CLERK_FD_ZIP_URL(year);
  console.log(`  [house] Downloading House Clerk FD ZIP for ${year} ...`);
  console.log(`  [house] URL: ${zipUrl}`);

  let zipBuffer: Buffer;
  try {
    const res = await fetch(zipUrl, {
      headers: {
        'User-Agent': 'GovGuide-Importer/1.0 (public data; govguide.us)',
      },
    });

    if (!res.ok) {
      console.error(
        `  ERROR: House Clerk FD ZIP returned HTTP ${res.status} for ${year}.`,
      );
      return [];
    }

    const arrayBuffer = await res.arrayBuffer();
    zipBuffer = Buffer.from(arrayBuffer);
    console.log(
      `  [house] Downloaded ${(zipBuffer.length / 1024).toFixed(1)} KB.`,
    );
  } catch (err) {
    console.error(
      `  ERROR downloading House Clerk FD ZIP: ${(err as Error).message}`,
    );
    return [];
  }

  // The XML entry inside the ZIP is named "{YEAR}FD.xml".
  const xmlEntryName = `${year}FD.xml`;
  let xmlBuffer: Buffer | null;

  try {
    xmlBuffer = extractFileFromZip(zipBuffer, xmlEntryName);
  } catch (err) {
    console.error(
      `  ERROR extracting ${xmlEntryName} from ZIP: ${(err as Error).message}`,
    );
    return [];
  }

  if (!xmlBuffer) {
    console.error(
      `  ERROR: Could not find "${xmlEntryName}" inside the FD ZIP.`,
    );
    return [];
  }

  const xmlText = xmlBuffer.toString('utf8');
  console.log(
    `  [house] Extracted XML (${(xmlText.length / 1024).toFixed(1)} KB). Parsing members ...`,
  );

  const members = parseMembersFromXml(xmlText);
  console.log(`  [house] Found ${members.length} <Member> entries in XML.`);

  // PTR filings have FilingType == "P".
  const ptrMembers = members.filter((m) => m['FilingType'] === 'P');
  console.log(`  [house] ${ptrMembers.length} PTR (FilingType=P) entries.`);

  const allTrades: ParsedTrade[] = [];

  for (const m of ptrMembers) {
    const first = (m['First'] ?? '').trim();
    const last  = (m['Last']  ?? '').trim();

    // Strip courtesy prefix ("Hon.", "Dr.", etc.) from First name.
    const cleanFirst = first.replace(/^(Hon|Dr|Mr|Mrs|Ms)\.?\s+/i, '').trim();
    const memberName = `${cleanFirst} ${last}`.trim();

    if (!memberName) continue;

    const docId = (m['DocID'] ?? '').trim() || null;
    const filingDate = parseIsoDate(m['FilingDate'] ?? null);

    // FilingDate is the only date available from the index.
    // We use it for both tradeDate and disclosureDate as a conservative
    // placeholder; the actual trade date is only in the PDF.
    if (!filingDate) continue;

    allTrades.push({
      memberName,
      docId,
      ticker: null,
      assetName: 'PTR Filing',
      assetType: null,
      rawTradeType: 'purchase', // placeholder — PDF required for actual type
      rawAmount: null,
      tradeDate: filingDate,
      disclosureDate: filingDate,
      owner: null,
      comment: null,
      filingUrl: docId ? HOUSE_CLERK_PTR_PDF_BASE(year, docId) : null,
      chamber: 'house',
    });
  }

  console.log(
    `  [house] Extracted ${allTrades.length} PTR trade record(s) for year ${year}.`,
  );
  return allTrades;
}

// ---------------------------------------------------------------------------
// Senate eFD — JSON search API
// ---------------------------------------------------------------------------

/**
 * The Senate eFD search endpoint accepts POST requests for PTR filings.
 * It returns JSON with a data array and pagination metadata.
 *
 * PTR record shape (from the JSON response):
 * {
 *   "first_name": "John",
 *   "last_name": "Doe",
 *   "date_filed": "2024-03-15",
 *   "report_type": "PTR",
 *   "link": "/search/view/paper/abc123/",
 *   "transactions": [
 *     {
 *       "asset_name": "Apple Inc.",
 *       "asset_type": "Stock",
 *       "transaction_date": "2024-03-01",
 *       "transaction_type": "Purchase",
 *       "amount": "$15,001 - $50,000",
 *       "ticker": "AAPL",
 *       "owner": "Self",
 *       "comment": ""
 *     }
 *   ]
 * }
 *
 * NOTE: The Senate eFD does not publish a documented public API.  The
 * search endpoint at /search/report/annual/ accepts POST with form-encoded
 * params and returns JSON when Accept: application/json is sent.
 * If the endpoint changes, set IMPORT_CHAMBER=house to skip Senate.
 */
interface SenateFdrRecord {
  first_name?: string;
  last_name?: string;
  date_filed?: string;
  report_type?: string;
  link?: string;
  transactions?: Array<{
    asset_name?: string;
    asset_type?: string;
    transaction_date?: string;
    transaction_type?: string;
    amount?: string;
    ticker?: string;
    owner?: string;
    comment?: string;
  }>;
}

interface SenateFdrResponse {
  data?: SenateFdrRecord[];
  recordsTotal?: number;
  recordsFiltered?: number;
}

async function fetchSenateFdrPage(
  year: number,
  start: number,
  length: number,
): Promise<SenateFdrResponse | null> {
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;

  // The Senate eFD search form uses POST with form-encoded body.
  const body = new URLSearchParams({
    submitted_start_date: startDate,
    submitted_end_date: endDate,
    report_type_id: '11', // 11 = PTR (Periodic Transaction Report)
    start: String(start),
    length: String(length),
  });

  let res: Response;
  try {
    res = await fetch(SENATE_EFD_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'User-Agent': 'GovGuide-Importer/1.0 (public data; govguide.us)',
        // The Senate eFD requires a Referer header to prevent CSRF issues.
        'Referer': 'https://efdsearch.senate.gov/search/home/',
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: body.toString(),
    });
  } catch (err) {
    console.warn(
      `  WARN Senate eFD fetch error (start=${start}): ${(err as Error).message}`,
    );
    return null;
  }

  if (res.status === 403 || res.status === 404 || res.status === 503) {
    // Senate eFD can be unavailable or block automated access.
    console.warn(
      `  WARN Senate eFD returned HTTP ${res.status} — Senate trades will be skipped.`,
    );
    console.warn(
      `  TIP: Run with IMPORT_CHAMBER=house to import House trades only.`,
    );
    return null;
  }

  if (!res.ok) {
    console.warn(`  WARN Senate eFD HTTP ${res.status} at start=${start}`);
    return null;
  }

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    // eFD returned HTML (login page or maintenance) — abort Senate import.
    console.warn(
      `  WARN Senate eFD did not return JSON (got "${contentType}"). Skipping Senate.`,
    );
    return null;
  }

  try {
    return (await res.json()) as SenateFdrResponse;
  } catch (err) {
    console.warn(`  WARN Senate eFD JSON parse error: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Fetch all Senate PTR records for a given year by paginating the eFD API.
 * Returns an empty array if the API is unavailable.
 */
async function fetchAllSenatePtrs(year: number): Promise<ParsedTrade[]> {
  console.log(`  [senate] Querying Senate eFD for ${year} PTR records ...`);

  const PAGE_SIZE = 100;
  let start = 0;
  let total = Infinity;
  const allTrades: ParsedTrade[] = [];
  let nullPage = false;

  while (start < total) {
    const page = await fetchSenateFdrPage(year, start, PAGE_SIZE);

    if (page === null) {
      nullPage = true;
      break;
    }

    if (total === Infinity) {
      total = page.recordsFiltered ?? page.recordsTotal ?? 0;
      console.log(`  [senate] Total PTR records for ${year}: ${total}`);
    }

    const records = page.data ?? [];
    if (records.length === 0) break;

    for (const rec of records) {
      const memberName =
        `${rec.first_name ?? ''} ${rec.last_name ?? ''}`.trim();
      const disclosureDate = parseIsoDate(rec.date_filed ?? null);

      const filingUrl = rec.link
        ? `https://efdsearch.senate.gov${rec.link}`
        : null;

      // Each record may contain multiple transactions.
      for (const tx of rec.transactions ?? []) {
        allTrades.push({
          memberName,
          docId: rec.link ?? null,
          ticker: tx.ticker ? tx.ticker.trim().toUpperCase() : null,
          assetName: tx.asset_name?.trim() || 'Unknown Asset',
          assetType: tx.asset_type?.trim() || null,
          rawTradeType: tx.transaction_type ?? null,
          rawAmount: tx.amount ?? null,
          tradeDate: parseIsoDate(tx.transaction_date ?? null),
          disclosureDate,
          owner: tx.owner?.trim() || null,
          comment: tx.comment?.trim() || null,
          filingUrl,
          chamber: 'senate',
        });
      }
    }

    start += records.length;
    if (records.length < PAGE_SIZE) break;
  }

  if (nullPage && allTrades.length === 0) {
    console.warn(`  [senate] Senate eFD API unavailable — no Senate trades imported.`);
  } else {
    console.log(`  [senate] Extracted ${allTrades.length} trade record(s).`);
  }

  return allTrades;
}

// ---------------------------------------------------------------------------
// Process trades (both chambers share this path)
// ---------------------------------------------------------------------------

async function processTrades(
  trades: ParsedTrade[],
  chamber: 'house' | 'senate',
  filterYear: number | null,
  dryRun: boolean,
): Promise<{
  tradesOk: number;
  tradesErr: number;
  relsOk: number;
  relsErr: number;
}> {
  let tradesOk = 0;
  let tradesErr = 0;
  let relsOk = 0;
  let relsErr = 0;

  const tradeBatch: StockTradeInsert[] = [];
  const relBatch: RelationshipInsert[] = [];

  let skippedNoOfficial = 0;
  let skippedBadType = 0;
  let skippedBadDates = 0;
  let skippedWrongYear = 0;
  let processed = 0;

  console.log(`  Processing ${trades.length} ${chamber} trade record(s) ...`);

  for (const trade of trades) {
    processed++;

    // --- Year filter ---
    if (filterYear !== null && trade.tradeDate) {
      if (!trade.tradeDate.startsWith(String(filterYear))) {
        skippedWrongYear++;
        continue;
      }
    }

    // --- Require both dates (schema has NOT NULL on both) ---
    if (!trade.tradeDate || !trade.disclosureDate) {
      skippedBadDates++;
      continue;
    }

    // --- Resolve official ---
    if (!trade.memberName) {
      skippedNoOfficial++;
      continue;
    }

    const officialId = await resolveOfficialId(trade.memberName);
    if (!officialId) {
      skippedNoOfficial++;
      if (skippedNoOfficial <= 5) {
        console.warn(
          `\n  WARN: No official match for "${trade.memberName}" — skipping`,
        );
      }
      continue;
    }

    // --- Trade type ---
    const tradeType = normaliseTradeType(trade.rawTradeType);
    if (!tradeType) {
      skippedBadType++;
      if (skippedBadType <= 5) {
        console.warn(
          `\n  WARN: Unrecognised trade type "${trade.rawTradeType ?? ''}" — skipping`,
        );
      }
      continue;
    }

    // --- Amount ---
    const { low: amountLow, high: amountHigh } = parseAmountRange(trade.rawAmount);

    // --- Resolve corporate entity (for relationship graph) ---
    const corpEntityId = await resolveCorpEntityId(trade.ticker);
    const officialEntityId = await resolveOfficialEntityId(officialId);

    // --- Build stock_trades insert ---
    const tradeInsert: StockTradeInsert = {
      official_id: officialId,
      ticker: trade.ticker,
      asset_name: trade.assetName,
      trade_type: tradeType,
      amount_range_low: amountLow,
      amount_range_high: amountHigh,
      trade_date: trade.tradeDate,
      disclosure_date: trade.disclosureDate,
      filing_url: trade.filingUrl,
      metadata: {
        chamber,
        raw_name: trade.memberName,
        doc_id: trade.docId,
        raw_trade_type: trade.rawTradeType,
        raw_amount: trade.rawAmount,
      },
    };

    tradeBatch.push(tradeInsert);

    // --- Build relationship insert ---
    if (corpEntityId && officialEntityId) {
      const relAmount =
        amountLow !== null && amountHigh !== null
          ? Math.round((amountLow + amountHigh) / 2)
          : (amountLow ?? null);

      relBatch.push({
        source_entity_id: officialEntityId,
        target_entity_id: corpEntityId,
        relationship_type: 'traded',
        amount: relAmount,
        date_start: trade.tradeDate,
        metadata: { trade_type: tradeType, ticker: trade.ticker, chamber },
        confidence_score: 1.0,
      });
    }

    // --- Flush trade batch ---
    if (tradeBatch.length >= BATCH_SIZE) {
      const { ok, err } = await flushTrades(tradeBatch.splice(0, BATCH_SIZE), dryRun);
      tradesOk += ok;
      tradesErr += err;
      process.stdout.write(`\n  Flushed trade batch (ok=${ok}, err=${err})\n`);
    }

    // --- Flush relationship batch ---
    if (relBatch.length >= BATCH_SIZE) {
      const { ok, err } = await flushRelationships(relBatch.splice(0, BATCH_SIZE), dryRun);
      relsOk += ok;
      relsErr += err;
    }

    // Progress dot every record (matches other importer pattern)
    process.stdout.write('.');
    if (processed % BATCH_SIZE === 0) {
      process.stdout.write(
        `  [${processed}] trades_ok=${tradesOk} err=${tradesErr}\n`,
      );
    }
  }

  // --- Flush final partial batches ---
  if (tradeBatch.length > 0) {
    const { ok, err } = await flushTrades(tradeBatch, dryRun);
    tradesOk += ok;
    tradesErr += err;
  }

  if (relBatch.length > 0) {
    const { ok, err } = await flushRelationships(relBatch, dryRun);
    relsOk += ok;
    relsErr += err;
  }

  process.stdout.write('\n');

  if (skippedWrongYear > 0)
    console.log(`  Skipped ${skippedWrongYear} ${chamber} record(s) outside target year.`);
  if (skippedBadDates > 0)
    console.log(`  Skipped ${skippedBadDates} ${chamber} record(s) with missing date(s).`);
  if (skippedNoOfficial > 0)
    console.warn(
      `  WARN: ${skippedNoOfficial} ${chamber} record(s) skipped — no official match.`,
    );
  if (skippedBadType > 0)
    console.warn(
      `  WARN: ${skippedBadType} ${chamber} record(s) skipped — unrecognised trade type.`,
    );

  return { tradesOk, tradesErr, relsOk, relsErr };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importStockTrades(): Promise<void> {
  console.log('=== Import Congressional Stock Trades ===\n');
  console.log('  Sources:');
  console.log('    House: House Clerk FD ZIP index (disclosures-clerk.house.gov)');
  console.log('    Senate: efdsearch.senate.gov PTR search API\n');

  const dryRun = process.env['DRY_RUN'] === '1';
  const importYearRaw = process.env['IMPORT_YEAR'];
  const filterYear = importYearRaw
    ? Number(importYearRaw)
    : new Date().getFullYear();
  const chamberEnv = (process.env['IMPORT_CHAMBER'] ?? 'both').toLowerCase();

  if (!['house', 'senate', 'both'].includes(chamberEnv)) {
    throw new Error(
      `Invalid IMPORT_CHAMBER value "${chamberEnv}". Must be "house", "senate", or "both".`,
    );
  }

  const chambers: Array<'house' | 'senate'> =
    chamberEnv === 'both'
      ? ['house', 'senate']
      : [chamberEnv as 'house' | 'senate'];

  if (dryRun) {
    console.log('*** DRY RUN MODE — no database writes will be performed ***\n');
  }

  console.log(`Import year  : ${filterYear}`);
  console.log(`Chamber(s)   : ${chambers.join(', ')}\n`);

  // Pre-load officials for fast name resolution.
  await warmOfficialCaches();

  let totalTradesOk = 0;
  let totalTradesErr = 0;
  let totalRelsOk = 0;
  let totalRelsErr = 0;

  for (const chamber of chambers) {
    console.log(`\n--- ${chamber.toUpperCase()} (${filterYear}) ---`);

    let trades: ParsedTrade[] = [];

    if (chamber === 'house') {
      trades = await fetchAllHousePtrs(filterYear);
    } else {
      trades = await fetchAllSenatePtrs(filterYear);
    }

    if (trades.length === 0) {
      console.log(`  No ${chamber} trade records to process.`);
      continue;
    }

    const { tradesOk, tradesErr, relsOk, relsErr } = await processTrades(
      trades,
      chamber,
      filterYear,
      dryRun,
    );

    totalTradesOk += tradesOk;
    totalTradesErr += tradesErr;
    totalRelsOk += relsOk;
    totalRelsErr += relsErr;

    console.log(
      `  ${chamber.toUpperCase()} complete — trades ok=${tradesOk}, err=${tradesErr}; rels ok=${relsOk}, err=${relsErr}`,
    );
  }

  // --- Summary ---
  console.log('\n=== Import Complete ===');
  console.log(
    `  stock_trades  : inserted/updated ${totalTradesOk}, errors ${totalTradesErr}`,
  );
  console.log(
    `  relationships : inserted/updated ${totalRelsOk}, errors ${totalRelsErr}`,
  );
  if (dryRun) {
    console.log('\n  (DRY RUN — no rows were actually written)');
  }
}

importStockTrades().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
