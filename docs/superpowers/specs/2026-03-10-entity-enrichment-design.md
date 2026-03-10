# Entity Enrichment & Insight Dashboard Design

## Overview

Enrich profiles of politicians, judiciary, lobbyists, NGOs, and lobbying firms with data from 10 new sources to build comprehensive biographical and relationship profiles. Surface this data through three audience-specific entry points designed around cognitive psychology principles for maximum transparency and usability.

## New Data Sources

| Source | Data | Entity Types | API Type | Rate Limits |
|--------|------|-------------|----------|-------------|
| Wikidata | Bio, education, career, family, board seats, photos | All people + orgs | Free REST/SPARQL | Generous |
| OpenCorporates | Officers, directorships, filings, subsidiaries | Corps, lobbying firms, NGOs | Free (200/day, API key for more) | Moderate |
| Crunchbase Basic | Funding, investors, key people, acquisitions | High-profile corps/startups | Free 200/month | Tight — priority queue |
| ICIJ Offshore Leaks | Offshore entities, intermediaries, officers | All | Free bulk download | None (bulk) |
| OpenSanctions | Sanctions, PEP lists, watchlists | All people + orgs | Free bulk download | None (bulk) |
| Ballotpedia | Election history, candidate bios, ballot measures | Officials, candidates | Free for civic | Moderate |
| FARA | Foreign agent registrations, payments, contacts | Lobbyists, firms, foreign principals | Scrape/bulk from DOJ | Semi-structured |
| OpenSecrets Bulk | Revolving door, personal finances, bundlers | Officials, lobbyists | Free bulk download | None (bulk) |
| FEC Bulk/EFILING | Committee-to-committee transfers, deep filings | PACs, committees | Free bulk | None (bulk) |
| USAspending Sub-awards | Contractor/sub-contractor chains | Corps, officials (via committees) | Free REST | Generous |

## Schema Changes

### New External IDs (entities.external_ids JSONB)

```
wikidata_id, wikipedia_url, opencorporates_id, crunchbase_slug,
icij_node_id, opensanctions_id, ballotpedia_url, fara_reg_id,
opensecrets_id, linkedin_url (discovered via Wikidata, not scraped)
```

### New Table: entity_profiles (1:1 with entities, for people)

| Field | Source | Purpose |
|-------|--------|---------|
| bio_summary | Wikidata/Wikipedia | 2-3 sentence plain-English bio |
| education | Wikidata | Array of {institution, degree, field, year} |
| career_history | Wikidata + OpenSecrets | Array of {org, role, start, end, is_government} |
| net_worth_estimate | OpenSecrets PFD | Range (low/high) from personal financial disclosures |
| birth_date, birth_place | Wikidata | Demographics |
| spouse, family_connections | Wikidata | Names + entity_ids where resolved |
| photo_url | Wikidata (Commons) | Fallback when Bioguide/CourtListener missing |
| sanctions_flags | OpenSanctions | Array of {list, reason, date} |
| offshore_connections | ICIJ | Array of {entity_name, jurisdiction, relationship, paper} |
| revolving_door_history | OpenSecrets | Array of {from_org, to_org, date, type} |
| foreign_agent_status | FARA | {is_registered, principal, country, compensation} |
| last_enriched_at | System | Staleness tracking |

### New Table: org_profiles (1:1 with entities, for orgs)

| Field | Source | Purpose |
|-------|--------|---------|
| description | Wikidata/Crunchbase | What does this org do |
| industry, sector | OpenCorporates/Crunchbase | Classification |
| founded_date, headquarters | Wikidata/OpenCorporates | Basics |
| subsidiaries | OpenCorporates | Corporate tree |
| officers_directors | OpenCorporates | Array of {name, role, entity_id} |
| funding_rounds | Crunchbase | VC/PE funding (high-profile only) |
| government_contracts | USAspending | Total value, agency breakdown |
| offshore_connections | ICIJ | Same as people |
| sanctions_flags | OpenSanctions | Same as people |
| irs_990_summary | ProPublica | Revenue, expenses, top compensation |
| last_enriched_at | System | Staleness tracking |

