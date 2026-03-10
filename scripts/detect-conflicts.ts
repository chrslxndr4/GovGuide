/**
 * Conflict Detection Engine
 *
 * Detects potential conflicts of interest for congressional stock trades by
 * cross-referencing trades against committee assignments, lobbying activity,
 * campaign donors, regulatory actions, and peer trading patterns.
 *
 * Eight rule-based detectors:
 *   1. committee_sector_overlap  — trade sector matches committee jurisdiction
 *   2. pre_vote_trading          — trade within 30 days before a vote on related legislation
 *   3. lobbying_trade_alignment  — official lobbied by same industry as trade sector
 *   4. donor_trade_correlation   — top donors share sector with trade
 *   5. regulatory_front_running  — trade before regulatory action on same sector
 *   6. insider_timing            — large trade combined with committee overlap or late filing
 *   7. unusual_frequency         — monthly trade count > 2σ above personal average
 *   8. bipartisan_consensus      — 3+ officials from both parties trade same ticker/direction within 14 days
 *
 * Required environment variables:
 *   PUBLIC_SUPABASE_URL       — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — Service-role key (bypasses RLS)
 *
 * Optional environment variables:
 *   CONFLICT_DAYS_BACK — Number of days of trades to analyse (default: 90)
 *   DRY_RUN            — Set to "true" or "1" to print without writing to DB
 *
 * Run with:  npm run detect:conflicts
 */

import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Environment / Supabase setup
// ---------------------------------------------------------------------------

const supabaseUrl = process.env['PUBLIC_SUPABASE_URL'];
const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];

