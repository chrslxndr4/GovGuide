# Entity Enrichment & Insight Dashboard Design

## Overview

Enrich profiles of politicians, judiciary, lobbyists, NGOs, and lobbying firms with data from 10 new sources to build comprehensive biographical and relationship profiles. Surface this data through three audience-specific entry points designed around cognitive psychology principles for maximum transparency and usability.

## New Data Sources

| Source | Data | Entity Types | API Type | Rate Limits |
|--------|------|-------------|----------|-------------|
| Wikidata | Bio, education, career, family, board seats, photos | All people + orgs | Free REST/SPARQL | Generous |
| OpenCorporates | Officers, directorships, filings, subsidiaries | Corps, lobbying firms, NGOs | Free (200/day, API key for more) | Moderate |
| Crunchbase Basic | Funding, investors, key people, acquisitions | High-profile corps/startups | Free 200/month (verify — may require paid tier as of mid-2025) | Tight — priority queue |
| ICIJ Offshore Leaks | Offshore entities, intermediaries, officers | All | Free bulk download | None (bulk) |
| OpenSanctions | Sanctions, PEP lists, watchlists | All people + orgs | Free bulk download | None (bulk) |
| Ballotpedia | Election history, candidate bios, ballot measures | Officials, candidates | Free for civic | Moderate |
| FARA | Foreign agent registrations, payments, contacts | Lobbyists, firms, foreign principals | Extends existing `entity_foreign_principals` (migration 024) with DOJ bulk data | Semi-structured |
| OpenSecrets Bulk | Revolving door, personal finances, bundlers | Officials, lobbyists | Free bulk download | None (bulk) |
| FEC Bulk/EFILING | Committee-to-committee transfers, deep filings | PACs, committees | Free bulk | None (bulk) |
| USAspending Sub-awards | Contractor/sub-contractor chains | Corps, officials (via committees) | Free REST | Generous |

> **Note on Crunchbase:** The free Basic API tier may have been deprecated in favor of paid Enterprise access. Verify current terms before implementing the priority queue. If unavailable, drop Crunchbase and rely on OpenCorporates + Wikidata for corporate data.

## Schema Changes

### Relationship to Existing Tables

This design **extends** existing tables rather than replacing them:

| New Concept | Existing Table | Approach |
|-------------|---------------|----------|
| Person enrichment (bio, birth, photo) | `entity_persons` (migration 007) | `ALTER TABLE entity_persons ADD COLUMN` for scalar fields |
| Org enrichment (description, industry) | `entity_corporations`, `entity_nonprofits`, `entity_lobbying_firms` | `ALTER TABLE` each with relevant new columns |
| Education, career, board seats | `relationships` table | New rows with existing/new relationship types — NOT JSONB arrays |
| Sanctions, offshore flags | New `entity_flags` table | Structured rows, not JSONB arrays, for queryability |
| Foreign agent data | `entity_foreign_principals` (migration 024) | Extend with additional FARA fields |

**Key principle:** Structured data that needs to be queried (career history, education, board seats, offshore connections) lives as rows in the `relationships` table. Profile tables store only scalar summary fields for fast rendering. The relationship graph is the source of truth; profile fields are denormalized caches.

### New External IDs (entities.external_ids JSONB)

```
wikidata_id, wikipedia_url, opencorporates_id, crunchbase_slug,
icij_node_id, opensanctions_id, ballotpedia_url, fara_reg_id,
opensecrets_id, linkedin_url (discovered via Wikidata, not scraped)
```

> **Note:** `littlesis_id` was added as a dedicated column on `entities` in migration 021, breaking the JSONB-only pattern. New external IDs will use the JSONB field consistently. Consider migrating `littlesis_id` into `external_ids` in a future cleanup.

### ALTER TABLE: entity_persons (extends migration 007)

| New Column | Type | Source | Purpose |
|------------|------|--------|---------|
| bio_summary | TEXT | Wikidata/Wikipedia | 2-3 sentence plain-English bio |
| net_worth_low | BIGINT | OpenSecrets PFD | Net worth range lower bound |
| net_worth_high | BIGINT | OpenSecrets PFD | Net worth range upper bound |
| birth_date | DATE | Wikidata | Date of birth |
| birth_place | TEXT | Wikidata | Place of birth |
| photo_url_fallback | TEXT | Wikidata Commons | Fallback when Bioguide/CourtListener missing |
| last_enriched_at | TIMESTAMPTZ | System | Staleness tracking |

