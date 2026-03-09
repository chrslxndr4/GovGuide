# GovGuide Pillars 2 & 3 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the "Follow the Money" and "Connect the Dots" pillars — campaign finance, lobbying, stock trading, judicial transparency, conflict detection, prediction markets, and the flagship Money Graph visualization.

**Architecture:** Extends the existing Astro + Supabase + React foundation. New graph data model (entities + relationships tables), new import pipelines for 15+ data sources, new interactive visualization components (Cytoscape.js, D3 Sankey, Chart.js), new SSR API endpoints, and an automated conflict detection engine.

**Tech Stack additions:** Cytoscape.js (graph viz), D3 Sankey (flow diagrams), Chart.js (charts), pg_trgm (fuzzy text search)

**Dependencies:** Pillar 1 (Navigate) must be complete. Supabase must be configured with migrations applied and data seeded.

---

## Phase 1: Graph Foundation (Tasks 17-20)

### Task 17: Graph Data Model — Entities & Relationships Schema

**Files:**
- Create: `supabase/migrations/008_graph_entities.sql`
- Create: `supabase/migrations/009_graph_relationships.sql`

**Migration 008 — Entities:**
```sql
CREATE TYPE entity_type AS ENUM (
  'individual', 'officeholder', 'judge', 'lobbyist',
  'corporation', 'pac', '501c4', '527_org', 'lobbying_firm',
  'trade_association', 'foreign_principal',
  'jurisdiction', 'office', 'agency', 'committee', 'court'
);

CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type entity_type NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT[] DEFAULT '{}',
  external_ids JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_entities_type ON entities(entity_type);
CREATE INDEX idx_entities_name ON entities USING gin(name gin_trgm_ops);
CREATE INDEX idx_entities_external_ids ON entities USING gin(external_ids);

-- Type-specific detail tables
CREATE TABLE entity_corporations (
  entity_id UUID PRIMARY KEY REFERENCES entities(id),
  ticker TEXT,
  naics_code TEXT,
  sector TEXT,
  market_cap NUMERIC,
  parent_corp_id UUID REFERENCES entities(id)
);

CREATE TABLE entity_pacs (
  entity_id UUID PRIMARY KEY REFERENCES entities(id),
  fec_committee_id TEXT,
  pac_type TEXT,
  sponsor_entity_id UUID REFERENCES entities(id)
);

CREATE TABLE entity_501c4s (
  entity_id UUID PRIMARY KEY REFERENCES entities(id),
  ein TEXT,
  irs_category TEXT,
  total_revenue NUMERIC,
  total_grants_made NUMERIC
);

CREATE TABLE entity_lobbying_firms (
  entity_id UUID PRIMARY KEY REFERENCES entities(id),
  lda_registrant_id TEXT,
  client_count INTEGER
);

CREATE TABLE entity_foreign_principals (
  entity_id UUID PRIMARY KEY REFERENCES entities(id),
  country TEXT NOT NULL,
  principal_type TEXT
);
```

**Migration 009 — Relationships:**
```sql
CREATE TYPE relationship_type AS ENUM (
  'donated_to', 'contributed_to', 'spent_for', 'spent_against',
  'granted_to', 'lobbied_via', 'paid_by',
  'represents', 'sits_on', 'appointed_by', 'confirmed_by',
  'employed_by', 'previously_held', 'registered_for',
  'sponsored', 'cosponsored', 'voted_on', 'lobbied_on',
  'affects_industry', 'commented_on',
  'decided', 'party_to', 'holds_stock', 'oversees',
  'traded', 'late_filed'
);

CREATE TABLE relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entity_id UUID NOT NULL REFERENCES entities(id),
  target_entity_id UUID NOT NULL REFERENCES entities(id),
  relationship_type relationship_type NOT NULL,
  amount NUMERIC,
  date_start DATE,
  date_end DATE,
  metadata JSONB DEFAULT '{}',
  confidence_score NUMERIC(3,2) DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_rel_source ON relationships(source_entity_id);
CREATE INDEX idx_rel_target ON relationships(target_entity_id);
CREATE INDEX idx_rel_type ON relationships(relationship_type);
CREATE INDEX idx_rel_amount ON relationships(amount) WHERE amount IS NOT NULL;
CREATE INDEX idx_rel_date ON relationships(date_start);
CREATE INDEX idx_rel_source_type ON relationships(source_entity_id, relationship_type);
CREATE INDEX idx_rel_target_type ON relationships(target_entity_id, relationship_type);
```

