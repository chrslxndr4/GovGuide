/**
 * Prediction Market Anomaly Detector
 *
 * Scans active prediction market contracts for patterns that may indicate
 * insider knowledge or coordinated manipulation. Four detectors are run:
 *
 *   1. volume_spike      — Single-contract 30-snapshot rolling σ spike
 *   2. price_dislocation — Flash probability move that quickly reverts
 *   3. whale_clustering  — 3+ contracts in same category all spike together
 *   4. timing_correlation — Market shift >10 pp within 72 hrs before a
 *                           political event recorded in law_sources
 *
 * Results are written to `prediction_anomalies`.  Any anomaly with
 * severity_score ≥ 6 also creates a `prediction_insider` entry in
 * `conflict_alerts`.
 *
 * Environment variables:
 *   PUBLIC_SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY    — Supabase service-role secret
 *   DRY_RUN=true                 — Print detections without writing to DB
 *
 * Run with:  npm run detect:predictions
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DRY_RUN = process.env['DRY_RUN'] === 'true';
const BATCH_SIZE = 200;

/** Minimum snapshots a contract must have before volume_spike runs. */
const VOLUME_SPIKE_MIN_SNAPSHOTS = 5;
/** Number of trailing snapshots used for rolling mean/stddev. */
const VOLUME_SPIKE_WINDOW = 30;
/** Standard-deviation multiplier to flag a spike. */
const VOLUME_SPIKE_SIGMA = 3;

/** Minimum recent snapshots for price_dislocation detection. */
const PRICE_DISLOC_MIN_SNAPSHOTS = 3;
/** Minimum probability delta (in 0-1 space) to qualify as a dislocation. */
const PRICE_DISLOC_THRESHOLD = 0.15;

/** Hours within which multiple contracts must spike for whale_clustering. */
const WHALE_CLUSTER_WINDOW_HRS = 48;
/** Minimum sigma above mean for a contract to count as "spiked" in clustering. */
const WHALE_CLUSTER_SIGMA = 2;
/** Minimum number of co-spiking contracts in a category to flag. */
const WHALE_CLUSTER_MIN_CONTRACTS = 3;

/** Hours BEFORE an event during which a probability shift is suspicious. */
const TIMING_LOOKBACK_HRS = 72;
/** Minimum probability shift (0-1) to flag timing correlation. */
const TIMING_SHIFT_THRESHOLD = 0.10;

/** Severity threshold above which a conflict_alert is also created. */
const CONFLICT_ALERT_MIN_SEVERITY = 6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PredictionContract {
  id: string;
  platform: string;
  platform_contract_id: string;
  question: string;
  category: string | null;
  subcategory: string | null;
  current_probability: number | null;
  volume_total: number | null;
  open_date: string | null;
  close_date: string | null;
  resolved: boolean;
  contract_url: string | null;
  metadata: Record<string, unknown> | null;
}

interface PredictionSnapshot {
  id: string;
  contract_id: string;
  snapshot_time: string;
  probability: number | null;
  volume_24h: number | null;
  metadata: Record<string, unknown> | null;
}

interface LawSource {
  id: string;
  title: string | null;
  type: string | null;
  subjects: string[] | null;
  introduced_date: string | null;
  enacted_date: string | null;
  published_at: string | null;
  effective_date: string | null;
}

interface AnomalyRecord {
  contract_id: string;
  anomaly_type: string;
  detection_time: string;
  description: string;
  severity_score: number;
  probability_before: number | null;
  probability_after: number | null;
  volume_before: number | null;
  volume_after: number | null;
  related_event: string | null;
  related_event_time: string | null;
  wallet_addresses: string[];
  metadata: Record<string, unknown>;
  status: string;
}

