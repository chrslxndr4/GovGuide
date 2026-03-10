# Stock Tracker & Conflict Detection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a congressional stock trade conflict detection engine with prediction market anomaly detection, new materialized views, a conflict detection script, and enhanced UI pages.

**Architecture:** Weekly batch pipeline script (`scripts/detect-conflicts.ts`) cross-references stock trades against committee assignments, lobbying, donors, legislation, and prediction market data. Results write to existing `conflict_alerts` table. Three new materialized views power fast page loads. New `ticker_metadata` and `trade_enrichments` tables store SEC EDGAR sector data and cross-reference flags.

**Tech Stack:** TypeScript, Supabase PostgreSQL, Astro SSR, React islands, SEC EDGAR API (free), existing import pipeline data.

---

### Task 1: Database Migration — ticker_metadata & trade_enrichments

**Files:**
- Create: `supabase/migrations/021_conflict_detection_tables.sql`

**Step 1: Write the migration**

```sql
-- Ticker metadata from SEC EDGAR
CREATE TABLE ticker_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker TEXT NOT NULL UNIQUE,
  company_name TEXT,
  sic_code TEXT,
  sic_description TEXT,
  sector TEXT,
  exchange TEXT,
  cik TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_ticker_metadata_ticker ON ticker_metadata(ticker);
CREATE INDEX idx_ticker_metadata_sic ON ticker_metadata(sic_code);
CREATE INDEX idx_ticker_metadata_sector ON ticker_metadata(sector);

-- Trade enrichments: cross-reference flags per trade
CREATE TABLE trade_enrichments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stock_trade_id UUID NOT NULL REFERENCES stock_trades(id) ON DELETE CASCADE,
  ticker_metadata_id UUID REFERENCES ticker_metadata(id),
  sector TEXT,
  committee_overlap BOOLEAN DEFAULT false,
  committee_names TEXT[],
  related_bill_ids UUID[],
  related_lobbying_ids UUID[],
  donor_overlap BOOLEAN DEFAULT false,
  donor_entity_ids UUID[],
  regulatory_overlap BOOLEAN DEFAULT false,
  related_regulation_ids UUID[],
  enriched_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(stock_trade_id)
);

CREATE INDEX idx_trade_enrichments_trade ON trade_enrichments(stock_trade_id);
CREATE INDEX idx_trade_enrichments_committee ON trade_enrichments(committee_overlap) WHERE committee_overlap = true;
CREATE INDEX idx_trade_enrichments_donor ON trade_enrichments(donor_overlap) WHERE donor_overlap = true;
CREATE INDEX idx_trade_enrichments_sector ON trade_enrichments(sector);
```

**Step 2: Apply the migration**

Run: `cd "/Users/chrisalexander/Desktop/Chris Alexander HQ/Projects/GovGuide/GovGuide" && npx supabase migration up`
Expected: Migration applied successfully

**Step 3: Commit**

```bash
git add supabase/migrations/021_conflict_detection_tables.sql
git commit -m "feat: add ticker_metadata and trade_enrichments tables"
```

---

### Task 2: Database Migration — Materialized Views for Stock Tracker

**Files:**
- Create: `supabase/migrations/022_stock_conflict_views.sql`

**Step 1: Write the migration**