### ALTER TABLE: entity_corporations (extends existing)

| New Column | Type | Source | Purpose |
|------------|------|--------|---------|
| description | TEXT | Wikidata/Crunchbase | What does this org do |
| industry | TEXT | OpenCorporates/Crunchbase | Industry classification |
| sector | TEXT | OpenCorporates/Crunchbase | Sector classification |
| founded_date | DATE | Wikidata/OpenCorporates | When founded |
| headquarters | TEXT | Wikidata/OpenCorporates | HQ location |
| govt_contract_total | BIGINT | USAspending | Total government contract value |
| last_enriched_at | TIMESTAMPTZ | System | Staleness tracking |

### ALTER TABLE: entity_nonprofits (extends existing)

| New Column | Type | Source | Purpose |
|------------|------|--------|---------|
| description | TEXT | Wikidata | What does this org do |
| irs_990_revenue | BIGINT | ProPublica | Most recent annual revenue |
| irs_990_expenses | BIGINT | ProPublica | Most recent annual expenses |
| irs_990_top_compensation | JSONB | ProPublica | Top 5 compensated officers {name, title, amount} |
| last_enriched_at | TIMESTAMPTZ | System | Staleness tracking |

### New Table: entity_flags

Queryable structured flags replacing JSONB arrays. Each flag is a row.

| Column | Type | Purpose |
|--------|------|---------|
| id | UUID PK | |
| entity_id | UUID FK → entities | Who is flagged |
| flag_type | ENUM (sanction, pep, offshore, watchlist, foreign_agent) | Category |
| source | TEXT | OpenSanctions, ICIJ, FARA, etc. |
| source_id | TEXT | ID in the source system |
| list_name | TEXT | Specific sanctions list / ICIJ paper name |
| reason | TEXT | Why flagged |
| jurisdiction | TEXT | Country/jurisdiction |
| date_added | DATE | When the flag was created in the source |
| date_removed | DATE | If the flag was lifted |
| metadata | JSONB | Source-specific extra data |
| created_at | TIMESTAMPTZ | |

### New Relationship Types (additions to existing enum)

Reconciled with existing enum values to avoid duplicates:

| New Type | Purpose | Replaces/Extends |
|----------|---------|-----------------|
| `subsidiary_of` | Corporate tree | New |
| `sanctioned_by` | Entity → sanctioning body | New |
| `offshore_entity_of` | Person/org → offshore entity | New |
| `foreign_agent_for` | Lobbyist → foreign principal | New |
| `contracted_with` | Corp → government agency | New |
| `sub_contracted_to` | Prime contractor → sub | New |
| `funded_by` | Startup → investor | New |
| `acquired` | Corp → acquired corp | New |

**NOT adding** (already exist): `educated_at` (covers `studied_at`), `employed_by` (covers `worked_at`), `board_member` (covers `officer_of`), `family_of` (covers spouse/family).

### New Table: enrichment_runs

| Column | Type | Purpose |
|--------|------|---------|
| id | UUID PK | |
| source | TEXT | Pipeline source name |
| started_at | TIMESTAMPTZ | |
| completed_at | TIMESTAMPTZ | |
| entities_processed | INT | Total attempted |
| entities_enriched | INT | Successfully enriched |
| entities_skipped | INT | Already fresh |
| errors | INT | Failed |
| error_details | JSONB | Array of {entity_id, error_message} |
| duration_ms | INT | Wall clock time |

### New Table: enrichment_errors

| Column | Type | Purpose |
|--------|------|---------|
| id | UUID PK | |
| run_id | UUID FK → enrichment_runs | Which run |
| entity_id | UUID FK → entities | Which entity |
| source | TEXT | Which source |
| error_message | TEXT | What went wrong |
| retry_count | INT | How many retries attempted |
| resolved | BOOLEAN DEFAULT false | Manual resolution tracking |
| created_at | TIMESTAMPTZ | |

## Entity Resolution Strategy

Entity resolution is the hardest part of this pipeline. The approach uses three tiers:

### Tier 1: Deterministic Matching (auto-merge, confidence 1.0)

Match on unique external IDs across sources:
- Wikidata ID ↔ existing `bioguide_id`, `fec_id` (Wikidata stores these as properties)
- OpenCorporates company number ↔ existing `ein` in `entity_corporations`
- OpenSanctions often includes FEC IDs, bioguide IDs, Wikidata IDs
- ICIJ node IDs are self-contained but ICIJ includes country + DOB for cross-reference

