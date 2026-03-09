# GovGuide — Product & Technical Design

**Date:** 2026-03-08
**Status:** Approved

---

## Mission

A free, public, comprehensive dashboard mapping every level of US government — making democracy navigable and voting accessible. No accounts, no paywalls, no gatekeeping.

---

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Framework | Astro (hybrid mode) | Static pages + server endpoints; islands architecture for selective interactivity |
| Maps | MapLibre GL JS + PMTiles | Vector tiles for smooth zoom/pan across 3,143 counties and 19,000+ cities |
| Database | Supabase (PostgreSQL + PostGIS) | Relational model fits government hierarchy; PostGIS for geospatial queries |
| Auth | None | Completely public, no user accounts |
| Hosting | TBD | |
| Repo | thegovguide GitHub org | |

---

## Content Scope

### Federal
- Three branches of government (Executive, Legislative, Judicial)
- Cabinet departments (15)
- Independent agencies and three-letter agencies (400+)
- All members of Congress (535 + delegates)
- Supreme Court justices and federal courts
- Executive orders in effect
- Federal laws (U.S. Code), regulations (CFR)
- Federal budget and spending data

### State (x50 + DC + territories)
- Governor, lieutenant governor, attorney general, secretary of state
- State legislators
- State agencies and departments
- State courts
- State statutes and administrative codes
- State election offices and rules

### County (3,143 equivalents)
- County officials (commissioners, judges, sheriffs, clerks)
- County agencies and services
- County ordinances and codes
- County election authorities

### City (19,000+ incorporated places)
- Mayor, city council, local officials
- Municipal departments
- Municipal codes and ordinances
- Local election information

### Elections & Voting (all levels)
- Voter registration links and requirements by state
- Ballot tracking (where available; fallback message where not)
- Candidate information at all levels
- Ballot measures and initiatives
- Upcoming election dates and deadlines
- Historical election data where available

### Laws & Regulations (all levels)
- U.S. Code and CFR (federal)
- Executive orders (federal and state)
- State statutes and administrative codes
- County and municipal codes

---

## Data Sources

### Federal
- Congress.gov / GovInfo Bulk Data — legislation, bills, members
- ProPublica Congress API — congressional data
- FEC API — campaign finance
- Federal Register API — executive orders, regulations
- USA.gov / U.S. Government Manual — agency directory
- Google Civic Information API — officials and elections
- USAspending API — federal budget
- Census Bureau APIs — demographics, geography
- TIGER/Line — boundary shapefiles
- dotgov-data (GitHub) — .gov domain registry
- Supreme Court website — opinions, justices

### State
- OpenStates API — state legislators, bills
- State official portals (50 unique sources)
- NASS — secretary of state directory
- Ballotpedia — officials, elections, ballot measures

### County
- Census county reference data (FIPS codes, populations)
- NACo County Explorer — county government data
- County official websites (3,143 sources, scraping required)

### City
- Census incorporated places data
- Municipal code libraries (Municode, American Legal, Code Publishing)
- City official websites (scraping required for many)

### Cross-Cutting
- HUD USPS ZIP-to-county crosswalk
- Census ZIP Code Tabulation Areas
- Vote.gov — registration links
- Democracy Works / VIP — election data

---

## UX & Information Architecture

### Design Philosophy
Modern civic design (clean, authoritative, accessible) with Erowid-style information architecture (dense categories, drill-down navigation, reference-format content).

### Homepage
- Full-screen interactive US map (MapLibre GL JS)
- Scope switcher tabs: Federal | States | Counties | Districts
- ZIP code search bar: "Enter your ZIP code" → returns all relevant jurisdictions
- Category navigation below map (Erowid-style)

### Navigation Model
- Top-down drill-down: US → State → County → City
- Breadcrumb trail on every page
- Scope switcher on map changes active layer
- Category sidebar: Government Structure | Elections | Laws | Officials

### Page Types
1. **Federal overview** — branches, agencies, officials
2. **Agency detail** — mission, leadership, parent department, key regulations
3. **State overview** — executive, legislative, judicial structure, key officials
4. **County overview** — officials, services, election authority
5. **City overview** — officials, services, municipal info
6. **Election toolbox** — ZIP-driven, registration, tracking, candidates
7. **Law/regulation index** — by level, category, and jurisdiction
8. **Official profile** — name, role, jurisdiction, contact, term info

### Map Interaction
- One active layer at a time (scope switcher pattern)
- Inactive layers muted/hidden
- Click feature → navigate to that jurisdiction's page
- Federal mode: map becomes orientation-only, federal info panel appears
- Smooth vector tile zoom from national to county level

### Voter Toolbox Flow
1. User enters ZIP code
2. System resolves ZIP → state, county, city, congressional district
3. Returns: registration link, ballot tracking link, upcoming elections, candidates
4. If jurisdiction doesn't offer ballot tracking: "This service is not offered by your state government."

---

## Architecture

### Static Pages (built at build time)
- Government structure pages (federal, state, county, city)
- Agency directory
- Official profiles (slow-changing data)
- Law/regulation index pages

### Server Endpoints (Astro SSR)
- `GET /api/zip-lookup` — ZIP to jurisdictions
- `GET /api/elections` — current election data by jurisdiction
- `GET /api/officials` — officials by jurisdiction
- `GET /api/ballot-tracking` — redirect to state ballot tracking or fallback

### Data Pipeline
- Import scripts pull from APIs and scraped sources into Supabase
- Build-time export from Supabase generates JSON/MDX for Astro content collections
- Server endpoints query Supabase directly for dynamic data
- Scheduled rebuilds keep static content current

### Database Schema (high-level)
- `jurisdictions` — hierarchical (federal → state → county → city), PostGIS geometry
- `officials` — linked to jurisdictions and offices
- `offices` — positions within jurisdictions
- `agencies` — linked to jurisdictions, parent/child hierarchy
- `elections` — linked to jurisdictions, candidates, measures
- `candidates` — linked to elections and offices
- `laws` — linked to jurisdictions by level
- `election_services` — registration URLs, ballot tracking URLs by state
- `zip_jurisdictions` — ZIP to jurisdiction mapping

---

## Key Design Decisions

1. **No user accounts** — completely free and public
2. **Hybrid rendering** — static for structure, server for dynamic lookups
3. **MapLibre over Leaflet** — vector tiles handle the scale of all US jurisdictions
4. **Supabase over flat files** — relational model matches government hierarchy
5. **Scope switcher over disambiguation popups** — cleaner UX for overlapping geographies
6. **ZIP-first voter toolbox** — lowest friction entry point for election info
7. **Fallback messages over broken links** — honest about what jurisdictions offer
8. **Build everything at once** — no phased rollout, full geographic and content coverage from launch