```sql
-- Pre-joined trades + conflicts + official info for /stocks feed
CREATE MATERIALIZED VIEW mv_trade_conflicts AS
SELECT
  st.id AS trade_id,
  st.ticker,
  st.asset_name,
  st.trade_type,
  st.amount_range_low,
  st.amount_range_high,
  st.trade_date,
  st.disclosure_date,
  st.days_late,
  st.filing_url,
  o.id AS official_id,
  o.full_name AS official_name,
  o.slug AS official_slug,
  o.party,
  te.sector,
  te.committee_overlap,
  te.committee_names,
  te.donor_overlap,
  te.regulatory_overlap,
  COALESCE(ca.max_severity, 0) AS conflict_severity,
  ca.conflict_count
FROM stock_trades st
JOIN officials o ON o.id = st.official_id
LEFT JOIN trade_enrichments te ON te.stock_trade_id = st.id
LEFT JOIN LATERAL (
  SELECT
    MAX(severity_score) AS max_severity,
    COUNT(*) AS conflict_count
  FROM conflict_alerts
  WHERE official_id = st.official_id
    AND alert_type IN ('stock_committee', 'trade_timing')
    AND status = 'active'
    AND detected_at >= st.trade_date - INTERVAL '7 days'
    AND detected_at <= st.disclosure_date + INTERVAL '7 days'
) ca ON true
ORDER BY st.trade_date DESC;

CREATE UNIQUE INDEX idx_mv_trade_conflicts ON mv_trade_conflicts(trade_id);
CREATE INDEX idx_mv_trade_conflicts_date ON mv_trade_conflicts(trade_date DESC);
CREATE INDEX idx_mv_trade_conflicts_official ON mv_trade_conflicts(official_id);
CREATE INDEX idx_mv_trade_conflicts_severity ON mv_trade_conflicts(conflict_severity DESC) WHERE conflict_severity > 0;

-- Aggregated stats per politician for profile pages
CREATE MATERIALIZED VIEW mv_politician_trade_summary AS
SELECT
  o.id AS official_id,
  o.full_name,
  o.slug,
  o.party,
  COUNT(st.id) AS total_trades,
  COUNT(st.id) FILTER (WHERE st.days_late > 0) AS late_filings,
  COUNT(te.id) FILTER (WHERE te.committee_overlap) AS committee_overlaps,
  COUNT(te.id) FILTER (WHERE te.donor_overlap) AS donor_overlaps,
  SUM(st.amount_range_high) AS total_volume_high,
  MIN(st.trade_date) AS earliest_trade,
  MAX(st.trade_date) AS latest_trade,
  COUNT(DISTINCT st.ticker) AS unique_tickers
FROM officials o
LEFT JOIN stock_trades st ON st.official_id = o.id
LEFT JOIN trade_enrichments te ON te.stock_trade_id = st.id
WHERE o.is_current = true
GROUP BY o.id, o.full_name, o.slug, o.party;

CREATE UNIQUE INDEX idx_mv_politician_summary ON mv_politician_trade_summary(official_id);

-- Conflict timeline for visualization
CREATE MATERIALIZED VIEW mv_conflict_timeline AS
SELECT
  ca.id AS alert_id,
  ca.alert_type,
  ca.severity_score,
  ca.title,
  ca.description,
  ca.detected_at,
  ca.official_id,
  o.full_name AS official_name,
  o.slug AS official_slug,
  o.party,
  ca.evidence,
  ca.status
FROM conflict_alerts ca
LEFT JOIN officials o ON o.id = ca.official_id
WHERE ca.status = 'active'
ORDER BY ca.detected_at DESC;

CREATE UNIQUE INDEX idx_mv_conflict_timeline ON mv_conflict_timeline(alert_id);
CREATE INDEX idx_mv_conflict_timeline_date ON mv_conflict_timeline(detected_at DESC);
CREATE INDEX idx_mv_conflict_timeline_type ON mv_conflict_timeline(alert_type);

-- Update the refresh function to include new views
CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_official_top_donors;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_official_industry_funding;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_corporate_influence_rankings;
  REFRESH MATERIALIZED VIEW mv_judge_conflict_flags;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_trade_conflicts;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_politician_trade_summary;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_conflict_timeline;
END;
$$;
```

**Step 2: Apply the migration**

Run: `cd "/Users/chrisalexander/Desktop/Chris Alexander HQ/Projects/GovGuide/GovGuide" && npx supabase migration up`
Expected: Migration applied successfully

**Step 3: Commit**

```bash
git add supabase/migrations/022_stock_conflict_views.sql
git commit -m "feat: add materialized views for stock tracker and conflict timeline"
```

---

### Task 3: SEC EDGAR Ticker Enrichment Script

**Files:**
- Create: `scripts/import-ticker-metadata.ts`
- Modify: `package.json` (add `import:tickers` script)

**Step 1: Write the ticker metadata importer**