**Commit after completion.**

---

### Task 18: Campaign Finance & Stock Trading Schema

**Files:**
- Create: `supabase/migrations/010_campaign_finance.sql`
- Create: `supabase/migrations/011_stock_trading.sql`
- Create: `supabase/migrations/012_lobbying.sql`

**Migration 010 — Campaign Finance:**
```sql
CREATE TABLE contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  donor_entity_id UUID REFERENCES entities(id),
  recipient_entity_id UUID REFERENCES entities(id),
  amount NUMERIC NOT NULL,
  contribution_date DATE,
  fec_filing_id TEXT,
  contribution_type TEXT,
  employer TEXT,
  occupation TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE independent_expenditures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spender_entity_id UUID REFERENCES entities(id),
  candidate_entity_id UUID REFERENCES entities(id),
  amount NUMERIC NOT NULL,
  expenditure_date DATE,
  support_oppose TEXT CHECK (support_oppose IN ('support', 'oppose')),
  payee TEXT,
  purpose TEXT,
  fec_filing_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE dark_money_flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entity_id UUID REFERENCES entities(id),
  target_entity_id UUID REFERENCES entities(id),
  amount NUMERIC NOT NULL,
  year INTEGER,
  irs_filing TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_contributions_donor ON contributions(donor_entity_id);
CREATE INDEX idx_contributions_recipient ON contributions(recipient_entity_id);
CREATE INDEX idx_contributions_date ON contributions(contribution_date);
CREATE INDEX idx_ie_spender ON independent_expenditures(spender_entity_id);
CREATE INDEX idx_ie_candidate ON independent_expenditures(candidate_entity_id);
CREATE INDEX idx_dark_money_source ON dark_money_flows(source_entity_id);
```

**Migration 011 — Stock Trading:**
```sql
CREATE TABLE stock_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  official_id UUID REFERENCES officials(id),
  ticker TEXT,
  asset_name TEXT NOT NULL,
  trade_type TEXT CHECK (trade_type IN ('purchase', 'sale', 'exchange')),
  amount_range_low NUMERIC,
  amount_range_high NUMERIC,
  trade_date DATE,
  disclosure_date DATE,
  days_late INTEGER,
  filing_url TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE official_holdings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  official_id UUID REFERENCES officials(id),
  ticker TEXT,
  asset_name TEXT NOT NULL,
  value_range_low NUMERIC,
  value_range_high NUMERIC,
  disclosure_year INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_stock_trades_official ON stock_trades(official_id);
CREATE INDEX idx_stock_trades_ticker ON stock_trades(ticker);
CREATE INDEX idx_stock_trades_date ON stock_trades(trade_date);
CREATE INDEX idx_holdings_official ON official_holdings(official_id);
```

**Migration 012 — Lobbying:**
```sql
CREATE TABLE lobbying_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_entity_id UUID REFERENCES entities(id),
  client_entity_id UUID REFERENCES entities(id),
  issues TEXT[],
  effective_date DATE,
  termination_date DATE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE lobbying_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id UUID REFERENCES lobbying_registrations(id),
  report_period TEXT,
  amount NUMERIC,
  bills_lobbied TEXT[],
  agencies_contacted TEXT[],
  lobbyists JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE lobbying_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lobbyist_entity_id UUID REFERENCES entities(id),
  recipient_entity_id UUID REFERENCES entities(id),
  amount NUMERIC NOT NULL,
  contribution_date DATE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_lobby_reg_firm ON lobbying_registrations(firm_entity_id);
CREATE INDEX idx_lobby_reg_client ON lobbying_registrations(client_entity_id);
CREATE INDEX idx_lobby_act_reg ON lobbying_activities(registration_id);
CREATE INDEX idx_lobby_contrib_lobbyist ON lobbying_contributions(lobbyist_entity_id);
```

**Commit after completion.**

---

### Task 19: Judicial, Legislative, Polling & Conflict Schema

**Files:**
- Create: `supabase/migrations/013_judicial.sql`
- Create: `supabase/migrations/014_legislative.sql`
- Create: `supabase/migrations/015_polling_predictions.sql`
- Create: `supabase/migrations/016_conflicts_scores.sql`