### Tier 2: Fuzzy Matching (auto-merge if confidence ≥ 0.85)

When no external ID match exists:
- **Name similarity**: pg_trgm similarity on `entities.name` (threshold ≥ 0.7)
- **Plus contextual signals** (each adds to confidence):
  - Same birth year (±1 year): +0.15
  - Same state/jurisdiction: +0.10
  - Same organization affiliation: +0.10
  - Same role/title: +0.05
- Combined confidence must reach ≥ 0.85 for auto-merge

### Tier 3: Manual Review Queue (confidence 0.5–0.84)

- Potential matches below auto-merge threshold go to `entity_merge_candidates` table
- Fields: source_entity_id, target_entity_id, confidence_score, matching_signals (JSONB), reviewed (BOOLEAN)
- Dev-only review UI at `/admin/entity-review`

### Conflict Resolution

When two sources disagree on a field (e.g., different birth dates):
- Most recent source wins for mutable fields (title, role, address)
- Earliest source wins for immutable fields (birth_date, birth_place)
- Store all variants in `entities.metadata` under `source_conflicts` key for transparency

### ICIJ-Specific Handling

ICIJ data uses inconsistent name formats ("JOHN A SMITH" vs "John Arthur Smith"). Pre-processing step:
- Normalize to lowercase, strip middle initials, expand common abbreviations
- Match on normalized name + country + birth year (when available)
- ICIJ matches default to Tier 3 (manual review) unless a deterministic ID match exists

## Transparency Grade Formula

### Inputs & Weights

| Metric | Weight | Calculation |
|--------|--------|-------------|
| Financial disclosure timeliness | 20% | Days late on STOCK Act / judicial disclosure filings (0 = perfect, >30 = zero) |
| Donor concentration (HHI) | 20% | Herfindahl-Hirschman Index of donor industries (lower = more diverse = better) |
| Trade reporting lag | 15% | Average days between stock trade and disclosure (0-45 scale) |
| Conflict alert count | 15% | Number of active conflict alerts, severity-weighted |
| Voting attendance | 10% | % of votes participated in vs chamber median |
| Lobbying contact transparency | 10% | Whether lobbying contacts are disclosed beyond minimum requirements |
| Foreign agent / offshore flags | 10% | Binary flags with severity weighting |

### Grade Boundaries

| Grade | Score Range | Meaning |
|-------|------------|---------|
| A | 85–100 | Exemplary transparency |
| B | 70–84 | Above average |
| C | 55–69 | Average |
| D | 40–54 | Below average |
| F | 0–39 | Significant transparency concerns |

### Computation

- Each metric normalized to 0–100 scale
- Weighted sum produces overall score
- Stored in existing `transparency_scores` table with `methodology_version = 'v2'`
- Recomputed in Phase 7 of enrichment pipeline
- Component scores stored in `component_scores` JSONB for tooltip breakdown

## UI/UX Design

### Core Psychology Principles

