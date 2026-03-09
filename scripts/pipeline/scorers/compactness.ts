import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ─── Types ────────────────────────────────────────────────────────────────────

interface RawCompactnessRow {
  id: string;
  name: string;
  slug: string;
  polsby_popper: number;
  reock: number;
  convex_hull: number;
}

interface CompactnessResult {
  jurisdiction_id: string;
  name: string;
  state: string;
  district: string;
  polsby_popper: number;
  reock: number;
  convex_hull: number;
  composite: number;    // average of all three metrics
  percentile: number;  // national ranking, 0–100 (higher = more compact)
  flag: 'normal' | 'watch' | 'extreme'; // composite <0.15 → extreme, <0.25 → watch
}

interface StateCompactnessSummary {
  state: string;
  district_count: number;
  avg_polsby_popper: number;
  avg_reock: number;
  avg_convex_hull: number;
  avg_composite: number;
  min_composite: number;
  max_composite: number;
  extreme_count: number;
  watch_count: number;
}

interface CompactnessReport {
  computed_at: string;
  total_districts: number;
  results: CompactnessResult[];
  state_summaries: StateCompactnessSummary[];
  most_gerrymandered_states: StateCompactnessSummary[];
  least_gerrymandered_states: StateCompactnessSummary[];
  extreme_districts: CompactnessResult[];
}

// ─── PostGIS SQL ──────────────────────────────────────────────────────────────