This script:
1. Queries distinct tickers from `stock_trades` that aren't in `ticker_metadata` yet
2. Looks up each ticker against SEC EDGAR company search (`efts.sec.gov/LATEST/search-index?q=TICKER&dateRange=custom&startdt=2020-01-01&enddt=2026-12-31&forms=10-K`)
3. Falls back to SEC EDGAR full-text search for company name → SIC code mapping
4. Upserts into `ticker_metadata`

Key implementation details:
- SEC EDGAR requires a `User-Agent` header with contact info (per their fair use policy): `GovGuide/1.0 (thegovguide@gmail.com)`
- EDGAR company tickers endpoint: `GET https://efts.sec.gov/LATEST/search-index?q={ticker}&forms=10-K` — returns CIK, company name
- EDGAR company facts: `GET https://data.sec.gov/submissions/CIK{cik_padded}.json` — returns SIC code, exchange, company name
- SIC code → sector mapping: hardcoded lookup table (e.g., SIC 2000-3999 = Manufacturing, 6000-6999 = Finance)
- Rate limit: 10 requests/second (SEC EDGAR limit), use 100ms delay between requests
- Batch upsert: 100 tickers at a time
- Env var: `EDGAR_USER_AGENT=GovGuide/1.0 (thegovguide@gmail.com)` (add to .env)

```typescript
// Pseudocode structure:
// 1. Query stock_trades for distinct tickers not in ticker_metadata
// 2. For each ticker, fetch from EDGAR
// 3. Map SIC code to sector
// 4. Batch upsert to ticker_metadata
```

**Step 2: Add npm script to package.json**

Add to `scripts` in `package.json`:
```json
"import:tickers": "npx tsx --env-file=.env scripts/import-ticker-metadata.ts"
```

**Step 3: Run the script**

Run: `npm run import:tickers`
Expected: Tickers enriched with SIC codes and sectors

**Step 4: Commit**

```bash
git add scripts/import-ticker-metadata.ts package.json
git commit -m "feat: add SEC EDGAR ticker metadata importer"
```

---

### Task 4: Conflict Detection Engine — Core Script

**Files:**
- Create: `scripts/detect-conflicts.ts`
- Modify: `package.json` (add `detect:conflicts` script)

This is the main conflict detection engine. It runs 8 rule-based detectors and 4 statistical anomaly detectors.

**Step 1: Write the conflict detection script**

The script structure:

```typescript
// scripts/detect-conflicts.ts
//
// 1. Load all recent stock trades (last 90 days) with official info
// 2. Load committee assignments from officials.metadata JSONB
// 3. Load lobbying registrations and contributions
// 4. Load campaign contributions (top donors per official)
// 5. Load recent legislation/regulations
// 6. Load prediction market data and snapshots
//
// For each trade, run detectors:
//
// RULE-BASED:
// 1. committee_sector_overlap(trade, committees, ticker_metadata)
//    - Match trade ticker's SIC sector against committee jurisdiction
//    - Hardcoded committee→sector mapping (e.g., Armed Services → defense SICs)
//
// 2. pre_vote_trading(trade, votes, bills)
//    - Trade within 30 days before a vote on a bill affecting that sector
//    - Uses bill.subjects + ticker sector match
//
// 3. lobbying_trade_alignment(trade, lobbying_registrations)
//    - Politician received lobbying contacts from industry matching trade sector
//
// 4. donor_trade_correlation(trade, contributions)
//    - Top campaign donors include companies in same sector as trade
//
// 5. regulatory_front_running(trade, regulations)
//    - Trade before a regulatory action affecting that company/sector
//    - Check law_sources table for type='regulation' with matching agency/topic
//
// 6. insider_timing(trade)
//    - Trade precedes a >5% price move within 7 days (requires external price data — skip for v1)
//    - v1: Flag trades with amount_range_high > $100K as "large trade" + any other signal
//
// 7. unusual_frequency(trade, historical_trades)
//    - Official's monthly trade count > 2σ above their historical average
//
// 8. bipartisan_consensus(trades_window)
//    - 3+ officials from both parties trade same ticker in same direction within 14 days
//
// STATISTICAL ANOMALY (prediction markets):
// 1. volume_spike(contract, snapshots)
//    - 24-48hr volume > 3σ above trailing 30-day average
//
// 2. price_dislocation(contract, snapshots)
//    - Price diverges >15% then snaps back within 48hrs
//
// 3. whale_clustering(contracts, snapshots)
//    - Multiple contracts in same category see simultaneous volume spikes
//
// 4. timing_correlation(contract, political_events)
//    - Price/volume spike within 72hrs before vote/EO/regulatory action
//
// For each detection, compute severity 0-10 and upsert to conflict_alerts
// Also populate trade_enrichments with cross-reference flags
```