**Migration 013 — Judicial tables:** courts, judges, judge_financial_disclosures, judge_investments, judicial_decisions, case_judges, case_parties, sentencing_records (as specified in expanded design).

**Migration 014 — Legislative tables:** bills, bill_actions, bill_sponsors, roll_call_votes, vote_positions (as specified in expanded design).

**Migration 015 — Polling & Predictions:** polls, pollster_ratings, prediction_contracts, prediction_trades, prediction_anomalies (as specified in expanded design).

**Migration 016 — Conflicts & Scores:** conflict_alerts, transparency_scores, corporate_influence_scores, community_submissions (as specified in expanded design).

**Commit after completion.**

---

### Task 20: Graph Traversal Functions & Materialized Views

**Files:**
- Create: `supabase/migrations/017_graph_functions.sql`
- Create: `supabase/migrations/018_materialized_views.sql`

**Migration 017 — Functions:**
```sql
-- find_money_paths: recursive CTE for tracing money flows between entities
-- find_connections: find all paths between two entities up to N hops
-- get_entity_network: get all entities within N hops of a given entity
-- calculate_donor_vote_alignment: correlation between donor industries and voting record
```

Each function uses recursive CTEs with cycle detection (path array check) and configurable max depth.

**Migration 018 — Materialized Views:**
```sql
-- mv_official_top_donors: top 20 donors per official
-- mv_official_industry_funding: funding by industry per official
-- mv_corporate_influence_rankings: composite corporate influence scores
-- mv_judge_conflict_flags: judges with holdings matching case parties
```

Each view includes a `REFRESH MATERIALIZED VIEW CONCURRENTLY` capability (requires unique index).

**Commit after completion.**

---

## Phase 2: Data Import Pipelines (Tasks 21-26)

### Task 21: FEC Campaign Finance Import

**Files:**
- Create: `scripts/import-fec-contributions.ts`
- Create: `scripts/import-fec-committees.ts`
- Create: `scripts/import-fec-expenditures.ts`

Fetches from `api.open.fec.gov/v1/`:
- `/schedules/schedule_a/` — individual contributions (paginated, 100/page)
- `/committees/` — PAC and committee data
- `/schedules/schedule_e/` — independent expenditures

Creates entity records for donors, PACs, and candidates. Creates relationship records for donations and expenditures. Requires `FEC_API_KEY` env var. Batch upserts in groups of 500.

**Commit after completion.**

---

### Task 22: Lobbying Data Import

**Files:**
- Create: `scripts/import-lobbying.ts`

Fetches from Senate LDA API (`lda.senate.gov/api/v1/`):
- `/registrations/` — lobbying registrations
- `/filings/` — quarterly activity reports with amounts, bills lobbied, agencies contacted

Creates entities for lobbying firms and clients. Creates lobbying_registrations and lobbying_activities records. Links lobbyists to covered positions (revolving door).

**Commit after completion.**

---

### Task 23: Congressional Stock Trades Import

**Files:**
- Create: `scripts/import-stock-trades.ts`

Fetches from Quiver Quantitative API or House/Senate disclosure parsers:
- Congressional stock trades with ticker, amount range, trade date, disclosure date
- Calculates `days_late` (disclosure_date - trade_date - 45)
- Creates stock_trades and official_holdings records
- Links to existing officials via bioguide_id or name matching

**Commit after completion.**

---

### Task 24: Judicial Data Import

**Files:**
- Create: `scripts/import-judges.ts`
- Create: `scripts/import-judge-financials.ts`

FJC Judges Database (CSV download from `fjc.gov/history/judges`):
- All federal judges: name, court, appointing president, confirmation date, ABA rating
- Creates court and judge records

CourtListener API (`courtlistener.com/api/rest/v4/`):
- Financial disclosures, investment positions
- Creates judge_financial_disclosures and judge_investments records

**Commit after completion.**

---

### Task 25: Legislative Data Import (Bills & Votes)

**Files:**
- Create: `scripts/import-bills.ts`
- Create: `scripts/import-votes.ts`

Congress.gov API (`api.congress.gov/v3/`):
- `/bill/` — current session bills with sponsors, cosponsors, subjects, status
- `/vote/` — roll call votes with member positions

Creates bills, bill_actions, bill_sponsors, roll_call_votes, vote_positions records. Links to existing officials via bioguide_id.

**Commit after completion.**

---