const COMPACTNESS_SQL = `
SELECT
  j.id,
  j.name,
  j.slug,
  -- Polsby-Popper: 4π × Area / Perimeter²
  CASE WHEN ST_Perimeter(j.geom::geography) > 0
    THEN (4 * PI() * ST_Area(j.geom::geography)) / POWER(ST_Perimeter(j.geom::geography), 2)
    ELSE 0
  END as polsby_popper,
  -- Reock: Area / MinBoundingCircle area
  CASE WHEN ST_Area(ST_MinimumBoundingCircle(j.geom)) > 0
    THEN ST_Area(j.geom) / ST_Area(ST_MinimumBoundingCircle(j.geom))
    ELSE 0
  END as reock,
  -- Convex Hull: Area / ConvexHull area
  CASE WHEN ST_Area(ST_ConvexHull(j.geom)) > 0
    THEN ST_Area(j.geom) / ST_Area(ST_ConvexHull(j.geom))
    ELSE 0
  END as convex_hull
FROM jurisdictions j
WHERE j.level = 'congressional_district'
  AND j.geom IS NOT NULL;
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parses state abbreviation and district number from a jurisdiction name or slug.
 * Expects formats like "California 33rd Congressional District" or slugs like
 * "ca-congressional-district-33".
 */
function parseNameAndDistrict(name: string, slug: string): { state: string; district: string } {
  // Try to extract from slug first — more reliable
  const slugMatch = slug.match(/^([a-z]{2})-congressional-district-(\d+|at-large)$/);
  if (slugMatch) {
    return {
      state: slugMatch[1].toUpperCase(),
      district: slugMatch[2],
    };
  }

  // Fall back to name parsing
  const nameMatch = name.match(/^(.+?)\s+(?:(\d+)(?:st|nd|rd|th)|At.Large)\s+Congressional/i);
  if (nameMatch) {
    return {
      state: nameMatch[1].trim(),
      district: nameMatch[2] ?? 'At-Large',
    };
  }

  // Last resort — return raw values
  return { state: 'Unknown', district: name };
}

/**
 * Clamps a metric value to [0, 1] and rounds to six decimal places.
 * PostGIS geometric calculations can occasionally produce values slightly
 * outside the expected range due to floating-point precision.
 */
function clampMetric(value: number): number {
  const clamped = Math.max(0, Math.min(1, value ?? 0));
  return Math.round(clamped * 1_000_000) / 1_000_000;
}

/**
 * Determines the gerrymandering flag based on composite score thresholds.
 *   composite < 0.15 → extreme
 *   composite < 0.25 → watch
 *   otherwise       → normal
 */
function computeFlag(composite: number): 'normal' | 'watch' | 'extreme' {
  if (composite < 0.15) return 'extreme';
  if (composite < 0.25) return 'watch';
  return 'normal';
}

/**
 * Assigns a 0–100 percentile to each district based on composite score.
 * Districts are sorted ascending; each district's percentile reflects the
 * proportion of other districts with a lower or equal composite score.
 */
function assignPercentiles(results: Array<{ composite: number }>): number[] {
  const n = results.length;
  if (n === 0) return [];

  // Build an index-sorted array
  const indexed = results.map((r, i) => ({ composite: r.composite, originalIndex: i }));
  indexed.sort((a, b) => a.composite - b.composite);

  const percentiles = new Array<number>(n);
  for (let rank = 0; rank < n; rank++) {
    // percentile = (rank / (n - 1)) * 100, clamped and rounded to 2 dp
    const raw = n === 1 ? 50 : (rank / (n - 1)) * 100;
    percentiles[indexed[rank].originalIndex] = Math.round(raw * 100) / 100;
  }

  return percentiles;
}

// ─── Core Computation ─────────────────────────────────────────────────────────

async function fetchRawMetrics(): Promise<RawCompactnessRow[]> {
  // Prefer a dedicated RPC if it exists; fall back to raw SQL via rpc('execute_sql').
  // If neither is available the caller surfaces the error.
  const { data, error } = await (supabase as any).rpc('calculate_compactness').select('*');

  if (!error && Array.isArray(data) && data.length > 0) {
    return data as RawCompactnessRow[];
  }

  // Fall back: execute the SQL directly via pg function
  const { data: sqlData, error: sqlError } = await (supabase as any)
    .rpc('execute_sql', { query: COMPACTNESS_SQL });

  if (sqlError) {
    throw new Error(`PostGIS compactness query failed: ${sqlError.message}`);
  }

  return (sqlData ?? []) as RawCompactnessRow[];
}

function buildResults(rows: RawCompactnessRow[]): CompactnessResult[] {
  // First pass — clamp metrics and compute composite
  const partial = rows.map((row) => {
    const pp = clampMetric(row.polsby_popper);
    const re = clampMetric(row.reock);
    const ch = clampMetric(row.convex_hull);
    const composite = Math.round(((pp + re + ch) / 3) * 1_000_000) / 1_000_000;
    const { state, district } = parseNameAndDistrict(row.name, row.slug);

    return {
      jurisdiction_id: row.id,
      name: row.name,
      state,
      district,
      polsby_popper: pp,
      reock: re,
      convex_hull: ch,
      composite,
    };
  });

  // Second pass — assign percentiles and flags
  const percentiles = assignPercentiles(partial);

  return partial.map((item, i) => ({
    ...item,
    percentile: percentiles[i],
    flag: computeFlag(item.composite),
  }));
}

function buildStateSummaries(results: CompactnessResult[]): StateCompactnessSummary[] {
  const byState = new Map<string, CompactnessResult[]>();

  for (const r of results) {
    const existing = byState.get(r.state) ?? [];
    existing.push(r);
    byState.set(r.state, existing);
  }

  const summaries: StateCompactnessSummary[] = [];

  for (const [state, districts] of byState.entries()) {
    const n = districts.length;
    const avg = (key: keyof Pick<CompactnessResult, 'polsby_popper' | 'reock' | 'convex_hull' | 'composite'>) =>
      Math.round((districts.reduce((sum, d) => sum + d[key], 0) / n) * 1_000_000) / 1_000_000;

    const composites = districts.map((d) => d.composite);

    summaries.push({
      state,
      district_count: n,
      avg_polsby_popper: avg('polsby_popper'),
      avg_reock: avg('reock'),
      avg_convex_hull: avg('convex_hull'),
      avg_composite: avg('composite'),
      min_composite: Math.min(...composites),
      max_composite: Math.max(...composites),
      extreme_count: districts.filter((d) => d.flag === 'extreme').length,
      watch_count: districts.filter((d) => d.flag === 'watch').length,
    });
  }

  return summaries;
}

// ─── Database Upsert ─────────────────────────────────────────────────────────

async function upsertCompactnessScores(results: CompactnessResult[]): Promise<void> {
  if (results.length === 0) return;

  const rows = results.map((r) => ({
    jurisdiction_id: r.jurisdiction_id,
    name: r.name,
    state: r.state,
    district: r.district,
    polsby_popper: r.polsby_popper,
    reock: r.reock,
    convex_hull: r.convex_hull,
    composite: r.composite,
    percentile: r.percentile,
    flag: r.flag,
    computed_at: new Date().toISOString(),
  }));

  // Batch upserts to avoid payload size limits (500 rows per batch)
  const BATCH_SIZE = 500;
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const { error } = await supabase
      .from('district_compactness')
      .upsert(batch, { onConflict: 'jurisdiction_id' });

    if (error) {
      throw new Error(
        `Failed to upsert compactness batch [${offset}–${offset + batch.length}]: ${error.message}`
      );
    }

    console.log(`  Upserted rows ${offset + 1}–${Math.min(offset + BATCH_SIZE, rows.length)}`);
  }
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export async function calculateCompactnessScores(): Promise<CompactnessReport> {
  console.log('Fetching district geometries from PostGIS...');
  const rows = await fetchRawMetrics();
  console.log(`  ${rows.length} congressional districts found`);

  if (rows.length === 0) {
    throw new Error(
      'No congressional district geometries found. Ensure jurisdictions table is populated with level = "congressional_district" and non-null geom.'
    );
  }

  console.log('Computing compactness metrics...');
  const results = buildResults(rows);

  const extremeDistricts = results.filter((r) => r.flag === 'extreme');
  const watchDistricts = results.filter((r) => r.flag === 'watch');
  console.log(
    `  Flags — extreme: ${extremeDistricts.length}, watch: ${watchDistricts.length}, normal: ${results.length - extremeDistricts.length - watchDistricts.length}`
  );

  console.log('Computing state-level summaries...');
  const stateSummaries = buildStateSummaries(results);
  const sortedByGerrymandering = [...stateSummaries].sort(
    (a, b) => a.avg_composite - b.avg_composite
  );
  const mostGerrymandered = sortedByGerrymandering.slice(0, 10);
  const leastGerrymandered = sortedByGerrymandering.slice(-10).reverse();

  console.log('Upserting scores into district_compactness...');
  await upsertCompactnessScores(results);
  console.log('  Upsert complete.');

  const report: CompactnessReport = {
    computed_at: new Date().toISOString(),
    total_districts: results.length,
    results,
    state_summaries: stateSummaries,
    most_gerrymandered_states: mostGerrymandered,
    least_gerrymandered_states: leastGerrymandered,
    extreme_districts: extremeDistricts,
  };

  return report;
}

// ─── CLI Runner ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.');
    process.exit(1);
  }

  try {
    const report = await calculateCompactnessScores();

    console.log('\n── Compactness Report ──────────────────────────────────────');
    console.log(`Computed at:      ${report.computed_at}`);
    console.log(`Total districts:  ${report.total_districts}`);
    console.log(`Extreme districts: ${report.extreme_districts.length}`);

    console.log('\nMost gerrymandered states (lowest avg composite):');
    for (const s of report.most_gerrymandered_states) {
      console.log(
        `  ${s.state.padEnd(20)} avg composite: ${s.avg_composite.toFixed(4)}  extreme: ${s.extreme_count}`
      );
    }

    console.log('\nLeast gerrymandered states (highest avg composite):');
    for (const s of report.least_gerrymandered_states) {
      console.log(
        `  ${s.state.padEnd(20)} avg composite: ${s.avg_composite.toFixed(4)}`
      );
    }

    if (report.extreme_districts.length > 0) {
      console.log('\nExtreme districts (composite < 0.15):');
      const sorted = [...report.extreme_districts].sort((a, b) => a.composite - b.composite);
      for (const d of sorted) {
        console.log(
          `  ${d.name.padEnd(45)} composite: ${d.composite.toFixed(4)}  PP: ${d.polsby_popper.toFixed(4)}  Reock: ${d.reock.toFixed(4)}  CH: ${d.convex_hull.toFixed(4)}`
        );
      }
    }

    console.log('\nDone.');
  } catch (err) {
    console.error('Fatal error:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

// Run when executed directly
const isMain =
  typeof require !== 'undefined'
    ? require.main === module
    : import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  main();
}