Key implementation details:
- Committee → sector mapping (hardcoded):
  ```
  Armed Services → [3700-3799] (defense), [3812] (radar)
  Energy & Commerce → [1300-1389] (oil/gas), [4900-4999] (utilities)
  Financial Services → [6000-6999] (finance/insurance)
  Agriculture → [0100-0999] (agriculture)
  etc.
  ```
- Severity scoring: Each detector returns 0-10. Multiple detectors compound: `min(10, sum * 0.7)`
- Deduplication: Check existing `conflict_alerts` before inserting (match on `alert_type + official_id + evidence->>'trade_id'`)
- Dry run mode via `DRY_RUN=true` env var

**Step 2: Add npm script**

```json
"detect:conflicts": "npx tsx --env-file=.env scripts/detect-conflicts.ts"
```

**Step 3: Run the script in dry-run mode first**

Run: `DRY_RUN=true npm run detect:conflicts`
Expected: Prints detected conflicts without writing to DB

**Step 4: Run for real**

Run: `npm run detect:conflicts`
Expected: Conflicts written to `conflict_alerts`, `trade_enrichments` populated

**Step 5: Refresh materialized views**

Run: via Supabase SQL: `SELECT refresh_all_materialized_views();`

**Step 6: Commit**

```bash
git add scripts/detect-conflicts.ts package.json
git commit -m "feat: add conflict detection engine with 12 detectors"
```

---

### Task 5: Prediction Market Anomaly Detector

**Files:**
- Create: `scripts/detect-prediction-anomalies.ts`
- Modify: `package.json` (add `detect:predictions` script)

**Step 1: Write the anomaly detector**

This script:
1. Queries `prediction_contracts` + `prediction_snapshots` for active political markets
2. Runs 4 anomaly detectors:
   - **Volume spike**: Compare 24hr volume vs 30-day trailing average. Flag if >3σ.
   - **Price dislocation**: Find cases where probability changed >15 points in <48hrs then reverted.
   - **Whale clustering**: Find 3+ contracts in same category with simultaneous volume spikes.
   - **Timing correlation**: Cross-reference snapshot timestamps with congressional calendar (votes from `votes` table, EOs from `law_sources` where type='executive_order', regulations from `law_sources` where type='regulation').
3. Scores each anomaly 0-10
4. Writes to `prediction_anomalies` table
5. Creates `prediction_insider` type entries in `conflict_alerts` for high-severity anomalies (≥6)

Key details:
- Needs at least 2 snapshots per contract to detect changes
- Political event window: 72 hours before event
- Volume σ calculation: `stddev_samp` over trailing 30 snapshots
- Category matching for whale clustering: use `prediction_contracts.category`

**Step 2: Add npm script**

```json
"detect:predictions": "npx tsx --env-file=.env scripts/detect-prediction-anomalies.ts"
```

**Step 3: Test**

Run: `DRY_RUN=true npm run detect:predictions`
Expected: Lists detected anomalies

**Step 4: Run for real**

Run: `npm run detect:predictions`

**Step 5: Commit**

```bash
git add scripts/detect-prediction-anomalies.ts package.json
git commit -m "feat: add prediction market anomaly detector"
```

---

### Task 6: Enhanced /stocks Page with Conflict Badges