### Task 26: Polling & Prediction Market Import

**Files:**
- Create: `scripts/import-polls.ts`
- Create: `scripts/import-predictions.ts`

Polling: FiveThirtyEight data downloads (CSV) for polling averages and pollster ratings.

Prediction Markets: Kalshi API (`trading-api.kalshi.com/trade-api/v2/`) for election and policy contracts with current probabilities and volume. Polymarket on-chain data via public API.

**Commit after completion.**

---

## Phase 3: Visualization Components (Tasks 27-30)

### Task 27: Money Graph Visualization (Cytoscape.js)

**Files:**
- Create: `src/components/graph/MoneyGraph.tsx`
- Create: `src/components/graph/GraphSidebar.tsx`
- Create: `src/components/graph/GraphControls.tsx`

**MoneyGraph.tsx:** React component wrapping Cytoscape.js.
- Props: `{ initialEntityId?: string, initialQuery?: string }`
- Fetches graph data from `/api/money-graph` endpoint
- Renders interactive force-directed graph with zoom/pan
- Node types color-coded: officials (navy), PACs (gold), corporations (slate), individuals (blue)
- Edge types styled: donations (green), lobbying (orange), contracts (red)
- Click node → sidebar shows entity details + "make center" button
- Click edge → sidebar shows transaction details with filing links
- Controls: depth slider (1-5 hops), amount threshold, date range, relationship type toggles
- Layout options: force-directed, hierarchical, circular

**GraphSidebar.tsx:** Entity/relationship detail panel with links to profile pages.

**GraphControls.tsx:** Depth, filters, layout selector, export button.

Install: `npm install cytoscape @types/cytoscape`

**Commit after completion.**

---

### Task 28: Sankey Flow Diagram (D3)

**Files:**
- Create: `src/components/graph/SankeyFlow.tsx`

D3 Sankey diagram for money flow visualization.
- Shows money flowing from donors → PACs → candidates
- Or from corporations → lobbying firms → bills
- Interactive: hover shows amounts, click navigates
- Used on official profiles ("Where does the money come from?") and industry pages

Install: `npm install d3 d3-sankey @types/d3 @types/d3-sankey`

**Commit after completion.**

---

### Task 29: Chart Components (Chart.js)

**Files:**
- Create: `src/components/charts/PollChart.tsx`
- Create: `src/components/charts/PredictionChart.tsx`
- Create: `src/components/charts/TradeTimeline.tsx`

**PollChart.tsx:** Line chart showing polling averages over time with confidence bands. Supports multi-candidate races.

**PredictionChart.tsx:** Real-time probability chart for prediction market contracts. Shows odds movement over time with event annotations.

**TradeTimeline.tsx:** Scatter/bar chart showing congressional stock trades over time, colored by buy/sell, sized by amount range. Vertical lines for related votes/committee actions.

Install: `npm install chart.js react-chartjs-2`

**Commit after completion.**

---

### Task 30: Conflict Alert Components

**Files:**
- Create: `src/components/alerts/ConflictCard.tsx`
- Create: `src/components/alerts/ConflictFeed.tsx`
- Create: `src/components/alerts/SeverityBadge.tsx`

**ConflictCard.tsx:** Card displaying a single conflict alert with severity badge, involved entities, evidence summary, and links.

**ConflictFeed.tsx:** Filterable, paginated feed of conflict alerts. Filters: alert type, severity, entity, date range.

**SeverityBadge.tsx:** Color-coded badge (Critical=red, High=orange, Medium=gold, Low=slate).

**Commit after completion.**

---

## Phase 4: Pillar 2 Pages & API (Tasks 31-35)

### Task 31: Money Graph API Endpoint

**Files:**
- Create: `src/pages/api/money-graph.ts`
- Create: `src/pages/api/entity.ts`

**`/api/money-graph`:** SSR endpoint accepting:
- `entity_id` — center entity
- `depth` (1-5) — how many hops
- `min_amount` — minimum relationship amount
- `types[]` — relationship type filter
- Returns: `{ nodes: Entity[], edges: Relationship[] }` in Cytoscape-compatible format

**`/api/entity`:** Entity detail endpoint for sidebar popups.
- `id` — entity UUID
- Returns entity with all detail table data and top relationships

**Commit after completion.**

---

### Task 32: Money Graph Explorer Page