### New Relationship Types

```
studied_at, worked_at, officer_of, subsidiary_of,
sanctioned_by, offshore_entity_of, foreign_agent_for,
contracted_with, sub_contracted_to, funded_by, acquired
```

## UI/UX Design

### Core Psychology Principles

**Progressive disclosure** (Sweller's Cognitive Load Theory) — Lead with signals, let users drill down. Surface the most anomalous/important data first rather than dumping everything at once.

**Negativity bias** (Kahneman & Tversky) — People pay 2-3x more attention to threats/risks. Conflict alerts, sanctions flags, offshore connections, and revolving door data get visual prominence.

**Comparison anchoring** — Every metric needs a benchmark. "$500K from pharma" becomes meaningful when shown against "committee avg: $120K."

**Gestalt proximity** — Related information clusters together. A donor, the vote they influenced, and the subsequent stock trade appear as a connected narrative.

### Three Entry Points

#### 1. Citizen Dashboard — "My Government" (`/dashboard`)

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
- **Sparklines everywhere**: Tiny trend charts next to every metric
- **Graph density as signal**: Cluttered constellation = unusually dense network
- **Temporal animation**: Scrub through time on timelines and money flows

## Component Architecture

### New Pages

| Route | Purpose | Audience |
|-------|---------|----------|
| `/dashboard` | ZIP-entry → My Government overview | Citizens |
| `/explore` | Power Dashboard — system-wide insights | Watchdogs, journalists |
| `/explore/sectors/[sector]` | Industry deep-dive | All |
| `/explore/money-flows` | Sankey flow explorer | Journalists, watchdogs |
| `/compare` | Side-by-side entity comparison | All |

### Shared Components

| Component | Used By | Description |
|-----------|---------|-------------|
| `TransparencyGrade` | All profiles, dashboard | Letter grade badge with tooltip breakdown |
| `RedFlagSidebar` | All profiles | Severity-sorted conflict/sanctions/offshore alerts |
| `MetricStrip` | All profiles, dashboard | 5-7 sparkline cards with comparison anchors |
| `NarrativeTimeline` | All profiles | Chronological merged feed — career, donations, votes, trades, lobbying |
| `RelationshipConstellation` | All profiles, explore | Cytoscape.js immediate network graph |
| `MoneyFlowSankey` | Explore, profiles | D3 Sankey, filterable by sector/time |
| `ComparisonStrip` | Profiles, compare | "vs median" bars for key metrics |
| `AnomalyFeed` | Explore, dashboard | Real-time unusual pattern feed |
| `SectorHeatmap` | Explore | Industry × metric heatmap |
| `EntitySearch` | Global nav | Unified search with type-ahead |

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

- `mv_entity_red_flags` — union of conflicts, sanctions, offshore, late filings per entity
- `mv_sector_money_flows` — industry → PAC → official aggregation for Sankey
- `mv_entity_metrics` — pre-computed sparkline data (monthly aggregates) per entity
- `mv_anomaly_scores` — statistical outliers across all metrics (z-scores)
- `mv_comparison_medians` — median values per metric per cohort (chamber, committee, state)

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

### Crunchbase Priority Queue

200 calls/month = ~6/day. Priority score:
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

### Anomaly Detection

After materialized view refresh:
- Compute z-scores per entity per metric relative to cohort (chamber, committee, state)
- Flag >2 standard deviations as anomalous
- Feed into `mv_anomaly_scores` and `AnomalyFeed` component
- Types: unusual donor concentration, trading frequency spikes, sudden new lobbying contacts, offshore connections in previously clean profiles

### Error Handling & Observability

- `enrichment_runs` table: source, entities_processed, entities_enriched, errors, duration
- Failed enrichments retry 3x with backoff, then log to `enrichment_errors`
- Dev-only dashboard at `/admin/enrichment` showing pipeline health, staleness, error rates