**Progressive disclosure** (Sweller's Cognitive Load Theory) — Lead with signals, let users drill down. Surface the most anomalous/important data first rather than dumping everything at once.

**Negativity bias** (Kahneman & Tversky) — People pay 2-3x more attention to threats/risks. Conflict alerts, sanctions flags, offshore connections, and revolving door data get visual prominence.

**Comparison anchoring** — Every metric needs a benchmark. "$500K from pharma" becomes meaningful when shown against "committee avg: $120K."

**Gestalt proximity** — Related information clusters together. A donor, the vote they influenced, and the subsequent stock trade appear as a connected narrative.

### Three Entry Points

#### 1. Citizen Dashboard — "My Government" (`/voter-toolbox`)

> **Note:** This extends the existing `/voter-toolbox` route from the expanded design doc, not a new `/dashboard` route.

- Entry: ZIP code or address (existing civic-lookup)
- Shows all officials who represent the user — federal, state, county, city
- Per official: Transparency grade (A-F), top 3 red flags, key stats (donor concentration, trade timing, missed votes)
- Comparison strip: How does your rep compare to state/national median
- Alert feed: Recent activity (new trades, filings, votes with donor conflicts)

#### 2. Entity Profile — "Who Is This Person/Org?"

Enhanced existing routes: `/officials/[slug]`, `/judicial/judges/[slug]`, `/entities/[slug]`

- **Hero section**: Photo, name, role, bio summary, transparency grade
- **At-a-glance strip**: 5-7 sparkline metric cards with comparison anchors
- **Narrative timeline**: Chronological merged feed — career, donations, votes, trades, lobbying contacts — telling the story of influence over time
- **Relationship constellation**: Cytoscape.js interactive graph of immediate network, edge thickness proportional to money/frequency
- **Deep-dive tabs**: Detailed tables per data domain (finances, voting, lobbying, judicial, contracts)
- **Red flag sidebar**: Always visible, severity-sorted — conflicts, sanctions, offshore, late filings

#### 3. Power Dashboard — "What's Happening?" (`/explore`)

- **Money flow Sankey**: Industry → PAC → Official → Vote, filterable by sector/timeframe/jurisdiction
- **Anomaly feed**: System-wide unusual patterns — trading spikes, new offshore connections, revolving door movements
- **Leaderboards**: Pattern surfacing — highest donor concentration, most late-filed trades, most lobbying contacts
- **Sector deep-dives** (`/explore/sectors/[sector]`): All officials, PACs, lobbyists, and money flows connected to an industry
- **Comparison tool** (`/compare`): Side-by-side any two entities on all metrics

### Visual Language

- **Traffic light severity**: Green/yellow/orange/red for conflict severity
- **Sparklines everywhere**: Tiny trend charts next to every metric — monthly aggregates over trailing 24 months for all financial/activity metrics
- **Graph density as signal**: Cluttered constellation = unusually dense network
- **Temporal animation**: Scrub through time on timelines and money flows

## Component Architecture

### New Pages

| Route | Purpose | Audience |
|-------|---------|----------|
| `/voter-toolbox` (enhanced) | ZIP-entry → My Government overview | Citizens |
| `/explore` | Power Dashboard — system-wide insights | Watchdogs, journalists |
| `/explore/sectors/[sector]` | Industry deep-dive | All |
| `/explore/money-flows` | Sankey flow explorer | Journalists, watchdogs |
| `/compare` | Side-by-side entity comparison | All |

### Shared Components

| Component | Used By | Description |
|-----------|---------|-------------|
| `TransparencyGrade` | All profiles, dashboard | Letter grade badge with tooltip showing component scores |
| `RedFlagSidebar` | All profiles | Severity-sorted conflict/sanctions/offshore alerts from `entity_flags` + `conflict_alerts` |
| `MetricStrip` | All profiles, dashboard | 5-7 sparkline cards with comparison anchors (percentile vs cohort) |
| `NarrativeTimeline` | All profiles | Chronological merged feed via UNION query across relationships, contributions, votes, trades |
| `RelationshipConstellation` | All profiles, explore | Cytoscape.js immediate network graph |
| `MoneyFlowSankey` | Explore, profiles | D3 Sankey, filterable by sector/time |
| `ComparisonStrip` | Profiles, compare | "vs median" bars for key metrics |
| `AnomalyFeed` | Explore, dashboard | Unusual pattern feed from `mv_anomaly_scores` |
| `SectorHeatmap` | Explore | Industry × metric heatmap |
| `EntitySearch` | Global nav | Unified search with type-ahead |

### Narrative Timeline Data Flow

The timeline merges events from multiple tables via a SQL UNION ALL, materialized as `mv_entity_timeline`:

```sql
-- Simplified structure
SELECT entity_id, event_date, event_type, summary, metadata
FROM (
  -- Career events from relationships (employed_by, board_member)
  SELECT ... FROM relationships WHERE relationship_type IN ('employed_by', 'board_member', ...)
  UNION ALL
  -- Campaign contributions received
  SELECT ... FROM campaign_contributions
  UNION ALL
  -- Stock trades
  SELECT ... FROM stock_trades
  UNION ALL
  -- Votes
  SELECT ... FROM votes
  UNION ALL
  -- Lobbying contacts
  SELECT ... FROM lobbying_activities
)
ORDER BY event_date DESC
```

### Data Flow

```
Enrichment pipelines (cron) → Supabase tables
                                    ↓
                          Materialized views (daily refresh)
                                    ↓
              Astro SSR pages ← API endpoints → Client-side components
                                                    ↓
                                          Cytoscape / D3 / MapLibre
```

### New Materialized Views

Must be added to `refresh_all_materialized_views()` function (migration 022):

- `mv_entity_red_flags` — UNION of `conflict_alerts` + `entity_flags` per entity, severity-sorted
- `mv_sector_money_flows` — industry → PAC → official aggregation for Sankey (joins contributions, entities, entity_corporations)
- `mv_entity_metrics` — monthly aggregates over trailing 24 months per entity: donation totals, trade counts, lobbying contacts, vote attendance. One row per entity per month.
- `mv_anomaly_scores` — percentile ranks per entity per metric within cohort (chamber, committee, state). Uses `PERCENT_RANK() OVER (PARTITION BY cohort)` — distribution-agnostic, no normal distribution assumption.
- `mv_comparison_medians` — median values per metric per cohort for comparison anchoring
- `mv_entity_timeline` — UNION ALL of career, contributions, trades, votes, lobbying per entity, ordered by date

> **Note on anomaly detection:** Uses percentile ranks rather than z-scores. Campaign finance data is heavily right-skewed; percentile ranks are distribution-agnostic and more interpretable in the UI ("98th percentile for pharma donations" vs "2.3 standard deviations above mean").

## Enrichment Pipeline Design

### Execution Order

```
Phase 1 (Identity):   Wikidata → external IDs, bio, education, career
Phase 2 (Corporate):  OpenCorporates + Crunchbase Basic → org data, officers
Phase 3 (Risk):       ICIJ Offshore Leaks + OpenSanctions → flags (bulk import)
Phase 4 (Political):  Ballotpedia + OpenSecrets Bulk + FARA → election/revolving door/foreign agent
Phase 5 (Financial):  FEC Bulk/EFILING + USAspending Sub-awards → deep money flows
Phase 6 (Resolve):    Entity resolver pass — link new people/orgs to existing entities
Phase 7 (Compute):    Refresh materialized views, anomaly scores, transparency grades
```

### Phase Independence & Partial Failure

Each phase tracks its own `last_enriched_at` per entity per source. If Phase 2 fails:
- Phase 1's enrichment is preserved (already committed)
- Phase 2 can be retried independently
- Phases 3-5 can proceed (they don't depend on Phase 2 output)
- Phase 6 (resolve) and Phase 7 (compute) run after all data phases complete, regardless of partial failures
- `enrichment_runs` table records per-phase status for observability

### Crunchbase Priority Queue

200 calls/month = ~6/day (if free tier still available). Priority score:
```
priority = (relationship_count × 2) + (conflict_alert_count × 5) + (page_view_count × 1)
```
Top-scored un-enriched entities get fetched first. Track `crunchbase_enriched_at` to avoid re-fetching.

### Staleness & Refresh

| Source | Refresh Cycle | Trigger |
|--------|--------------|---------|
| Wikidata | Monthly | Cron + on-demand if stale >30 days |
| OpenCorporates | Monthly | Cron |
| Crunchbase | Never re-fetch | Priority queue only |
| ICIJ | On new data release | Manual (~yearly) |
| OpenSanctions | Weekly | Cron |
| Ballotpedia | Monthly | Cron |
| OpenSecrets | Quarterly | Bulk on release |
| FARA | Monthly | Cron scrape |
| FEC Bulk | Weekly | Cron |
| USAspending | Monthly | Cron |

### Batch Processing for Bulk Sources

Estimated volumes:
- Wikidata: ~10K entities (all current officials + judges + known lobbyists)
- OpenCorporates: ~5K org entities
- ICIJ Offshore Leaks: ~800K nodes (bulk import, match against our ~15K entities)
- OpenSanctions: ~400K entries (bulk import, match against our entities)
- OpenSecrets: ~50K revolving door records

Bulk imports (ICIJ, OpenSanctions, OpenSecrets) use batch processing: download full dataset, import to staging table, run entity resolution in batches of 1000, commit matched records to production tables.

### Anomaly Detection

After materialized view refresh:
- Compute percentile ranks per entity per metric within cohort (chamber, committee, state)
- Flag anything ≥95th percentile as notable, ≥99th as anomalous
- Feed into `mv_anomaly_scores` and `AnomalyFeed` component
- Types: unusual donor concentration, trading frequency spikes, sudden new lobbying contacts, offshore connections in previously clean profiles

### Error Handling & Observability

- `enrichment_runs` table logs every pipeline execution with counts and timing
- `enrichment_errors` table captures per-entity failures for retry/manual review
- Failed enrichments retry 3x with exponential backoff, then log for manual resolution
- Admin dashboard at `/admin/enrichment` (gated by `ADMIN_ENABLED` env var, excluded from production builds) showing pipeline health, staleness distribution, error rates
