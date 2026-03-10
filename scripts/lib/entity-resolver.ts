/**
 * Entity Resolution Library
 *
 * Matches entities across data sources using:
 * 1. Deterministic matching: FEC IDs, EINs, bioguide IDs, tickers
 * 2. Fuzzy matching: normalized names, Jaro-Winkler similarity
 * 3. Contextual matching: same address, industry, associated people
 * 4. Confidence scoring: 0-1 score per match
 * 5. Manual overrides: curated merge/split list
 */

import { supabase } from './supabase-admin.js';

export interface EntityMatch {
  sourceId: string;
  targetId: string;
  confidence: number;
  matchType: 'deterministic' | 'fuzzy' | 'contextual' | 'manual';
  evidence: Record<string, string>;
}

export interface ResolverOptions {
  fuzzyThreshold?: number; // 0-1, default 0.85
  dryRun?: boolean;
  verbose?: boolean;
}

// --- Name Normalization ---

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|corp|ltd|co|lp|llp|pllc|pa|pc|na|sa)\b\.?/gi, '')
    .replace(/\b(the|a|an|of|for|and|&)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Jaro-Winkler Similarity ---

function jaroSimilarity(s1: string, s2: string): number {
  if (s1 === s2) return 1;
  const len1 = s1.length;
  const len2 = s2.length;
  if (len1 === 0 || len2 === 0) return 0;

  const matchWindow = Math.max(Math.floor(Math.max(len1, len2) / 2) - 1, 0);
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0;

  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  return (
    (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3
  );
}

export function jaroWinkler(s1: string, s2: string): number {
  const jaro = jaroSimilarity(s1, s2);
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(s1.length, s2.length)); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

// --- Deterministic Matching ---

export async function findDeterministicMatches(): Promise<EntityMatch[]> {
  const matches: EntityMatch[] = [];

  // Match by FEC Committee ID
  const { data: fecDups } = await supabase.rpc('find_duplicate_external_ids' as string, {
    id_key: 'fec_committee_id',
  });

  // Match by bioguide_id between entities and officials
  const { data: officials } = await supabase
    .from('officials')
    .select('id, bioguide_id, full_name')
    .not('bioguide_id', 'is', null);

  const { data: entities } = await supabase
    .from('entities')
    .select('id, name, external_ids')
    .eq('entity_type', 'officeholder');

  if (officials && entities) {
    for (const official of officials) {
      for (const entity of entities) {
        const extIds = entity.external_ids as Record<string, string> | null;
        if (extIds?.bioguide_id === official.bioguide_id) {
          matches.push({
            sourceId: entity.id,
            targetId: official.id,
            confidence: 1.0,
            matchType: 'deterministic',
            evidence: { field: 'bioguide_id', value: official.bioguide_id! },
          });
        }
      }
    }
  }

  // Match by ticker between entity_corporations
  const { data: tickerDups } = await supabase
    .from('entity_corporations')
    .select('entity_id, ticker')
    .not('ticker', 'is', null);

  if (tickerDups) {
    const tickerMap = new Map<string, string[]>();
    for (const row of tickerDups) {
      const existing = tickerMap.get(row.ticker!) ?? [];
      existing.push(row.entity_id);
      tickerMap.set(row.ticker!, existing);
    }
    for (const [ticker, ids] of Array.from(tickerMap)) {
      if (ids.length > 1) {
        for (let i = 1; i < ids.length; i++) {
          matches.push({
            sourceId: ids[0],
            targetId: ids[i],
            confidence: 0.95,
            matchType: 'deterministic',
            evidence: { field: 'ticker', value: ticker },
          });
        }
      }
    }
  }

  return matches;
}

// --- Fuzzy Name Matching ---

export async function findFuzzyMatches(
  threshold: number = 0.85
): Promise<EntityMatch[]> {
  const matches: EntityMatch[] = [];

  // Fetch all entities grouped by type for within-type matching
  const { data: allEntities } = await supabase
    .from('entities')
    .select('id, name, entity_type')
    .order('entity_type');

  if (!allEntities) return matches;

  const byType = new Map<string, Array<{ id: string; name: string; normalized: string }>>();
  for (const e of allEntities) {
    const group = byType.get(e.entity_type) ?? [];
    group.push({ id: e.id, name: e.name, normalized: normalizeName(e.name) });
    byType.set(e.entity_type, group);
  }

  for (const [, group] of Array.from(byType)) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (group[i].normalized === group[j].normalized) {
          matches.push({
            sourceId: group[i].id,
            targetId: group[j].id,
            confidence: 0.95,
            matchType: 'fuzzy',
            evidence: { normalized_name: group[i].normalized },
          });
        } else {
          const score = jaroWinkler(group[i].normalized, group[j].normalized);
          if (score >= threshold) {
            matches.push({
              sourceId: group[i].id,
              targetId: group[j].id,
              confidence: score,
              matchType: 'fuzzy',
              evidence: {
                name_a: group[i].name,
                name_b: group[j].name,
                similarity: score.toFixed(3),
              },
            });
          }
        }
      }
    }
  }

  return matches;
}

// --- Merge Entities ---

export async function mergeEntities(
  keepId: string,
  mergeId: string,
  dryRun: boolean = false
): Promise<void> {
  if (dryRun) {
    console.log(`  [DRY RUN] Would merge ${mergeId} into ${keepId}`);
    return;
  }

  // Update all relationships pointing to mergeId
  await supabase
    .from('relationships')
    .update({ source_entity_id: keepId })
    .eq('source_entity_id', mergeId);

  await supabase
    .from('relationships')
    .update({ target_entity_id: keepId })
    .eq('target_entity_id', mergeId);

  // Update contributions
  await supabase
    .from('contributions')
    .update({ donor_entity_id: keepId })
    .eq('donor_entity_id', mergeId);

  await supabase
    .from('contributions')
    .update({ recipient_entity_id: keepId })
    .eq('recipient_entity_id', mergeId);

  // Merge aliases
  const { data: keepEntity } = await supabase
    .from('entities')
    .select('aliases, external_ids')
    .eq('id', keepId)
    .single();

  const { data: mergeEntity } = await supabase
    .from('entities')
    .select('name, aliases, external_ids')
    .eq('id', mergeId)
    .single();

  if (keepEntity && mergeEntity) {
    const mergedAliases = Array.from(new Set([
      ...(keepEntity.aliases ?? []),
      ...(mergeEntity.aliases ?? []),
      mergeEntity.name,
    ]));

    const mergedExtIds = {
      ...(mergeEntity.external_ids as Record<string, unknown> ?? {}),
      ...(keepEntity.external_ids as Record<string, unknown> ?? {}),
    };

    await supabase
      .from('entities')
      .update({ aliases: mergedAliases, external_ids: mergedExtIds })
      .eq('id', keepId);
  }

  // Delete merged entity
  await supabase.from('entities').delete().eq('id', mergeId);
}