**Files:**
- Modify: `src/pages/money/stocks/index.astro` — update to use `mv_trade_conflicts` view
- Modify: `src/pages/api/stock-trades.ts` — add conflict data to API response
- Modify: `src/components/stock/StockTracker.tsx` — add conflict severity badge, sector column

**Step 1: Update the API endpoint**

Modify `src/pages/api/stock-trades.ts` to query `mv_trade_conflicts` instead of `stock_trades`:
- Add `conflict_severity`, `sector`, `committee_overlap`, `committee_names`, `donor_overlap` fields to response
- Add `sort` query param support (sort by severity, date, amount)
- Add `flagged_only` filter param

**Step 2: Update StockTracker component**

Add to `StockTracker.tsx`:
- New "Severity" column with colored badge (reuse `severityBadgeClass` pattern from ConflictFeed)
- "Flagged" filter button alongside existing filters
- Sector tag next to ticker
- Click row → expand to show conflict details inline
- Party filter dropdown (D/R/I)

**Step 3: Update the Astro page**

Modify `src/pages/money/stocks/index.astro`:
- Hero section: update stats to include "Flagged Trades" count from `mv_trade_conflicts WHERE conflict_severity > 0`
- Add link to `/conflicts` page
- Replace server-rendered table with `<StockTracker client:load />` React island (it already exists but the page currently has its own server-rendered table — consolidate to use the React component)

**Step 4: Test by loading the page**

Run: `npm run dev` and visit `http://localhost:4321/money/stocks`

**Step 5: Commit**

```bash
git add src/pages/money/stocks/index.astro src/pages/api/stock-trades.ts src/components/stock/StockTracker.tsx
git commit -m "feat: enhance /stocks page with conflict badges and severity sorting"
```

---

### Task 7: Enhanced /conflicts Page with Timeline View

**Files:**
- Modify: `src/pages/conflicts/index.astro` — add timeline tab, prediction anomaly stats
- Modify: `src/components/conflicts/ConflictFeed.tsx` — add timeline view mode, prediction_insider type support
- Create: `src/components/conflicts/ConflictTimeline.tsx` — timeline visualization using Chart.js

**Step 1: Create ConflictTimeline component**

New React component using Chart.js (already in dependencies) scatter plot:
- X axis: date
- Y axis: severity score
- Color by alert_type
- Hover tooltip: description + official name
- Click: scroll to detail card
- Data from `mv_conflict_timeline` via `/api/conflicts?view=timeline`

**Step 2: Update ConflictFeed**

Add to `ConflictFeed.tsx`:
- Add `prediction_insider` to `AlertType` union and badge map
- Add `dark_money_chain`, `contract_donor`, `revolving_door` types to match the full `conflict_type` enum
- Add view toggle: "Cards" | "Timeline"
- When timeline selected, render `<ConflictTimeline />`

**Step 3: Update conflicts page**

Modify `src/pages/conflicts/index.astro`:
- Add prediction anomaly count stat card
- Add stock conflict count stat card
- Pass `view` prop to ConflictFeed based on URL param

**Step 4: Update API endpoint**

Modify `src/pages/api/conflicts.ts`:
- Add `view=timeline` param that returns from `mv_conflict_timeline` with date-bucketed data
- Add `date_from` / `date_to` filter params

**Step 5: Test**

Visit `http://localhost:4321/conflicts`

**Step 6: Commit**

```bash
git add src/pages/conflicts/index.astro src/components/conflicts/ConflictFeed.tsx src/components/conflicts/ConflictTimeline.tsx src/pages/api/conflicts.ts
git commit -m "feat: add timeline view and prediction anomaly support to /conflicts"
```

---

### Task 8: Official Profile Enrichment

**Files:**
- Modify: `src/pages/officials/[slug].astro` — add conflict flags section, improve stock trades tab

**Step 1: Update official profile page**

In `src/pages/officials/[slug].astro`:
- Add new parallel query for `mv_politician_trade_summary` (single row per official)
- Update existing trades query to include enrichment data (join with `trade_enrichments`)
- Update the "Stock Trades" section to show:
  - Summary stats row: total trades, late filings, committee overlaps, total volume
  - Committee overlap badges on individual trade rows
  - Sector tags on trades