if (!supabaseUrl) {
  throw new Error(
    'Missing environment variable: PUBLIC_SUPABASE_URL\n' +
      'Set it in your shell or pass --env-file=.env to tsx.',
  );
}
if (!serviceRoleKey) {
  throw new Error(
    'Missing environment variable: SUPABASE_SERVICE_ROLE_KEY\n' +
      'Set it in your shell or pass --env-file=.env to tsx.',
  );
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

const DAYS_BACK = parseInt(process.env['CONFLICT_DAYS_BACK'] ?? '90', 10);
const DRY_RUN =
  process.env['DRY_RUN'] === 'true' || process.env['DRY_RUN'] === '1';
const BATCH_SIZE = 250;

// ---------------------------------------------------------------------------
// Committee → sector / SIC mappings
// ---------------------------------------------------------------------------

/**
 * Maps partial committee name substrings (lower-case) to one or more SIC
 * ranges (inclusive) and/or sector label strings as used in ticker_metadata.
 */
interface CommitteeMapping {
  sic_ranges?: Array<[number, number]>;
  sectors?: string[];
}

const COMMITTEE_SECTOR_MAP: Record<string, CommitteeMapping> = {
  'armed services': {
    sic_ranges: [[3700, 3799]],
    sectors: ['Manufacturing'],
  },
  'energy and commerce': {
    sectors: ['Transportation & Utilities', 'Mining'],
  },
  'financial services': {
    sectors: ['Finance, Insurance & Real Estate', 'Finance', 'Insurance', 'Real Estate'],
  },
  agriculture: {
    sectors: ['Agriculture'],
  },
  'science, space': {
    sic_ranges: [[3720, 3729]],
    sectors: ['Manufacturing'],
  },
  technology: {
    sic_ranges: [[3720, 3729]],
    sectors: ['Manufacturing'],
  },
  health: {
    sic_ranges: [[8000, 8099]],
    sectors: ['Services'],
  },
  help: {
    sic_ranges: [[8000, 8099]],
    sectors: ['Services'],
  },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StockTrade {
  id: string;
  official_id: string;
  ticker: string | null;
  asset_name: string | null;
  trade_type: string;
  amount_range_low: number | null;
  amount_range_high: number | null;
  trade_date: string;
  disclosure_date: string | null;
  days_late: number | null;
  entity_id: string | null;
}

interface Official {
  id: string;
  full_name: string;
  party: string | null;
  metadata: Record<string, unknown> | null;
}

interface TickerMetadata {
  id: string;
  ticker: string;
  company_name: string | null;
  sic_code: string | null;
  sic_description: string | null;
  sector: string | null;
  exchange: string | null;
  cik: string | null;
}

interface Contribution {
  id: string;
  donor_entity_id: string;
  recipient_entity_id: string;
  amount: number | null;
  contribution_date: string | null;
  employer: string | null;
  occupation: string | null;
}

interface LobbyingActivity {
  id: string;
  registration_id: string;
  report_year: number | null;
  report_quarter: string | null;
  general_issues: string[] | null;
  bills_lobbied: string[] | null;
  agencies_contacted: string[] | null;
}

interface LobbyingRegistration {
  id: string;
  client_entity_id: string | null;
  general_issues: string[] | null;
  activities: LobbyingActivity[];
}

interface LawSource {
  id: string;
  type: string;
  title: string | null;
  subjects: string[] | null;
  metadata: Record<string, unknown> | null;
}

interface ConflictAlertInsert {
  alert_type: string;
  severity_score: number;
  title: string;
  description: string;
  entity_ids: string[];
  official_id: string;
  bill_id: string | null;
  evidence: Record<string, unknown>;
  detected_at: string;
  status: string;
}

interface TradeEnrichmentInsert {
  stock_trade_id: string;
  ticker_metadata_id: string | null;
  sector: string | null;
  committee_overlap: boolean;
  committee_names: string[];
  related_bill_ids: string[];
  related_lobbying_ids: string[];
  donor_overlap: boolean;
  donor_entity_ids: string[];
  regulatory_overlap: boolean;
  related_regulation_ids: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampSeverity(score: number): number {
  return Math.min(10, Math.max(0, Math.round(score * 10) / 10));
}

/** Returns the mid-point dollar amount of a trade range. */
function midAmount(trade: StockTrade): number {
  const low = trade.amount_range_low ?? 0;
  const high = trade.amount_range_high ?? low;
  return (low + high) / 2;
}

/**
 * Returns true if the ticker metadata matches a given committee mapping.
 * Checks both SIC code ranges and sector label strings.
 */
function tickerMatchesCommittee(
  tm: TickerMetadata,
  mapping: CommitteeMapping,
): boolean {
  const sic = tm.sic_code ? parseInt(tm.sic_code, 10) : null;
  const sector = (tm.sector ?? '').toLowerCase();

  if (mapping.sic_ranges && sic !== null && !isNaN(sic)) {
    for (const [lo, hi] of mapping.sic_ranges) {
      if (sic >= lo && sic <= hi) return true;
    }
  }

  if (mapping.sectors) {
    for (const s of mapping.sectors) {
      if (sector.includes(s.toLowerCase())) return true;
    }
  }

  return false;
}

/**
 * Returns the committee names from the official's metadata.committees array
 * that overlap with the trade's ticker sector.
 */
function committeeOverlap(
  official: Official,
  tm: TickerMetadata,
): string[] {
  const committees: string[] = [];
  const raw = official.metadata?.['committees'];
  if (!Array.isArray(raw)) return committees;

  for (const c of raw as string[]) {
    const lower = c.toLowerCase();
    for (const [keyword, mapping] of Object.entries(COMMITTEE_SECTOR_MAP)) {
      if (lower.includes(keyword) && tickerMatchesCommittee(tm, mapping)) {
        committees.push(c);
      }
    }
  }

  return [...new Set(committees)];
}

/**
 * Checks whether a sector string loosely matches a list of issue keywords
 * (used for lobbying general_issues and bill subjects).
 */
function sectorMatchesIssues(
  sector: string | null,
  issues: string[] | null,
): boolean {
  if (!sector || !issues || issues.length === 0) return false;
  const sectorLower = sector.toLowerCase();

  const SECTOR_KEYWORDS: Record<string, string[]> = {
    'agriculture': ['agriculture', 'farming', 'food', 'crop'],
    'mining': ['energy', 'mining', 'oil', 'gas', 'coal', 'petroleum'],
    'manufacturing': ['defense', 'aerospace', 'aviation', 'manufacturing', 'technology', 'semiconductor'],
    'transportation & utilities': ['energy', 'utilities', 'transportation', 'electric', 'pipeline'],
    'finance, insurance & real estate': ['finance', 'banking', 'insurance', 'mortgage', 'securities'],
    'finance': ['finance', 'banking', 'investment', 'securities'],
    'insurance': ['insurance', 'health insurance'],
    'real estate': ['real estate', 'housing', 'mortgage'],
    'services': ['health', 'healthcare', 'hospital', 'medical', 'education'],
    'retail trade': ['retail', 'trade', 'consumer'],
    'wholesale trade': ['wholesale', 'trade'],
    'construction': ['construction', 'infrastructure', 'housing'],
  };

  const keywords =
    Object.entries(SECTOR_KEYWORDS).find(([k]) =>
      sectorLower.includes(k),
    )?.[1] ?? [sectorLower.split(',')[0].trim()];

  for (const issue of issues) {
    const issueLower = issue.toLowerCase();
    for (const kw of keywords) {
      if (issueLower.includes(kw)) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface SupportingData {
  tickerMap: Map<string, TickerMetadata>;           // ticker → metadata
  officialMap: Map<string, Official>;               // official_id → official
  contributions: Contribution[];
  lobbyingRegistrations: LobbyingRegistration[];
  billLawSources: LawSource[];
  regulationLawSources: LawSource[];
}

async function loadSupportingData(): Promise<SupportingData> {
  console.log('Loading supporting data...');

  // Ticker metadata
  const { data: tickerRows, error: tickerErr } = await supabase
    .from('ticker_metadata')
    .select('id, ticker, company_name, sic_code, sic_description, sector, exchange, cik');
  if (tickerErr) console.warn('  ticker_metadata load error:', tickerErr.message);
  const tickerMap = new Map<string, TickerMetadata>();
  for (const row of tickerRows ?? []) {
    tickerMap.set(row.ticker, row as TickerMetadata);
  }
  console.log(`  Loaded ${tickerMap.size} ticker metadata records.`);

  // Officials (congressional — with metadata.committees)
  const { data: officialRows, error: offErr } = await supabase
    .from('officials')
    .select('id, full_name, party, metadata');
  if (offErr) console.warn('  officials load error:', offErr.message);
  const officialMap = new Map<string, Official>();
  for (const row of officialRows ?? []) {
    officialMap.set(row.id, row as Official);
  }
  console.log(`  Loaded ${officialMap.size} officials.`);

  // Contributions
  const { data: contribRows, error: contribErr } = await supabase
    .from('contributions')
    .select('id, donor_entity_id, recipient_entity_id, amount, contribution_date, employer, occupation')
    .order('amount', { ascending: false })
    .limit(50000);
  if (contribErr) console.warn('  contributions load error:', contribErr.message);
  const contributions = (contribRows ?? []) as Contribution[];
  console.log(`  Loaded ${contributions.length} contribution records.`);

  // Lobbying registrations + their activities
  const { data: lobbyRegs, error: lobbyErr } = await supabase
    .from('lobbying_registrations')
    .select('id, client_entity_id, general_issues')
    .limit(10000);
  if (lobbyErr) console.warn('  lobbying_registrations load error:', lobbyErr.message);

  const { data: lobbyActs, error: actErr } = await supabase
    .from('lobbying_activities')
    .select('id, registration_id, report_year, report_quarter, general_issues, bills_lobbied, agencies_contacted')
    .limit(50000);
  if (actErr) console.warn('  lobbying_activities load error:', actErr.message);

  // Group activities by registration_id
  const actsByReg = new Map<string, LobbyingActivity[]>();
  for (const act of (lobbyActs ?? []) as LobbyingActivity[]) {
    const list = actsByReg.get(act.registration_id) ?? [];
    list.push(act);
    actsByReg.set(act.registration_id, list);
  }
  const lobbyingRegistrations: LobbyingRegistration[] = ((lobbyRegs ?? []) as Array<{
    id: string;
    client_entity_id: string | null;
    general_issues: string[] | null;
  }>).map((r) => ({
    ...r,
    activities: actsByReg.get(r.id) ?? [],
  }));
  console.log(`  Loaded ${lobbyingRegistrations.length} lobbying registrations.`);

  // Law sources — bills and regulations separately
  const { data: billRows, error: billErr } = await supabase
    .from('law_sources')
    .select('id, type, title, subjects, metadata')
    .in('type', ['bill', 'resolution', 'act'])
    .order('metadata->introduced_date', { ascending: false })
    .limit(5000);
  if (billErr) console.warn('  law_sources (bills) load error:', billErr.message);
  const billLawSources = (billRows ?? []) as LawSource[];

  const { data: regRows, error: regErr } = await supabase
    .from('law_sources')
    .select('id, type, title, subjects, metadata')
    .in('type', ['regulation', 'rule', 'proposed_rule', 'notice'])
    .order('metadata->published_at', { ascending: false })
    .limit(5000);
  if (regErr) console.warn('  law_sources (regulations) load error:', regErr.message);
  const regulationLawSources = (regRows ?? []) as LawSource[];

  console.log(
    `  Loaded ${billLawSources.length} bills and ${regulationLawSources.length} regulations.`,
  );

  return {
    tickerMap,
    officialMap,
    contributions,
    lobbyingRegistrations,
    billLawSources,
    regulationLawSources,
  };
}

// ---------------------------------------------------------------------------
// Detector 1: committee_sector_overlap
// ---------------------------------------------------------------------------

interface DetectorResult {
  alerts: ConflictAlertInsert[];
  enrichmentPatch: Partial<TradeEnrichmentInsert>;
}

function detectCommitteeSectorOverlap(
  trade: StockTrade,
  official: Official,
  tm: TickerMetadata,
): DetectorResult | null {
  const matchedCommittees = committeeOverlap(official, tm);
  if (matchedCommittees.length === 0) return null;

  const mid = midAmount(trade);
  let severity = 5;
  if (mid > 50_000) severity += 1;
  if (mid > 250_000) severity += 1;

  const alert: ConflictAlertInsert = {
    alert_type: 'stock_committee',
    severity_score: clampSeverity(severity),
    title: `Committee-Sector Trade: ${official.full_name} — ${trade.ticker ?? trade.asset_name}`,
    description:
      `${official.full_name} traded ${trade.ticker ?? trade.asset_name} ` +
      `(${tm.sector ?? 'unknown sector'}) while serving on ` +
      `${matchedCommittees.join(', ')}.`,
    entity_ids: [trade.official_id, ...(trade.entity_id ? [trade.entity_id] : [])],
    official_id: trade.official_id,
    bill_id: null,
    evidence: {
      trade_id: trade.id,
      ticker: trade.ticker,
      asset_name: trade.asset_name,
      sector: tm.sector,
      sic_code: tm.sic_code,
      committees: matchedCommittees,
      trade_date: trade.trade_date,
      amount_mid: mid,
    },
    detected_at: new Date().toISOString(),
    status: 'active',
  };

  return {
    alerts: [alert],
    enrichmentPatch: {
      committee_overlap: true,
      committee_names: matchedCommittees,
    },
  };
}

// ---------------------------------------------------------------------------
// Detector 2: pre_vote_trading
// ---------------------------------------------------------------------------

function detectPreVoteTrading(
  trade: StockTrade,
  official: Official,
  tm: TickerMetadata,
  billLawSources: LawSource[],
): DetectorResult | null {
  if (!trade.trade_date) return null;

  const tradeMs = new Date(trade.trade_date).getTime();
  const windowMs = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

  const matchedBills: LawSource[] = [];

  for (const bill of billLawSources) {
    // Get the vote/action date from metadata
    const voteDate =
      (bill.metadata?.['vote_date'] as string | undefined) ??
      (bill.metadata?.['action_date'] as string | undefined) ??
      (bill.metadata?.['introduced_date'] as string | undefined);

    if (!voteDate) continue;

    const voteDateMs = new Date(voteDate).getTime();

    // Trade must be within 30 days before the vote
    if (tradeMs >= voteDateMs - windowMs && tradeMs < voteDateMs) {
      // Check if bill subjects overlap with trade sector
      if (sectorMatchesIssues(tm.sector, bill.subjects)) {
        matchedBills.push(bill);
      }
    }
  }

  if (matchedBills.length === 0) return null;

  let severity = 6;
  // +1 per additional signal beyond the first
  if (matchedBills.length > 1) severity += Math.min(matchedBills.length - 1, 2);

  const alerts: ConflictAlertInsert[] = matchedBills.map((bill) => ({
    alert_type: 'trade_timing',
    severity_score: clampSeverity(severity),
    title: `Pre-Vote Trade: ${official.full_name} — ${trade.ticker ?? trade.asset_name}`,
    description:
      `${official.full_name} ${trade.trade_type}d ${trade.ticker ?? trade.asset_name} ` +
      `within 30 days before a vote on "${bill.title ?? bill.id}" ` +
      `(${tm.sector ?? 'unknown sector'}).`,
    entity_ids: [trade.official_id, ...(trade.entity_id ? [trade.entity_id] : [])],
    official_id: trade.official_id,
    bill_id: bill.id,
    evidence: {
      trade_id: trade.id,
      ticker: trade.ticker,
      asset_name: trade.asset_name,
      trade_date: trade.trade_date,
      sector: tm.sector,
      bill_id: bill.id,
      bill_title: bill.title,
      bill_subjects: bill.subjects,
    },
    detected_at: new Date().toISOString(),
    status: 'active',
  }));

  return {
    alerts,
    enrichmentPatch: {
      related_bill_ids: matchedBills.map((b) => b.id),
    },
  };
}

// ---------------------------------------------------------------------------
// Detector 3: lobbying_trade_alignment
// ---------------------------------------------------------------------------

function detectLobbyingTradeAlignment(
  trade: StockTrade,
  official: Official,
  tm: TickerMetadata,
  lobbyingRegistrations: LobbyingRegistration[],
): DetectorResult | null {
  const matchedRegIds: string[] = [];

  for (const reg of lobbyingRegistrations) {
    // Check registration-level general_issues
    const regMatch = sectorMatchesIssues(tm.sector, reg.general_issues);
    // Check activity-level general_issues
    const actMatch = reg.activities.some((act) =>
      sectorMatchesIssues(tm.sector, act.general_issues),
    );

    if (regMatch || actMatch) {
      matchedRegIds.push(reg.id);
    }
  }

  if (matchedRegIds.length === 0) return null;

  const alert: ConflictAlertInsert = {
    alert_type: 'stock_committee',
    severity_score: clampSeverity(4),
    title: `Lobbying-Trade Alignment: ${official.full_name} — ${trade.ticker ?? trade.asset_name}`,
    description:
      `${official.full_name} traded ${trade.ticker ?? trade.asset_name} ` +
      `(${tm.sector ?? 'unknown sector'}) while the same sector was actively lobbying Congress ` +
      `(${matchedRegIds.length} matching registration${matchedRegIds.length > 1 ? 's' : ''}).`,
    entity_ids: [trade.official_id, ...(trade.entity_id ? [trade.entity_id] : [])],
    official_id: trade.official_id,
    bill_id: null,
    evidence: {
      trade_id: trade.id,
      ticker: trade.ticker,
      asset_name: trade.asset_name,
      sector: tm.sector,
      trade_date: trade.trade_date,
      lobbying_registration_ids: matchedRegIds.slice(0, 20),
      lobbying_count: matchedRegIds.length,
    },
    detected_at: new Date().toISOString(),
    status: 'active',
  };

  return {
    alerts: [alert],
    enrichmentPatch: {
      related_lobbying_ids: matchedRegIds.slice(0, 50),
    },
  };
}

// ---------------------------------------------------------------------------
// Detector 4: donor_trade_correlation
// ---------------------------------------------------------------------------

function detectDonorTradeCorrelation(
  trade: StockTrade,
  official: Official,
  tm: TickerMetadata,
  contributions: Contribution[],
): DetectorResult | null {
  // Find contributions where recipient is the official's entity
  // (official_id is an officials row id; contributions use entity ids, so we
  // match via trade.official_id which maps to official.id, but the entity_id
  // on the trade may link the two — we use official_id as a best-effort match
  // since the schema doesn't guarantee an entity_id on officials directly)
  const officialContribs = contributions.filter(
    (c) => c.recipient_entity_id === trade.official_id,
  );

  if (officialContribs.length === 0) return null;

  // Check if any donor's employer/occupation matches the trade sector
  const matchingDonorIds: string[] = [];
  for (const contrib of officialContribs) {
    const combined = `${contrib.employer ?? ''} ${contrib.occupation ?? ''}`.toLowerCase();
    if (sectorMatchesIssues(tm.sector, [combined])) {
      matchingDonorIds.push(contrib.donor_entity_id);
    }
  }

  if (matchingDonorIds.length === 0) return null;

  const alert: ConflictAlertInsert = {
    alert_type: 'donor_vote',
    severity_score: clampSeverity(4),
    title: `Donor-Trade Correlation: ${official.full_name} — ${trade.ticker ?? trade.asset_name}`,
    description:
      `${official.full_name} traded ${trade.ticker ?? trade.asset_name} ` +
      `(${tm.sector ?? 'unknown sector'}) and received campaign contributions from ` +
      `${matchingDonorIds.length} donor(s) in the same sector.`,
    entity_ids: [
      trade.official_id,
      ...(trade.entity_id ? [trade.entity_id] : []),
      ...matchingDonorIds.slice(0, 10),
    ],
    official_id: trade.official_id,
    bill_id: null,
    evidence: {
      trade_id: trade.id,
      ticker: trade.ticker,
      asset_name: trade.asset_name,
      sector: tm.sector,
      trade_date: trade.trade_date,
      matching_donor_count: matchingDonorIds.length,
      matching_donor_entity_ids: matchingDonorIds.slice(0, 20),
    },
    detected_at: new Date().toISOString(),
    status: 'active',
  };

  return {
    alerts: [alert],
    enrichmentPatch: {
      donor_overlap: true,
      donor_entity_ids: matchingDonorIds.slice(0, 50),
    },
  };
}

// ---------------------------------------------------------------------------
// Detector 5: regulatory_front_running
// ---------------------------------------------------------------------------

function detectRegulatoryFrontRunning(
  trade: StockTrade,
  official: Official,
  tm: TickerMetadata,
  regulationLawSources: LawSource[],
): DetectorResult | null {
  if (!trade.trade_date) return null;

  const tradeMs = new Date(trade.trade_date).getTime();
  const windowMs = 60 * 24 * 60 * 60 * 1000; // look 60 days ahead for regulatory action

  const matchedRegs: LawSource[] = [];

  for (const reg of regulationLawSources) {
    const pubDate =
      (reg.metadata?.['published_at'] as string | undefined) ??
      (reg.metadata?.['effective_date'] as string | undefined) ??
      (reg.metadata?.['date'] as string | undefined);

    if (!pubDate) continue;

    const pubMs = new Date(pubDate).getTime();

    // Trade must be before the regulation (within 60-day window)
    if (tradeMs < pubMs && pubMs <= tradeMs + windowMs) {
      if (
        sectorMatchesIssues(tm.sector, reg.subjects) ||
        sectorMatchesIssues(tm.sector, [reg.title ?? ''])
      ) {
        matchedRegs.push(reg);
      }
    }
  }

  if (matchedRegs.length === 0) return null;

  const alert: ConflictAlertInsert = {
    alert_type: 'trade_timing',
    severity_score: clampSeverity(6),
    title: `Regulatory Front-Running: ${official.full_name} — ${trade.ticker ?? trade.asset_name}`,
    description:
      `${official.full_name} ${trade.trade_type}d ${trade.ticker ?? trade.asset_name} ` +
      `(${tm.sector ?? 'unknown sector'}) before a regulatory action affecting the same sector ` +
      `("${matchedRegs[0].title ?? matchedRegs[0].id}").`,
    entity_ids: [trade.official_id, ...(trade.entity_id ? [trade.entity_id] : [])],
    official_id: trade.official_id,
    bill_id: null,
    evidence: {
      trade_id: trade.id,
      ticker: trade.ticker,
      asset_name: trade.asset_name,
      sector: tm.sector,
      trade_date: trade.trade_date,
      regulatory_action_ids: matchedRegs.map((r) => r.id).slice(0, 10),
      regulatory_action_titles: matchedRegs.map((r) => r.title).slice(0, 10),
    },
    detected_at: new Date().toISOString(),
    status: 'active',
  };

  return {
    alerts: [alert],
    enrichmentPatch: {
      regulatory_overlap: true,
      related_regulation_ids: matchedRegs.map((r) => r.id).slice(0, 50),
    },
  };
}

// ---------------------------------------------------------------------------
// Detector 6: insider_timing
// ---------------------------------------------------------------------------

function detectInsiderTiming(
  trade: StockTrade,
  official: Official,
  committeeHit: boolean,
): DetectorResult | null {
  const high = trade.amount_range_high ?? 0;
  if (high <= 100_000) return null;

  const lateFiling = (trade.days_late ?? 0) > 30;
  if (!committeeHit && !lateFiling) return null;

  const signals: string[] = [];
  if (committeeHit) signals.push('committee sector overlap');
  if (lateFiling) signals.push(`filed ${trade.days_late} days late`);

  const alert: ConflictAlertInsert = {
    alert_type: 'trade_timing',
    severity_score: clampSeverity(3 + signals.length),
    title: `Insider Timing Signal: ${official.full_name} — ${trade.ticker ?? trade.asset_name}`,
    description:
      `${official.full_name} made a large trade of ${trade.ticker ?? trade.asset_name} ` +
      `(≥$${high.toLocaleString()}) with additional signals: ${signals.join('; ')}.`,
    entity_ids: [trade.official_id, ...(trade.entity_id ? [trade.entity_id] : [])],
    official_id: trade.official_id,
    bill_id: null,
    evidence: {
      trade_id: trade.id,
      ticker: trade.ticker,
      asset_name: trade.asset_name,
      trade_date: trade.trade_date,
      amount_range_high: high,
      days_late: trade.days_late,
      committee_overlap: committeeHit,
      late_filing: lateFiling,
      signals,
    },
    detected_at: new Date().toISOString(),
    status: 'active',
  };

  return { alerts: [alert], enrichmentPatch: {} };
}

// ---------------------------------------------------------------------------
// Detector 7: unusual_frequency
// ---------------------------------------------------------------------------

interface FrequencyAlert {
  official_id: string;
  official_name: string;
  year_month: string;
  trade_count: number;
  mean: number;
  stddev: number;
  sigma: number;
}

function detectUnusualFrequency(trades: StockTrade[], officialMap: Map<string, Official>): FrequencyAlert[] {
  // Build monthly trade counts per official
  type MonthKey = string; // "officialId::YYYY-MM"
  const countMap = new Map<MonthKey, number>();

  for (const trade of trades) {
    if (!trade.trade_date) continue;
    const ym = trade.trade_date.slice(0, 7); // "YYYY-MM"
    const key = `${trade.official_id}::${ym}`;
    countMap.set(key, (countMap.get(key) ?? 0) + 1);
  }

  // Group by official
  const byOfficial = new Map<string, Array<{ ym: string; count: number }>>();
  for (const [key, count] of countMap) {
    const [officialId, ym] = key.split('::');
    const list = byOfficial.get(officialId) ?? [];
    list.push({ ym, count });
    byOfficial.set(officialId, list);
  }

  const results: FrequencyAlert[] = [];

  for (const [officialId, months] of byOfficial) {
    if (months.length < 3) continue; // need at least 3 months of history

    const counts = months.map((m) => m.count);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    const variance =
      counts.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / counts.length;
    const stddev = Math.sqrt(variance);

    if (stddev === 0) continue;

    const official = officialMap.get(officialId);

    for (const { ym, count } of months) {
      const sigma = (count - mean) / stddev;
      if (sigma >= 2) {
        results.push({
          official_id: officialId,
          official_name: official?.full_name ?? officialId,
          year_month: ym,
          trade_count: count,
          mean,
          stddev,
          sigma,
        });
      }
    }
  }

  return results;
}

function buildUnusualFrequencyAlerts(
  freqAlerts: FrequencyAlert[],
): ConflictAlertInsert[] {
  return freqAlerts.map((fa) => {
    const sigmaBonus = fa.sigma >= 3 ? 2 : 0;
    return {
      alert_type: 'trade_timing',
      severity_score: clampSeverity(3 + sigmaBonus),
      title: `Unusual Trading Frequency: ${fa.official_name} (${fa.year_month})`,
      description:
        `${fa.official_name} made ${fa.trade_count} trades in ${fa.year_month}, ` +
        `${fa.sigma.toFixed(1)}σ above their personal average of ` +
        `${fa.mean.toFixed(1)} trades/month (σ = ${fa.stddev.toFixed(1)}).`,
      entity_ids: [fa.official_id],
      official_id: fa.official_id,
      bill_id: null,
      evidence: {
        year_month: fa.year_month,
        trade_count: fa.trade_count,
        mean_monthly: fa.mean,
        stddev: fa.stddev,
        sigma: fa.sigma,
      },
      detected_at: new Date().toISOString(),
      status: 'active',
    };
  });
}

// ---------------------------------------------------------------------------
// Detector 8: bipartisan_consensus
// ---------------------------------------------------------------------------

interface BipartisanGroup {
  ticker: string;
  trade_type: string;
  window_start: string;
  officials: Array<{ official_id: string; full_name: string; party: string; trade_id: string }>;
  party_set: Set<string>;
}

function detectBipartisanConsensus(
  trades: StockTrade[],
  officialMap: Map<string, Official>,
): ConflictAlertInsert[] {
  const WINDOW_DAYS = 14;
  const windowMs = WINDOW_DAYS * 24 * 60 * 60 * 1000;

  // Group trades by ticker + trade_type (buy vs sell)
  type GroupKey = string; // "TICKER::trade_type"
  const grouped = new Map<GroupKey, StockTrade[]>();

  for (const trade of trades) {
    if (!trade.ticker || !trade.trade_date) continue;
    const key = `${trade.ticker.toUpperCase()}::${trade.trade_type}`;
    const list = grouped.get(key) ?? [];
    list.push(trade);
    grouped.set(key, list);
  }

  const alerts: ConflictAlertInsert[] = [];

  for (const [key, group] of grouped) {
    if (group.length < 3) continue;

    // Sort by trade_date
    const sorted = [...group].sort(
      (a, b) => new Date(a.trade_date).getTime() - new Date(b.trade_date).getTime(),
    );

    // Sliding window to find clusters of >= 3 officials from >= 2 parties
    for (let i = 0; i < sorted.length; i++) {
      const windowStart = new Date(sorted[i].trade_date).getTime();
      const windowEnd = windowStart + windowMs;

      const inWindow = sorted.filter(
        (t) =>
          new Date(t.trade_date).getTime() >= windowStart &&
          new Date(t.trade_date).getTime() <= windowEnd,
      );

      if (inWindow.length < 3) continue;

      // Deduplicate by official (keep one trade per official in window)
      const officialsSeen = new Set<string>();
      const uniqueTrades: StockTrade[] = [];
      for (const t of inWindow) {
        if (!officialsSeen.has(t.official_id)) {
          officialsSeen.add(t.official_id);
          uniqueTrades.push(t);
        }
      }

      if (uniqueTrades.length < 3) continue;

      const partySet = new Set<string>();
      const officialDetails: BipartisanGroup['officials'] = [];

      for (const t of uniqueTrades) {
        const off = officialMap.get(t.official_id);
        const party = off?.party ?? 'unknown';
        partySet.add(party);
        officialDetails.push({
          official_id: t.official_id,
          full_name: off?.full_name ?? t.official_id,
          party,
          trade_id: t.id,
        });
      }

      // Must span at least 2 parties (bipartisan)
      if (partySet.size < 2) continue;

      const [ticker, tradeType] = key.split('::');
      const dedupKey = `bipartisan::${ticker}::${tradeType}::${sorted[i].trade_date}`;

      alerts.push({
        alert_type: 'stock_committee',
        severity_score: clampSeverity(7),
        title: `Bipartisan Consensus Trade: ${ticker} (${tradeType})`,
        description:
          `${uniqueTrades.length} officials from ${partySet.size} parties all ` +
          `${tradeType}d ${ticker} within a 14-day window starting ${sorted[i].trade_date}. ` +
          `Officials: ${officialDetails.map((o) => o.full_name).join(', ')}.`,
        entity_ids: uniqueTrades.map((t) => t.official_id),
        official_id: uniqueTrades[0].official_id,
        bill_id: null,
        evidence: {
          dedupKey,
          ticker,
          trade_type: tradeType,
          window_start: sorted[i].trade_date,
          official_count: uniqueTrades.length,
          parties: [...partySet],
          officials: officialDetails,
          trade_ids: uniqueTrades.map((t) => t.id),
        },
        detected_at: new Date().toISOString(),
        status: 'active',
      });

      // Advance past this cluster to avoid duplicate alerts for overlapping windows
      i += uniqueTrades.length - 1;
    }
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// Duplicate check helper
// ---------------------------------------------------------------------------

async function existingAlertTradeIds(
  alertType: string,
  officialId: string,
): Promise<Set<string>> {
  const { data } = await supabase
    .from('conflict_alerts')
    .select('evidence')
    .eq('alert_type', alertType)
    .eq('official_id', officialId);

  const seen = new Set<string>();
  for (const row of data ?? []) {
    const ev = row.evidence as Record<string, unknown>;
    if (typeof ev?.['trade_id'] === 'string') seen.add(ev['trade_id']);
    if (Array.isArray(ev?.['trade_ids'])) {
      for (const id of ev['trade_ids'] as string[]) seen.add(id);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

async function upsertAlerts(alerts: ConflictAlertInsert[]): Promise<void> {
  if (alerts.length === 0) return;

  for (let i = 0; i < alerts.length; i += BATCH_SIZE) {
    const batch = alerts.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('conflict_alerts')
      .insert(batch);

    if (error) {
      console.error(
        `  Alert batch ${Math.floor(i / BATCH_SIZE) + 1} error:`,
        error.message,
      );
    } else {
      process.stdout.write(
        `  Upserted alerts ${Math.min(i + BATCH_SIZE, alerts.length)}/${alerts.length}\r`,
      );
    }
  }
  process.stdout.write('\n');
}

async function upsertEnrichments(
  enrichments: TradeEnrichmentInsert[],
): Promise<void> {
  if (enrichments.length === 0) return;

  for (let i = 0; i < enrichments.length; i += BATCH_SIZE) {
    const batch = enrichments.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from('trade_enrichments')
      .upsert(batch, { onConflict: 'stock_trade_id', ignoreDuplicates: false });

    if (error) {
      console.error(
        `  Enrichment batch ${Math.floor(i / BATCH_SIZE) + 1} error:`,
        error.message,
      );
    } else {
      process.stdout.write(
        `  Upserted enrichments ${Math.min(i + BATCH_SIZE, enrichments.length)}/${enrichments.length}\r`,
      );
    }
  }
  process.stdout.write('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== GovGuide Conflict Detection Engine ===');
  console.log(`  DRY_RUN: ${DRY_RUN}`);
  console.log(`  Days back: ${DAYS_BACK}`);
  console.log('');

  // ------------------------------------------------------------------
  // Load recent trades
  // ------------------------------------------------------------------
  const cutoffDate = new Date(
    Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000,
  ).toISOString().slice(0, 10);

  console.log(`Loading trades since ${cutoffDate}...`);
  const { data: tradeRows, error: tradeErr } = await supabase
    .from('stock_trades')
    .select(
      'id, official_id, ticker, asset_name, trade_type, amount_range_low, amount_range_high, trade_date, disclosure_date, days_late, entity_id',
    )
    .gte('trade_date', cutoffDate)
    .order('trade_date', { ascending: false });

  if (tradeErr) {
    console.error('Failed to load stock_trades:', tradeErr.message);
    process.exit(1);
  }

  const trades = (tradeRows ?? []) as StockTrade[];
  console.log(`  Loaded ${trades.length} trades.\n`);

  if (trades.length === 0) {
    console.log('No trades found in window. Exiting.');
    return;
  }

  // ------------------------------------------------------------------
  // Load supporting data
  // ------------------------------------------------------------------
  const data = await loadSupportingData();
  console.log('');

  // ------------------------------------------------------------------
  // Per-trade detectors (1–6)
  // ------------------------------------------------------------------
  const allAlerts: ConflictAlertInsert[] = [];
  const enrichmentMap = new Map<string, TradeEnrichmentInsert>();

  // Pre-build duplicate cache: { alertType -> { officialId -> Set<tradeId> } }
  // We'll lazily populate this on first miss.
  const dupCache = new Map<string, Map<string, Set<string>>>();

  async function isDuplicate(
    alertType: string,
    officialId: string,
    tradeId: string,
  ): Promise<boolean> {
    let byOfficial = dupCache.get(alertType);
    if (!byOfficial) {
      byOfficial = new Map();
      dupCache.set(alertType, byOfficial);
    }
    let seen = byOfficial.get(officialId);
    if (!seen) {
      seen = await existingAlertTradeIds(alertType, officialId);
      byOfficial.set(officialId, seen);
    }
    return seen.has(tradeId);
  }

  let processed = 0;

  for (const trade of trades) {
    processed++;
    if (processed % 100 === 0) {
      process.stdout.write(`  Processing trade ${processed}/${trades.length}\r`);
    }

    const official = data.officialMap.get(trade.official_id);
    if (!official) continue;

    const tm = trade.ticker ? data.tickerMap.get(trade.ticker) : undefined;
    if (!tm) continue; // No ticker metadata — skip sector-dependent detectors

    // Initialise enrichment record for this trade
    if (!enrichmentMap.has(trade.id)) {
      enrichmentMap.set(trade.id, {
        stock_trade_id: trade.id,
        ticker_metadata_id: tm.id,
        sector: tm.sector ?? null,
        committee_overlap: false,
        committee_names: [],
        related_bill_ids: [],
        related_lobbying_ids: [],
        donor_overlap: false,
        donor_entity_ids: [],
        regulatory_overlap: false,
        related_regulation_ids: [],
      });
    }

    const enrichment = enrichmentMap.get(trade.id)!;

    // Helper: accumulate enrichment patches
    function applyPatch(patch: Partial<TradeEnrichmentInsert>) {
      if (patch.committee_overlap) enrichment.committee_overlap = true;
      if (patch.committee_names?.length) {
        enrichment.committee_names = [
          ...new Set([...enrichment.committee_names, ...patch.committee_names]),
        ];
      }
      if (patch.related_bill_ids?.length) {
        enrichment.related_bill_ids = [
          ...new Set([...enrichment.related_bill_ids, ...patch.related_bill_ids]),
        ];
      }
      if (patch.related_lobbying_ids?.length) {
        enrichment.related_lobbying_ids = [
          ...new Set([...enrichment.related_lobbying_ids, ...patch.related_lobbying_ids]),
        ];
      }
      if (patch.donor_overlap) enrichment.donor_overlap = true;
      if (patch.donor_entity_ids?.length) {
        enrichment.donor_entity_ids = [
          ...new Set([...enrichment.donor_entity_ids, ...patch.donor_entity_ids]),
        ];
      }
      if (patch.regulatory_overlap) enrichment.regulatory_overlap = true;
      if (patch.related_regulation_ids?.length) {
        enrichment.related_regulation_ids = [
          ...new Set([...enrichment.related_regulation_ids, ...patch.related_regulation_ids]),
        ];
      }
    }

    // Detector 1: committee_sector_overlap
    const r1 = detectCommitteeSectorOverlap(trade, official, tm);
    if (r1) {
      applyPatch(r1.enrichmentPatch);
      for (const a of r1.alerts) {
        if (!(await isDuplicate(a.alert_type, trade.official_id, trade.id))) {
          allAlerts.push(a);
        }
      }
    }

    // Detector 2: pre_vote_trading
    const r2 = detectPreVoteTrading(trade, official, tm, data.billLawSources);
    if (r2) {
      applyPatch(r2.enrichmentPatch);
      for (const a of r2.alerts) {
        if (!(await isDuplicate(a.alert_type, trade.official_id, trade.id))) {
          allAlerts.push(a);
        }
      }
    }

    // Detector 3: lobbying_trade_alignment
    const r3 = detectLobbyingTradeAlignment(
      trade,
      official,
      tm,
      data.lobbyingRegistrations,
    );
    if (r3) {
      applyPatch(r3.enrichmentPatch);
      for (const a of r3.alerts) {
        if (!(await isDuplicate(a.alert_type, trade.official_id, trade.id))) {
          allAlerts.push(a);
        }
      }
    }

    // Detector 4: donor_trade_correlation
    const r4 = detectDonorTradeCorrelation(
      trade,
      official,
      tm,
      data.contributions,
    );
    if (r4) {
      applyPatch(r4.enrichmentPatch);
      for (const a of r4.alerts) {
        if (!(await isDuplicate(a.alert_type, trade.official_id, trade.id))) {
          allAlerts.push(a);
        }
      }
    }

    // Detector 5: regulatory_front_running
    const r5 = detectRegulatoryFrontRunning(
      trade,
      official,
      tm,
      data.regulationLawSources,
    );
    if (r5) {
      applyPatch(r5.enrichmentPatch);
      for (const a of r5.alerts) {
        if (!(await isDuplicate(a.alert_type, trade.official_id, trade.id))) {
          allAlerts.push(a);
        }
      }
    }

    // Detector 6: insider_timing
    const r6 = detectInsiderTiming(trade, official, enrichment.committee_overlap);
    if (r6) {
      for (const a of r6.alerts) {
        if (!(await isDuplicate(a.alert_type, trade.official_id, trade.id))) {
          allAlerts.push(a);
        }
      }
    }
  }

  process.stdout.write(`  Processed ${trades.length}/${trades.length} trades.\n\n`);

  // ------------------------------------------------------------------
  // Detector 7: unusual_frequency (cross-trade, no per-trade enrichment)
  // ------------------------------------------------------------------
  console.log('Detecting unusual trading frequency...');
  const freqResults = detectUnusualFrequency(trades, data.officialMap);
  const freqAlerts = buildUnusualFrequencyAlerts(freqResults);
  console.log(`  Found ${freqAlerts.length} unusual frequency alerts.`);
  allAlerts.push(...freqAlerts);

  // ------------------------------------------------------------------
  // Detector 8: bipartisan_consensus
  // ------------------------------------------------------------------
  console.log('Detecting bipartisan consensus trades...');
  const bipartisanAlerts = detectBipartisanConsensus(trades, data.officialMap);
  console.log(`  Found ${bipartisanAlerts.length} bipartisan consensus alerts.`);
  allAlerts.push(...bipartisanAlerts);

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  const countByType = allAlerts.reduce<Record<string, number>>((acc, a) => {
    acc[a.alert_type] = (acc[a.alert_type] ?? 0) + 1;
    return acc;
  }, {});

  console.log('\n=== Detection Summary ===');
  console.log(`  committee_sector_overlap (stock_committee): ${countByType['stock_committee'] ?? 0}`);
  console.log(`  pre_vote_trading + insider_timing + reg_frontrunning + freq (trade_timing): ${countByType['trade_timing'] ?? 0}`);
  console.log(`  donor_trade_correlation (donor_vote): ${countByType['donor_vote'] ?? 0}`);
  console.log(`  Total new alerts: ${allAlerts.length}`);
  console.log(`  Total enrichment records: ${enrichmentMap.size}`);

  if (allAlerts.length === 0 && enrichmentMap.size === 0) {
    console.log('\nNo conflicts detected. Run import pipelines to populate source tables.');
    return;
  }

  // ------------------------------------------------------------------
  // Write to DB (or dry-run)
  // ------------------------------------------------------------------
  if (DRY_RUN) {
    console.log('\n[DRY_RUN] Skipping database writes.');
    console.log('Sample alerts (first 5):');
    for (const a of allAlerts.slice(0, 5)) {
      console.log(
        `  [${a.alert_type}] sev=${a.severity_score} "${a.title}"`,
      );
    }
    return;
  }

  console.log('\nWriting conflict alerts...');
  await upsertAlerts(allAlerts);

  console.log('Writing trade enrichments...');
  await upsertEnrichments([...enrichmentMap.values()]);

  console.log('\n=== Detection Complete ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