**Files:**
- Create: `src/pages/money/index.astro`
- Create: `src/pages/money/graph.astro`
- Create: `src/pages/money/dark-money.astro`

**`/money/index.astro`:** Follow the Money hub page — overview stats, entry points to graph explorer, dark money tracker, lobbying, stock trades.

**`/money/graph.astro`:** Full-screen Money Graph Explorer (SSR).
- `export const prerender = false`
- Reads `?entity=` from query params
- Renders MoneyGraph component with controls
- Pre-built views: "Top donors," "Dark money networks," "Industry clusters"

**`/money/dark-money.astro`:** Dark money tracker — 501(c)(4) directory, flow visualization, dark money index per race.

**Commit after completion.**

---

### Task 33: Lobbying Dashboard Pages

**Files:**
- Create: `src/pages/money/lobbying/index.astro`
- Create: `src/pages/api/lobbying.ts`

**`/money/lobbying/index.astro`:** SSR page with search by bill, official, industry, or lobbying firm. Results show lobbying activity, amounts, bills lobbied, agencies contacted.

**`/api/lobbying`:** Endpoint supporting filters: `bill_id`, `official_id`, `industry`, `firm_id`, `date_range`.

**Commit after completion.**

---

### Task 34: Congressional Stock Tracker Pages

**Files:**
- Create: `src/pages/money/stocks/index.astro`
- Create: `src/pages/api/stock-trades.ts`

**`/money/stocks/index.astro`:** SSR page with:
- Searchable/filterable table of all trades (by member, party, chamber, ticker, date)
- "Suspicious timing" flags for trades near related votes
- Late filing tracker
- Aggregate stats: Congress vs S&P 500

**`/api/stock-trades`:** Endpoint with filters: `official_id`, `ticker`, `party`, `chamber`, `date_range`, `suspicious_only`.

**Commit after completion.**

---

### Task 35: Enhanced Official Profiles

**Files:**
- Modify: `src/pages/officials/[slug].astro`