- Update the "Conflicts" section to show prediction market anomalies alongside stock conflicts
- Add "Trade Summary" card in Overview section showing `mv_politician_trade_summary` data

**Step 2: Test**

Visit `http://localhost:4321/officials/[any-slug]`

**Step 3: Commit**

```bash
git add "src/pages/officials/[slug].astro"
git commit -m "feat: enrich official profiles with trade enrichments and conflict flags"
```

---

### Task 9: Predictions Page Anomaly Badges

**Files:**
- Modify: `src/components/predictions/PredictionsDashboard.tsx` — add anomaly badges
- Modify: `src/pages/api/predictions.ts` — join with `prediction_anomalies`

**Step 1: Update predictions API**

Modify `src/pages/api/predictions.ts` to left join `prediction_anomalies` where status = 'active', include `anomaly_type`, `severity_score`, `description` in response.

**Step 2: Update PredictionsDashboard**

Add to each market card:
- If anomaly exists: red/orange badge with anomaly type
- Expandable section showing anomaly description and related event
- Link to `/conflicts?type=prediction_insider` for full details

**Step 3: Test**

Visit `http://localhost:4321/predictions`

**Step 4: Commit**

```bash
git add src/components/predictions/PredictionsDashboard.tsx src/pages/api/predictions.ts
git commit -m "feat: add anomaly badges to predictions dashboard"
```

---

### Task 10: Pipeline Integration & npm Scripts

**Files:**
- Modify: `package.json` — add composite pipeline script
- Modify: `scripts/pipeline/run.ts` (if exists) — add conflict detection steps

**Step 1: Add composite scripts to package.json**

```json
"detect:all": "npm run detect:conflicts && npm run detect:predictions",
"pipeline:weekly": "npm run import:congress && npm run import:stock-trades && npm run import:predictions && npm run import:tickers && npm run detect:all"
```

**Step 2: Commit**

```bash
git add package.json
git commit -m "feat: add composite pipeline scripts for weekly conflict detection"
```

---

### Task 11: Limitations & Disclaimers

**Files:**
- Create: `src/components/conflicts/DisclaimerBanner.tsx`

**Step 1: Create disclaimer component**

Reusable banner shown on `/stocks`, `/conflicts`, and official profile conflict sections:

```tsx
export default function DisclaimerBanner() {
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-xs text-slate-500 leading-relaxed">
      <p className="font-semibold text-slate-600 mb-1">Important Limitations</p>
      <ul className="list-disc list-inside space-y-0.5">
        <li>Stock trades are self-reported with up to 45-day filing delay</li>
        <li>Blind trusts are exempt from disclosure requirements</li>
        <li>Prediction market attribution is limited (pseudonymous wallets)</li>
        <li>Conflict flags represent statistical patterns, not proof of wrongdoing</li>
        <li>Correlation does not equal causation</li>
      </ul>
    </div>
  );
}
```

**Step 2: Add to relevant pages**

Import and render at the bottom of `/stocks`, `/conflicts`, and official profile conflict sections.

**Step 3: Commit**

```bash
git add src/components/conflicts/DisclaimerBanner.tsx src/pages/money/stocks/index.astro src/pages/conflicts/index.astro "src/pages/officials/[slug].astro"
git commit -m "feat: add limitations disclaimer to conflict-related pages"
```

---

## Execution Order

Tasks 1-2 (migrations) must run first. After that:
- Tasks 3-5 (scripts) can run in parallel
- Tasks 6-9 (UI) can run in parallel after scripts complete
- Tasks 10-11 are final cleanup

**Dependency graph:**
```
Task 1 → Task 2 → Task 3 (tickers) ─┐
                 → Task 4 (conflicts)─┤→ Task 6 (stocks UI)
                 → Task 5 (anomalies)─┤→ Task 7 (conflicts UI)
                                      ├→ Task 8 (official profiles)
                                      ├→ Task 9 (predictions UI)
                                      └→ Task 10 + 11 (pipeline + disclaimers)
```