interface ConflictAlertRecord {
  alert_type: string;
  severity_score: number;
  title: string;
  description: string;
  entity_ids: string[];
  evidence: Record<string, unknown>;
  detected_at: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampSeverity(score: number): number {
  return Math.round(Math.min(10, Math.max(0, score)) * 10) / 10;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
  return Math.sqrt(variance);
}

/** Return the best available event date from a LawSource row. */
function bestEventDate(law: LawSource): string | null {
  return law.enacted_date ?? law.effective_date ?? law.published_at ?? law.introduced_date ?? null;
}

/** Returns a simple political-category label for a LawSource row. */
function lawCategory(law: LawSource): string {
  const t = (law.type ?? '').toLowerCase();
  if (t.includes('executive_order') || t.includes('executive order')) return 'policy';
  if (t.includes('regulation') || t.includes('rule')) return 'policy';
  if (t.includes('bill') || t.includes('law') || t.includes('statute')) return 'legislation';
  return 'policy';
}

function isPoliticalCategory(category: string | null): boolean {
  if (!category) return false;
  const lower = category.toLowerCase();
  return (
    lower.includes('election') ||
    lower.includes('politics') ||
    lower.includes('legislat') ||
    lower.includes('policy') ||
    lower.includes('geopolit') ||
    lower.includes('government')
  );
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

async function fetchActiveContracts(): Promise<PredictionContract[]> {
  const { data, error } = await supabase
    .from('prediction_contracts')
    .select('*')
    .eq('resolved', false);

  if (error) {
    throw new Error(`Failed to fetch active contracts: ${error.message}`);
  }
  return (data ?? []) as PredictionContract[];
}

async function fetchSnapshots(contractId: string, limit: number): Promise<PredictionSnapshot[]> {
  const { data, error } = await supabase
    .from('prediction_snapshots')
    .select('*')
    .eq('contract_id', contractId)
    .order('snapshot_time', { ascending: false })
    .limit(limit);

  if (error) {
    console.warn(`  WARNING: Could not fetch snapshots for contract ${contractId}: ${error.message}`);
    return [];
  }
  // Return in ascending order so index 0 is oldest.
  return ((data ?? []) as PredictionSnapshot[]).reverse();
}

async function fetchRecentLawSources(lookbackDays = 90): Promise<LawSource[]> {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  // Try several date columns since the schema may vary by law type.
  const { data, error } = await supabase
    .from('law_sources')
    .select('id, title, type, subjects, introduced_date, enacted_date, published_at, effective_date')
    .or(
      `enacted_date.gte.${since},effective_date.gte.${since},published_at.gte.${since},introduced_date.gte.${since}`,
    )
    .order('enacted_date', { ascending: false })
    .limit(500);

  if (error) {
    console.warn(`  WARNING: Could not fetch law_sources: ${error.message}`);
    return [];
  }
  return (data ?? []) as LawSource[];
}

// ---------------------------------------------------------------------------
// Detector 1: Volume Spike
// ---------------------------------------------------------------------------

function detectVolumeSpike(
  contract: PredictionContract,
  snapshots: PredictionSnapshot[],
): AnomalyRecord | null {
  if (snapshots.length < VOLUME_SPIKE_MIN_SNAPSHOTS) return null;

  const volumes = snapshots
    .map((s) => s.volume_24h)
    .filter((v): v is number => v !== null && v >= 0);

  if (volumes.length < VOLUME_SPIKE_MIN_SNAPSHOTS) return null;

  // Use up to last VOLUME_SPIKE_WINDOW snapshots as the baseline (excluding latest).
  const baseline = volumes.slice(0, Math.max(volumes.length - 1, 1));
  const latest = volumes[volumes.length - 1]!;

  const avg = mean(baseline);
  const sd = stddev(baseline, avg);

  // If stddev is zero (flat volume) skip — spike is undefined.
  if (sd === 0) return null;

  const sigmas = (latest - avg) / sd;
  if (sigmas <= VOLUME_SPIKE_SIGMA) return null;

  let severity = 4;
  if (sigmas > 5) severity += 2;
  if (isPoliticalCategory(contract.category)) severity += 1;

  const latestSnap = snapshots[snapshots.length - 1]!;
  const prevSnap = snapshots[snapshots.length - 2];

  return {
    contract_id: contract.id,
    anomaly_type: 'volume_spike',
    detection_time: new Date().toISOString(),
    description:
      `Volume spike of ${sigmas.toFixed(1)}σ detected on "${contract.question}" ` +
      `(platform: ${contract.platform}). Latest 24h volume: $${latest.toLocaleString()}, ` +
      `baseline mean: $${avg.toFixed(0)}, stddev: $${sd.toFixed(0)}.`,
    severity_score: clampSeverity(severity),
    probability_before: prevSnap?.probability ?? null,
    probability_after: latestSnap.probability ?? null,
    volume_before: prevSnap?.volume_24h ?? null,
    volume_after: latest,
    related_event: null,
    related_event_time: null,
    wallet_addresses: [],
    metadata: {
      sigmas: parseFloat(sigmas.toFixed(3)),
      baseline_mean: parseFloat(avg.toFixed(2)),
      baseline_stddev: parseFloat(sd.toFixed(2)),
      snapshot_count: snapshots.length,
      platform: contract.platform,
      category: contract.category,
    },
    status: 'active',
  };
}

// ---------------------------------------------------------------------------
// Detector 2: Price Dislocation
// ---------------------------------------------------------------------------

function detectPriceDislocation(
  contract: PredictionContract,
  snapshots: PredictionSnapshot[],
): AnomalyRecord | null {
  if (snapshots.length < PRICE_DISLOC_MIN_SNAPSHOTS) return null;

  const probs = snapshots
    .map((s) => ({ prob: s.probability, time: s.snapshot_time }))
    .filter((s): s is { prob: number; time: string } => s.prob !== null);

  if (probs.length < PRICE_DISLOC_MIN_SNAPSHOTS) return null;

  for (let i = 0; i < probs.length - 2; i++) {
    const p0 = probs[i]!.prob;
    const p1 = probs[i + 1]!.prob;
    const delta = Math.abs(p1 - p0);

    if (delta <= PRICE_DISLOC_THRESHOLD) continue;

    // Check if it reverted within the next 2 snapshots.
    let reverted = false;
    let revertProb: number | null = null;
    for (let j = i + 2; j <= Math.min(i + 3, probs.length - 1); j++) {
      const pJ = probs[j]!.prob;
      // Revert means price returned within half the original delta of p0.
      if (Math.abs(pJ - p0) < delta / 2) {
        reverted = true;
        revertProb = pJ;
        break;
      }
    }

    if (!reverted) continue;

    let severity = 5;
    if (delta > 0.25) severity += 2;

    return {
      contract_id: contract.id,
      anomaly_type: 'price_dislocation',
      detection_time: new Date().toISOString(),
      description:
        `Price dislocation of ${(delta * 100).toFixed(1)} pp on "${contract.question}" ` +
        `(platform: ${contract.platform}). Probability moved from ${(p0 * 100).toFixed(1)}% ` +
        `to ${(p1 * 100).toFixed(1)}% then reverted to ~${((revertProb ?? p0) * 100).toFixed(1)}%.`,
      severity_score: clampSeverity(severity),
      probability_before: p0,
      probability_after: p1,
      volume_before: snapshots[i]?.volume_24h ?? null,
      volume_after: snapshots[i + 1]?.volume_24h ?? null,
      related_event: null,
      related_event_time: null,
      wallet_addresses: [],
      metadata: {
        delta_pp: parseFloat((delta * 100).toFixed(2)),
        revert_probability: revertProb,
        snapshot_index: i,
        snapshot_time_start: probs[i]!.time,
        snapshot_time_peak: probs[i + 1]!.time,
        platform: contract.platform,
        category: contract.category,
      },
      status: 'active',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Detector 3: Whale Clustering
// ---------------------------------------------------------------------------

interface ContractVolumeStats {
  contract: PredictionContract;
  snapshots: PredictionSnapshot[];
  latestVolume: number;
  baselineMean: number;
  baselineStddev: number;
  sigmas: number;
  latestSnapshotTime: string;
}

function computeVolumeStats(
  contract: PredictionContract,
  snapshots: PredictionSnapshot[],
): ContractVolumeStats | null {
  const volumes = snapshots
    .map((s) => s.volume_24h)
    .filter((v): v is number => v !== null && v >= 0);

  if (volumes.length < VOLUME_SPIKE_MIN_SNAPSHOTS) return null;

  const baseline = volumes.slice(0, Math.max(volumes.length - 1, 1));
  const latest = volumes[volumes.length - 1]!;
  const avg = mean(baseline);
  const sd = stddev(baseline, avg);

  if (sd === 0) return null;

  return {
    contract,
    snapshots,
    latestVolume: latest,
    baselineMean: avg,
    baselineStddev: sd,
    sigmas: (latest - avg) / sd,
    latestSnapshotTime: snapshots[snapshots.length - 1]?.snapshot_time ?? new Date().toISOString(),
  };
}

function detectWhaleClustering(
  statsPerContract: ContractVolumeStats[],
): AnomalyRecord[] {
  // Group by category.
  const byCategory = new Map<string, ContractVolumeStats[]>();
  for (const stats of statsPerContract) {
    const cat = stats.contract.category ?? '__uncategorized__';
    const group = byCategory.get(cat) ?? [];
    group.push(stats);
    byCategory.set(cat, group);
  }

  const anomalies: AnomalyRecord[] = [];

  for (const [category, group] of byCategory) {
    if (category === '__uncategorized__') continue;

    // Identify contracts that are currently spiking above WHALE_CLUSTER_SIGMA.
    const spiking = group.filter((s) => s.sigmas >= WHALE_CLUSTER_SIGMA);
    if (spiking.length < WHALE_CLUSTER_MIN_CONTRACTS) continue;

    // Check that all spikes occurred within WHALE_CLUSTER_WINDOW_HRS of each other.
    const times = spiking.map((s) => new Date(s.latestSnapshotTime).getTime());
    const windowMs = WHALE_CLUSTER_WINDOW_HRS * 60 * 60 * 1000;
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);

    if (maxTime - minTime > windowMs) continue;

    const severity = clampSeverity(6);
    const contractIds = spiking.map((s) => s.contract.id);
    const questions = spiking.map((s) => `"${s.contract.question}"`).join(', ');

    // Create one anomaly per spiking contract pointing at the cluster.
    for (const stats of spiking) {
      const latestSnap = stats.snapshots[stats.snapshots.length - 1];
      const prevSnap = stats.snapshots[stats.snapshots.length - 2];

      anomalies.push({
        contract_id: stats.contract.id,
        anomaly_type: 'whale_clustering',
        detection_time: new Date().toISOString(),
        description:
          `Coordinated volume spike across ${spiking.length} contracts in category ` +
          `"${category}". All contracts exceeded ${WHALE_CLUSTER_SIGMA}σ within a ` +
          `${WHALE_CLUSTER_WINDOW_HRS}-hour window. Related contracts: ${questions}.`,
        severity_score: severity,
        probability_before: prevSnap?.probability ?? null,
        probability_after: latestSnap?.probability ?? null,
        volume_before: prevSnap?.volume_24h ?? null,
        volume_after: stats.latestVolume,
        related_event: null,
        related_event_time: null,
        wallet_addresses: [],
        metadata: {
          category,
          cluster_size: spiking.length,
          cluster_contract_ids: contractIds,
          window_hours: WHALE_CLUSTER_WINDOW_HRS,
          sigmas: parseFloat(stats.sigmas.toFixed(3)),
          platform: stats.contract.platform,
        },
        status: 'active',
      });
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Detector 4: Timing Correlation
// ---------------------------------------------------------------------------

function categoryMatchesLaw(contractCategory: string | null, law: LawSource): boolean {
  if (!contractCategory) return false;
  const cat = contractCategory.toLowerCase();
  const lawCat = lawCategory(law);

  // Direct category-to-law-type match.
  if (cat.includes('legislat') && lawCat === 'legislation') return true;
  if ((cat.includes('policy') || cat.includes('regulat')) && lawCat === 'policy') return true;
  if (cat.includes('election') || cat.includes('politics')) return true;
  if (cat.includes('government') || cat.includes('geopolit')) return true;

  // Subject keyword matching.
  const subjects = (law.subjects ?? []).join(' ').toLowerCase();
  const keywords = ['trade', 'tax', 'finance', 'health', 'defense', 'energy', 'environment',
    'immigration', 'election', 'spending', 'budget', 'sanction'];

  for (const kw of keywords) {
    if (cat.includes(kw) && subjects.includes(kw)) return true;
  }

  return false;
}

function detectTimingCorrelation(
  contract: PredictionContract,
  snapshots: PredictionSnapshot[],
  recentLaws: LawSource[],
): AnomalyRecord | null {
  if (snapshots.length < 2) return null;

  const probs = snapshots
    .map((s) => ({ prob: s.probability, time: new Date(s.snapshot_time).getTime() }))
    .filter((s): s is { prob: number; time: number } => s.prob !== null);

  if (probs.length < 2) return null;

  const lookbackMs = TIMING_LOOKBACK_HRS * 60 * 60 * 1000;

  for (const law of recentLaws) {
    if (!categoryMatchesLaw(contract.category, law)) continue;

    const eventDateStr = bestEventDate(law);
    if (!eventDateStr) continue;

    const eventTime = new Date(eventDateStr).getTime();
    if (isNaN(eventTime)) continue;

    // We want snapshots in the window [eventTime - lookbackMs, eventTime].
    const windowSnaps = probs.filter(
      (s) => s.time >= eventTime - lookbackMs && s.time <= eventTime,
    );

    if (windowSnaps.length < 2) continue;

    const firstProb = windowSnaps[0]!.prob;
    const lastProb = windowSnaps[windowSnaps.length - 1]!.prob;
    const shift = Math.abs(lastProb - firstProb);

    if (shift < TIMING_SHIFT_THRESHOLD) continue;

    const severity = clampSeverity(7);

    return {
      contract_id: contract.id,
      anomaly_type: 'timing_correlation',
      detection_time: new Date().toISOString(),
      description:
        `Probability of "${contract.question}" shifted ${(shift * 100).toFixed(1)} pp ` +
        `(${(firstProb * 100).toFixed(1)}% → ${(lastProb * 100).toFixed(1)}%) within ` +
        `${TIMING_LOOKBACK_HRS} hours before political event: "${law.title ?? law.type}". ` +
        `This pattern may indicate advance knowledge of the event (platform: ${contract.platform}).`,
      severity_score: severity,
      probability_before: firstProb,
      probability_after: lastProb,
      volume_before: snapshots.find(
        (s) => s.snapshot_time === new Date(windowSnaps[0]!.time).toISOString(),
      )?.volume_24h ?? null,
      volume_after: snapshots.find(
        (s) => s.snapshot_time === new Date(windowSnaps[windowSnaps.length - 1]!.time).toISOString(),
      )?.volume_24h ?? null,
      related_event: law.title ?? law.type ?? 'political event',
      related_event_time: eventDateStr,
      wallet_addresses: [],
      metadata: {
        shift_pp: parseFloat((shift * 100).toFixed(2)),
        event_type: law.type,
        event_date: eventDateStr,
        law_id: law.id,
        window_hours: TIMING_LOOKBACK_HRS,
        platform: contract.platform,
        category: contract.category,
        snapshots_in_window: windowSnaps.length,
      },
      status: 'active',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// DB writes
// ---------------------------------------------------------------------------

async function writeAnomalies(anomalies: AnomalyRecord[]): Promise<void> {
  if (anomalies.length === 0) return;

  for (let i = 0; i < anomalies.length; i += BATCH_SIZE) {
    const batch = anomalies.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('prediction_anomalies').insert(batch);

    if (error) {
      console.error(`  ERROR writing anomaly batch ${Math.floor(i / BATCH_SIZE) + 1}: ${error.message}`);
    } else {
      process.stdout.write(`  Wrote ${Math.min(i + BATCH_SIZE, anomalies.length)}/${anomalies.length} anomalies\n`);
    }
  }
}

async function writeConflictAlerts(alerts: ConflictAlertRecord[]): Promise<void> {
  if (alerts.length === 0) return;

  for (let i = 0; i < alerts.length; i += BATCH_SIZE) {
    const batch = alerts.slice(i, i + BATCH_SIZE);
    const { error } = await supabase.from('conflict_alerts').insert(batch);

    if (error) {
      console.error(
        `  ERROR writing conflict_alert batch ${Math.floor(i / BATCH_SIZE) + 1}: ${error.message}`,
      );
    } else {
      process.stdout.write(
        `  Wrote ${Math.min(i + BATCH_SIZE, alerts.length)}/${alerts.length} conflict alerts\n`,
      );
    }
  }
}

function buildConflictAlert(anomaly: AnomalyRecord, contract: PredictionContract): ConflictAlertRecord {
  const typeLabel: Record<string, string> = {
    volume_spike: 'Unusual Volume Spike',
    price_dislocation: 'Price Dislocation',
    whale_clustering: 'Coordinated Whale Activity',
    timing_correlation: 'Pre-Event Market Movement',
  };

  const label = typeLabel[anomaly.anomaly_type] ?? 'Market Anomaly';

  return {
    alert_type: 'prediction_insider',
    severity_score: anomaly.severity_score,
    title: `${label}: ${contract.question.slice(0, 120)}`,
    description: anomaly.description,
    entity_ids: [],
    evidence: {
      contract_id: contract.id,
      platform: contract.platform,
      anomaly_type: anomaly.anomaly_type,
      probability_before: anomaly.probability_before,
      probability_after: anomaly.probability_after,
      volume_before: anomaly.volume_before,
      volume_after: anomaly.volume_after,
      related_event: anomaly.related_event,
      related_event_time: anomaly.related_event_time,
      metadata: anomaly.metadata,
    },
    detected_at: anomaly.detection_time,
    status: 'active',
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('=== Prediction Market Anomaly Detector ===\n');

  if (DRY_RUN) {
    console.log('  [DRY RUN] No data will be written to the database.\n');
  }

  // --- 1. Fetch active contracts ---
  console.log('Fetching active prediction contracts...');
  const contracts = await fetchActiveContracts();
  console.log(`  Found ${contracts.length} active contracts.\n`);

  if (contracts.length === 0) {
    console.log('No active contracts. Run import:predictions first.');
    return;
  }

  // --- 2. Fetch law sources for timing correlation ---
  console.log('Fetching recent law sources (last 90 days)...');
  const recentLaws = await fetchRecentLawSources(90);
  console.log(`  Found ${recentLaws.length} recent law sources.\n`);

  // --- 3. Process each contract ---
  const allAnomalies: AnomalyRecord[] = [];
  const contractStatsForClustering: ContractVolumeStats[] = [];

  let processed = 0;

  for (const contract of contracts) {
    const snapshots = await fetchSnapshots(contract.id, VOLUME_SPIKE_WINDOW);

    // Detector 1: Volume Spike
    const volumeAnomaly = detectVolumeSpike(contract, snapshots);
    if (volumeAnomaly) allAnomalies.push(volumeAnomaly);

    // Detector 2: Price Dislocation
    const dislocAnomaly = detectPriceDislocation(contract, snapshots);
    if (dislocAnomaly) allAnomalies.push(dislocAnomaly);

    // Accumulate stats for Detector 3 (whale clustering — needs all contracts).
    const stats = computeVolumeStats(contract, snapshots);
    if (stats) contractStatsForClustering.push(stats);

    // Detector 4: Timing Correlation
    const timingAnomaly = detectTimingCorrelation(contract, snapshots, recentLaws);
    if (timingAnomaly) allAnomalies.push(timingAnomaly);

    processed++;
    if (processed % 50 === 0) {
      process.stdout.write(`  Processed ${processed}/${contracts.length} contracts...\n`);
    }
  }

  console.log(`  Processed all ${processed} contracts.\n`);

  // --- 4. Detector 3: Whale Clustering (cross-contract) ---
  console.log('Running whale clustering detector...');
  const clusterAnomalies = detectWhaleClustering(contractStatsForClustering);
  allAnomalies.push(...clusterAnomalies);
  console.log(`  Found ${clusterAnomalies.length} whale clustering anomalies.\n`);

  // --- 5. Summary ---
  const countByType: Record<string, number> = {};
  for (const a of allAnomalies) {
    countByType[a.anomaly_type] = (countByType[a.anomaly_type] ?? 0) + 1;
  }

  console.log('Detection results:');
  console.log(`  volume_spike:       ${countByType['volume_spike'] ?? 0}`);
  console.log(`  price_dislocation:  ${countByType['price_dislocation'] ?? 0}`);
  console.log(`  whale_clustering:   ${countByType['whale_clustering'] ?? 0}`);
  console.log(`  timing_correlation: ${countByType['timing_correlation'] ?? 0}`);
  console.log(`  Total anomalies:    ${allAnomalies.length}\n`);

  if (allAnomalies.length === 0) {
    console.log('No anomalies detected. Tables may be empty — run import:predictions first.');
    return;
  }

  // --- 6. Build conflict alerts for high-severity anomalies ---
  const contractMap = new Map<string, PredictionContract>(
    contracts.map((c) => [c.id, c]),
  );

  const conflictAlerts: ConflictAlertRecord[] = [];
  for (const anomaly of allAnomalies) {
    if (anomaly.severity_score >= CONFLICT_ALERT_MIN_SEVERITY) {
      const contract = contractMap.get(anomaly.contract_id);
      if (contract) {
        conflictAlerts.push(buildConflictAlert(anomaly, contract));
      }
    }
  }

  console.log(`High-severity anomalies (≥${CONFLICT_ALERT_MIN_SEVERITY}): ${conflictAlerts.length}`);

  // --- 7. Write to database ---
  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would write the following (sample of up to 3):');
    for (const a of allAnomalies.slice(0, 3)) {
      console.log(`  [${a.anomaly_type}] severity=${a.severity_score} — ${a.description.slice(0, 120)}...`);
    }
    if (conflictAlerts.length > 0) {
      console.log(`\n[DRY RUN] Would create ${conflictAlerts.length} conflict_alerts.`);
    }
  } else {
    console.log('\nWriting anomalies to prediction_anomalies...');
    await writeAnomalies(allAnomalies);

    if (conflictAlerts.length > 0) {
      console.log(`Writing ${conflictAlerts.length} high-severity alerts to conflict_alerts...`);
      await writeConflictAlerts(conflictAlerts);
    }
  }

  console.log('\n=== Detection Complete ===');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