Enhance existing official profile pages with Pillar 2 data:
- Top donors section (from contributions table)
- Stock trades summary with TradeTimeline chart
- Lobbying activity (who's lobbying this official)
- Donor-vote alignment score
- Transparency scorecard
- "View full money graph" link to `/money/graph?entity={id}`
- SankeyFlow showing money sources

**Commit after completion.**

---

## Phase 5: Pillar 3 Pages & API (Tasks 36-40)

### Task 36: Conflict Detection Engine

**Files:**
- Create: `scripts/detect-conflicts.ts`
- Create: `src/pages/api/conflicts.ts`

**`detect-conflicts.ts`:** Scheduled script that runs conflict detection queries:
- Donor-Vote: official received >$X from industry, voted on related bill
- Stock-Committee: official holds stock in company regulated by their committee
- Trade-Timing: stock trade within N days of related vote
- Judicial-Financial: judge holds stock in case party
- Contract-Donor: federal contract to company that donated to relevant legislator

Each detected conflict gets a severity score: `f(dollar_amount, timing_proximity, directness)`. Upserts into `conflict_alerts` table.

**`/api/conflicts`:** SSR endpoint with filters: `alert_type`, `severity_min`, `entity_id`, `date_range`. Returns paginated alerts.

**Commit after completion.**

---

### Task 37: Conflict Alert Feed & Pages

**Files:**
- Create: `src/pages/conflicts/index.astro`
- Create: `src/pages/api/alerts/feed.ts`

**`/conflicts/index.astro`:** SSR page showing conflict alert feed with ConflictFeed component. Filters by type, severity, entity. "Worst offenders" leaderboard sidebar.

**`/api/alerts/feed`:** RSS/JSON feed endpoint for alerts. Supports format query param (`rss` or `json`). Filterable by type and severity.

**Commit after completion.**

---

### Task 38: Judicial Transparency Center

**Files:**
- Create: `src/pages/judicial/index.astro`
- Create: `src/pages/judicial/[slug].astro`
- Create: `src/pages/api/judicial.ts`

**`/judicial/index.astro`:** Hub page with court structure explorer, SCOTUS justices, conflict flags, vacancy tracker.

**`/judicial/[slug].astro`:** Individual judge profile (static via getStaticPaths):
- Biographical data, appointing president, confirmation vote, ABA rating
- Political chain: who nominated → who confirmed → who funded confirming senators
- Financial disclosures and holdings
- Conflict flags (holdings matching case parties)
- Sentencing analysis (deviation from guidelines)
- Decision history

**`/api/judicial`:** Endpoint for judge search, case lookup, conflict queries.

**Commit after completion.**

---

### Task 39: Predictions & Markets Pages

**Files:**
- Create: `src/pages/predictions/index.astro`
- Create: `src/pages/api/predictions.ts`

**`/predictions/index.astro`:** SSR page showing:
- Current polling averages with PollChart
- Prediction market odds with PredictionChart
- Polls vs markets comparison
- Anomaly alerts (suspicious market activity)
- Historical accuracy tracker

**`/api/predictions`:** Endpoint for polling data, prediction contracts, anomaly queries.

**Commit after completion.**

---

### Task 40: Navigation Update & Integration

**Files:**
- Modify: `src/components/Header.astro`
- Modify: `src/pages/index.astro`
- Modify: `src/components/Header.astro`

Update navigation to reflect three-pillar structure:
```
[MAP] [Navigate ▼] [Follow the Money ▼] [Connect the Dots ▼] [Search]
```

Update homepage category grid to link to new pillar pages. Add global search component.

**Commit after completion.**

---

## Phase 6: Polish & Infrastructure (Tasks 41-43)

### Task 41: Entity Resolution Pipeline

**Files:**
- Create: `scripts/lib/entity-resolver.ts`
- Create: `scripts/resolve-entities.ts`

Shared library for matching entities across data sources:
1. Deterministic matching: FEC IDs, EINs, bioguide IDs, tickers
2. Fuzzy matching: normalized names, Jaro-Winkler similarity
3. Contextual matching: same address, industry, associated people
4. Confidence scoring: 0-1 score per match
5. Manual overrides: curated merge/split list

**Commit after completion.**

---

### Task 42: Data Pipeline Orchestration

**Files:**
- Modify: `package.json` — add all new import scripts
- Create: `scripts/pipeline-daily.ts` — daily pipeline runner
- Create: `scripts/pipeline-weekly.ts` — weekly pipeline runner
- Create: `.github/workflows/data-pipeline.yml` — scheduled CI for data refresh

Pipeline schedule:
- DAILY: FEC filings, Congress.gov actions, Federal Register, prediction markets, stock trades
- WEEKLY: Lobbying filings, CourtListener, USAspending, polling, EPA/OSHA
- MONTHLY: IRS 990, FARA, Census, FollowTheMoney
- After each run: refresh materialized views, run conflict detection, trigger rebuild

**Commit after completion.**

---

### Task 43: Final Build Verification & Deploy Prep

**Files:**
- Modify: `scripts/validate-data.ts` — add validation for all new tables
- Modify: `.env.example` — add all new API keys
- Modify: `.github/workflows/build.yml` — update build steps

Ensure all new pages build, all TypeScript compiles, all API endpoints respond. Update data validation to check for Pillar 2/3 table records.

**Commit after completion.**

---

## Execution Order

```
Phase 1 (Graph Foundation): sequential
  Task 17 → Task 18 → Task 19 → Task 20

Phase 2 (Data Pipelines): parallel after Phase 1
  Task 21 (FEC)      ─┐
  Task 22 (Lobbying)  ├─ all parallel
  Task 23 (Stocks)    │
  Task 24 (Judicial)  │
  Task 25 (Bills)     │
  Task 26 (Polls)    ─┘

Phase 3 (Visualization): parallel after Phase 1
  Task 27 (Money Graph)    ─┐
  Task 28 (Sankey)          ├─ all parallel
  Task 29 (Charts)          │
  Task 30 (Conflict Cards) ─┘

Phase 4 (Pillar 2 Pages): after Phases 2+3
  Task 31 (Graph API) → Task 32 (Graph Page)
  Task 33 (Lobbying Page)  ─┐
  Task 34 (Stocks Page)     ├─ parallel
  Task 35 (Profile Update) ─┘

Phase 5 (Pillar 3 Pages): after Phase 4
  Task 36 (Conflict Engine) → Task 37 (Alert Feed)
  Task 38 (Judicial Pages) ─┐
  Task 39 (Predictions)     ├─ parallel
  Task 40 (Nav Update)     ─┘

Phase 6 (Polish): after Phase 5
  Task 41 → Task 42 → Task 43
```

Total: 27 tasks across 6 phases.
