# GovGuide — Expanded Product & Technical Design

**Date:** 2026-03-09
**Status:** Approved
**Builds on:** `2026-03-08-govguide-design.md` (original design)

---

## Mission (Expanded)

A free, public, comprehensive transparency platform that maps every level of US government — who holds power, who funds them, how they vote, what they regulate, and who benefits. Make democracy navigable, voting accessible, and corruption visible.

### Three Pillars

1. **Navigate** — Government structure, officials, elections, laws at every level
2. **Follow the Money** — Donor networks, PAC flows, dark money, lobbying, corporate influence, revolving door, congressional stock trading
3. **Connect the Dots** — Conflict of interest detection, judicial-political connections, voting-donor correlation, legislative text analysis, gerrymandering metrics, prediction market anomaly detection

### Core Questions Answered

- *Who represents me?* (at every level of government)
- *Who bought them?* (campaign finance, lobbying, dark money)
- *What did that buy?* (votes, legislation, judicial appointments, regulatory decisions)

---

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Framework | Astro (hybrid mode) | Static pages + server endpoints; islands architecture for selective interactivity |
| Maps | MapLibre GL JS + PMTiles | Vector tiles for smooth zoom/pan across 3,143 counties and 19,000+ cities |
| Database | Supabase (PostgreSQL + PostGIS) | Relational model + graph traversal via recursive CTEs; PostGIS for geospatial |
| Graph Visualization | Cytoscape.js (primary), D3 Sankey (flows), Sigma.js (large networks) | Graph theory operations, path finding, centrality analysis |
| Charts | Chart.js | Polling, prediction markets, time series |
| Auth | None | Completely public, no user accounts |
| Hosting | TBD | |
| Repo | thegovguide GitHub org | |

---

## Content Scope (Expanded)

### Federal
- Three branches of government (Executive, Legislative, Judicial)
- Cabinet departments (15) and independent agencies (400+)
- All members of Congress (535 + delegates)
- Supreme Court justices and all federal judges
- Executive orders in effect
- Federal laws (U.S. Code), regulations (CFR)
- Federal budget and spending data
- **New:** Campaign finance for all federal races
- **New:** Lobbying disclosures (who lobbied whom on what)
- **New:** Congressional stock trades and financial disclosures
- **New:** Judicial financial disclosures and conflict detection
- **New:** Federal contractor data cross-referenced with donors
- **New:** Foreign agent registrations (FARA)
- **New:** Regulatory comment analysis
- **New:** Sentencing data by judge

### State (×50 + DC + territories)
- Governor, lieutenant governor, attorney general, secretary of state
- State legislators
- State agencies and departments
- State courts
- State statutes and administrative codes
- State election offices and rules
- **New:** State-level campaign finance (via FollowTheMoney)
- **New:** State-level lobbying where available

### County (3,143 equivalents)
- County officials (commissioners, judges, sheriffs, clerks)
- County agencies and services
- County ordinances and codes
- County election authorities
- **New:** Federal spending in county
- **New:** Environmental enforcement in county

### City (19,000+ incorporated places)
- Mayor, city council, local officials
- Municipal departments
- Municipal codes and ordinances
- Local election information
- **New:** Local government navigation guides
- **New:** Community-contributed local data

### Elections & Voting (all levels)
- Voter registration links and requirements by state
- Ballot tracking (where available; fallback message where not)
- Candidate information with full money trail
- Ballot measures with funding sources (who's paying for/against)
- Upcoming election dates and deadlines
- Historical election data with spending analysis
- **New:** Polling aggregation (538-style)
- **New:** Prediction market odds (Polymarket, Kalshi, Metaculus)
- **New:** Prediction market anomaly detection

### Laws & Regulations (all levels)
- U.S. Code and CFR (federal)
- Executive orders (federal and state)
- State statutes and administrative codes
- County and municipal codes
- **New:** Regulation lifecycle tracking (proposed → comment → final)
- **New:** Who commented on proposed rules
- **New:** Legislative text comparison with model legislation

---

## Data Sources (Complete Inventory)

### Federal Campaign Finance & Political Money

| Source | API Endpoint | Auth | Rate Limit | Key Data |
|--------|-------------|------|------------|----------|
| FEC API | `api.open.fec.gov/v1/` | Free API key (api.data.gov) | 1,000/hr | Individual contributions, PAC spending, independent expenditures, candidate financials, committee filings |
| OpenSecrets API | `opensecrets.org/api` | Free API key | 200/day | Industry-coded donor aggregations, lobbying summaries, revolving door, dark money tracking |
| IRS 990 Bulk Data | AWS S3 `irs-form-990` | None | Unlimited (bulk) | Nonprofit financials, grants made (Sched I), political spending (Sched C), officer compensation |
| ProPublica Nonprofit Explorer | `projects.propublica.org/nonprofits/api/v2` | None | Reasonable use | Searchable 990 data, dark money org profiles |
| IRS 527 Disclosures | `forms.irs.gov/app/pod` | None | N/A | Political organization donors and expenditures |
| FollowTheMoney | `followthemoney.org` | Free account | Varies | State-level campaign finance, all 50 states standardized |
| FCC Political Ad Files | `publicfiles.fcc.gov` | None | N/A | TV/radio political ad purchases and spending |

### Lobbying & Foreign Influence

| Source | API Endpoint | Auth | Rate Limit | Key Data |
|--------|-------------|------|------------|----------|
| Senate LDA API | `lda.senate.gov/api/v1/` | None | Reasonable use | LD-1 registrations, LD-2 activity reports (bills lobbied, agencies contacted), LD-203 lobbyist contributions, covered positions (revolving door) |
| FARA Database | `efile.fara.gov/ords/fara/f?p=API:LANDING` | None | Reasonable use | Foreign agent registrations, foreign principals, compensation, activities |
| Senate LDA Bulk Data | `lda.senate.gov/system/public/` | None | Unlimited (bulk) | XML bulk downloads of all lobbying filings |

### Congressional & Legislative

| Source | API Endpoint | Auth | Rate Limit | Key Data |
|--------|-------------|------|------------|----------|
| Congress.gov API | `api.congress.gov/v3/` | Free API key | 5,000/hr | Bills, amendments, actions, sponsors, cosponsors, committees, nominations, treaties, hearings, Congressional Record |
| GovInfo API | `api.govinfo.gov/` | Free API key (api.data.gov) | 1,000/hr | Bill text (all versions), Federal Register, CFR, U.S. Code, committee reports, hearing transcripts, public laws, GAO reports |
| ProPublica Congress API | `api.propublica.org/congress/v1/` | Free API key | 5,000/day | Members, votes, bills, statements, lobbying, office expenses, party loyalty scores |
| VoteView | `voteview.com/api/` | None | N/A | Historical roll calls back to 1789, DW-NOMINATE ideology scores |
| CBO | `cbo.gov/data/budget-economic-data` | None | N/A (downloads) | Bill cost estimates, budget projections, economic forecasts |
| GAO | `gao.gov/api/` | None | N/A | Audit reports, high-risk list, investigative findings |
| CRS Reports | `crsreports.congress.gov` | None | N/A | Nonpartisan policy analysis reports |
| OpenStates API | `v3.openstates.org` | Free API key | Varies | State legislators, state bills, votes, committees — all 50 states + DC + PR |

### Judicial

| Source | API Endpoint | Auth | Rate Limit | Key Data |
|--------|-------------|------|------------|----------|
| CourtListener API | `courtlistener.com/api/rest/v4/` | Free account | 5,000/day | Opinions, dockets, RECAP documents, judge bios, judge financial disclosures, investment positions |
| FJC Judges Database | `fjc.gov/history/judges` | None | N/A (CSV) | All federal judges: appointing president, confirmation date, ABA rating, prior career |
| FJC Integrated Database | `fjc.gov/research/idb` | None | N/A (CSV) | Case-level data for all federal civil, criminal, bankruptcy, appellate cases |
| USSC Datafiles | `ussc.gov/research/datafiles` | None | N/A (CSV) | Individual offender sentencing data: offense, guideline range, actual sentence, demographics |
| Oyez API | `api.oyez.org` | None | N/A | SCOTUS cases, oral argument audio, justice info |
| SCOTUS Database | `scdb.wustl.edu` | None | N/A (CSV) | All SCOTUS decisions since 1946: outcome, vote splits, issue areas, liberal/conservative direction |
| PACER/RECAP | `courtlistener.com` (free mirror) | Free via RECAP | 5,000/day | Federal court filings (millions mirrored for free) |

### Executive Branch & Regulatory

| Source | API Endpoint | Auth | Rate Limit | Key Data |
|--------|-------------|------|------------|----------|
| Federal Register API | `federalregister.gov/developers/api/v1` | None | None | Rules, proposed rules, executive orders, proclamations, agency notices |
| Regulations.gov API | `api.regulations.gov/v4/` | Free API key (api.data.gov) | 1,000/hr | Regulatory dockets, public comments (commenter name/org, full text) |
| USAspending API | `api.usaspending.gov/api/v2/` | None | Soft limit | All federal contracts, grants, loans — recipient, amount, agency, NAICS, congressional district |
| SAM.gov API | `api.sam.gov` | Free API key | Varies | Registered contractors, entity info, debarment list, federal org hierarchy |
| FPDS | `fpds.gov` | None | N/A | Federal procurement contracts (real-time) |

### Ethics & Financial Disclosures

| Source | Access Method | Format | Key Data |
|--------|--------------|--------|----------|
| OGE (Executive Branch) | `efd.oge.gov` | PDF | Senior executive officials' assets, income, liabilities, positions, gifts |
| House Financial Disclosures | `disclosures-clerk.house.gov` | PDF | House members' financial disclosures and periodic transaction reports (stock trades) |
| Senate Financial Disclosures | `efdsearch.senate.gov` | PDF | Senate members' financial disclosures and stock trades |
| Quiver Quantitative API | `quiverquant.com` | JSON | Structured congressional stock trading data, government contracts, lobbying |
| SEC EDGAR | `data.sec.gov` | JSON/XBRL | Corporate filings, insider trading (Form 4), proxy statements, beneficial ownership |
| CourtListener Disclosures | `courtlistener.com/api/rest/v4/financial-disclosures/` | JSON | Judge financial disclosures — stock holdings, outside income, gifts |

### Environmental & Workplace Enforcement

| Source | API Endpoint | Auth | Rate Limit | Key Data |
|--------|-------------|------|------------|----------|
| EPA ECHO | `echo.epa.gov/tools/web-services` | None | Reasonable use | Facility inspections, violations, enforcement actions, penalties — by district |
| EPA Air Quality (AQS) | `aqs.epa.gov/aqsweb/documents/data_api.html` | Free API key | N/A | Air quality monitoring data |
| EPA EJSCREEN | `ejscreen.epa.gov` | None | N/A | Environmental justice indicators by census block group |
| OSHA Enforcement | `enforcedata.dol.gov` | None | Reasonable use | Workplace inspections, violations, penalties, fatalities by employer |
| EPA TRI | Via Envirofacts API | None | N/A | Toxic chemical releases by facility |

### Polling & Prediction Markets

| Source | Access Method | Auth | Key Data |
|--------|--------------|------|----------|
| FiveThirtyEight/538 | Data downloads + scraping | None | Polling averages, pollster ratings, forecast models |
| RealClearPolitics | Scraping (no API) | None | Polling averages, head-to-head matchups |
| Polymarket | On-chain data (Polygon) + API | None | Election/policy contracts, trade-level data (wallet addresses, amounts, timestamps) |
| Kalshi | `trading-api.kalshi.com/trade-api/v2/` | Free account | Regulated prediction market contracts, event probabilities, volume |
| Metaculus | `metaculus.com/api2/` | None | Community forecasting questions and probability distributions |

### Geographic & Census

| Source | API Endpoint | Auth | Rate Limit | Key Data |
|--------|-------------|------|------------|----------|
| Census Bureau APIs | `api.census.gov/data/` | Free API key recommended | 500/day (no key) | ACS demographics, decennial census, population estimates, economic data — down to block group |
| Census Geocoder | `geocoding.geo.census.gov` | None | Soft limit | Address/coordinates to FIPS codes, congressional district, state legislative districts |
| TIGER/Line | `census.gov/geographies/mapping-files` | None | N/A (bulk) | Boundary shapefiles: states, counties, districts, places, tracts, ZCTAs |
| Cartographic Boundaries | `census.gov/geographies/mapping-files` | None | N/A (bulk) | Simplified boundaries for web mapping |
| HUD ZIP Crosswalk | `huduser.gov/portal/datasets/usps_crosswalk.html` | None | N/A | ZIP-to-county, ZIP-to-tract, ZIP-to-congressional district (updated quarterly) |
| Google Civic Info API | `googleapis.com/civicinfo/v2/` | Google API key | 25,000/day | Officials by address (all levels), elections, polling locations |

### Cross-Cutting / Reference

| Source | Access Method | Key Data |
|--------|--------------|----------|
| OpenCorporates | `api.opencorporates.com` | Corporate registry data — for LLC/shell company tracking |
| LittleSis API | `littlesis.org/api` | Crowd-sourced relationship data: 400k+ entities, 1.5M+ relationships |
| data.gov | `catalog.data.gov` | Central catalog of 300k+ federal datasets |
| BEA API | `apps.bea.gov/api/` | GDP, personal income, trade data by state/metro |
| BLS API | `api.bls.gov/publicAPI/v2/` | Employment, unemployment, CPI, wages by area |
| Vote.gov | `vote.gov` | Voter registration links by state |
| dotgov-data | GitHub | .gov domain registry |

### API Key Management

Only 5-6 registrations needed:

| Registration | Covers |
|-------------|--------|
| api.data.gov | FEC, GovInfo, Regulations.gov, SAM.gov |
| Congress.gov | Congress.gov API |
| ProPublica | Congress API, Nonprofit Explorer |
| OpenSecrets | OpenSecrets API |
| Google Cloud | Civic Information API |
| OpenStates | OpenStates API |

**Total: 50+ data sources, 35+ with APIs, all free or freemium.**

---

## Data Architecture — The Relationship Graph

### Graph Data Model

Government modeled as a **relationship network** where money, people, legislation, and decisions are connected nodes.

#### Entity Types (Nodes)

```
PEOPLE
  Individual          — donors, citizens
  Officeholder        — elected/appointed officials (linked to jurisdictions)
  Judge               — federal/state judges (linked to courts)
  Lobbyist            — registered lobbyists (linked to firms & clients)

ORGANIZATIONS
  Corporation         — public/private companies (NAICS codes, ticker)
  PAC                 — political action committees (FEC types: connected, non-connected, super, hybrid)
  501c4               — dark money social welfare orgs (IRS EIN)
  527_Org             — political organizations (IRS)
  LobbyingFirm        — registered lobbying entities
  TradeAssociation     — industry groups
  ForeignPrincipal     — foreign governments/entities (FARA)

GOVERNMENT
  Jurisdiction         — federal/state/county/city (PostGIS geometry)
  Office               — positions within jurisdictions
  Agency               — government agencies (parent/child hierarchy)
  Committee            — legislative committees
  Court                — federal/state courts

ACTIONS
  LegislativeBill      — bills/resolutions (congress, state legislature)
  Vote                 — roll call votes on bills
  JudicialDecision     — court opinions/rulings
  ExecutiveOrder       — presidential/gubernatorial orders
  Regulation           — proposed/final rules (Federal Register)
  Contract             — government contracts (USAspending)
  RegulatoryComment    — public comments on proposed rules
  StockTrade           — congressional stock transactions
```

#### Relationship Types (Edges)

```
MONEY FLOWS
  DONATED_TO           — individual/org → candidate/PAC {amount, date, fec_filing}
  CONTRIBUTED_TO       — PAC → candidate/PAC {amount, date, type}
  SPENT_FOR/AGAINST    — PAC/501c4 → candidate {amount, type: IE/EC, support/oppose}
  GRANTED_TO           — 501c4 → PAC/501c4 {amount, year, irs_filing}
  LOBBIED_VIA          — corporation → lobbying_firm {amount, year, issues[]}
  PAID_BY              — contract → corporation {amount, agency, description}

POWER RELATIONSHIPS
  REPRESENTS           — officeholder → jurisdiction
  SITS_ON              — officeholder → committee
  APPOINTED_BY         — judge → officeholder (president)
  CONFIRMED_BY         — judge → vote (senate confirmation)
  EMPLOYED_BY          — individual → corporation/lobbying_firm
  PREVIOUSLY_HELD      — lobbyist/corporate_exec → office (revolving door)
  REGISTERED_FOR       — lobbyist → foreign_principal (FARA)

LEGISLATIVE
  SPONSORED            — officeholder → bill
  COSPONSORED          — officeholder → bill
  VOTED_ON             — officeholder → vote → bill {yea/nay/present/absent}
  LOBBIED_ON           — lobbying_firm → bill {on behalf of client}
  AFFECTS_INDUSTRY     — bill → industry {NAICS codes}
  COMMENTED_ON         — corporation/individual → regulation

JUDICIAL
  DECIDED              — judge → judicial_decision
  PARTY_TO             — corporation/individual → judicial_decision
  HOLDS_STOCK          — judge → corporation {shares, value_range}
  OVERSEES             — committee → agency/court

FINANCIAL
  TRADED               — officeholder → stock_trade → corporation
  LATE_FILED           — officeholder → stock_trade {days_late}
```

### Conflict Detection Engine

Automated queries against the graph:

- **Donor-Vote Conflict**: Officeholder received >$X from Industry Y, then voted on Bill Z that affects Industry Y
- **Judicial Conflict**: Judge holds stock in Corporation A, Corporation A is party to Case B before that judge
- **Stock-Committee Conflict**: Legislator holds stock in company regulated by their committee
- **Trade-Legislation Timing**: Stock trade within N days of a related vote
- **Revolving Door**: Official left Agency X, now lobbies Agency X within cooling-off period
- **Contract-Donor Overlap**: Federal contract awarded to company that donated to the legislator representing that district
- **Dark Money Chain**: Trace 501(c)(4) grants through intermediate orgs to Super PAC expenditures
- **Prediction Market Insider**: Large position taken shortly before government action, resulting in outsized profit

Severity scoring: `score = f(dollar_amount, timing_proximity, directness_of_connection)`

---

## Feature Modules

### Pillar 1: Navigate

#### 1.1 Government Structure Explorer (original, enhanced)
- Three branches at federal level, state equivalents, county/city structures
- Agency directory with parent/child hierarchy (400+ federal, 50×state)
- Interactive org charts — click any node to drill into leadership, budget, regulations
- Agency regulatory scope mapping — which industries each agency regulates, connecting to the money graph
- Sources: USA.gov, Government Manual, state portals, SAM.gov Federal Hierarchy API

#### 1.2 Official Profiles (original, massively enhanced)
Every elected/appointed official at every level gets:
- Contact info, term dates, committee assignments, biographical data
- Top donors (FEC + FollowTheMoney)
- Stock trades & holdings (disclosure filings + Quiver Quantitative)
- Voting record with party loyalty score (ProPublica, OpenStates)
- Donor-vote alignment analysis (computed)
- Committee assignments cross-referenced against donor industries
- Lobbying contacts (who's lobbying them, on what bills)
- Revolving door history (prior private sector roles)
- Financial disclosure summary (assets, income, liabilities)
- Transparency scorecard (composite rating)
- Sources: Google Civic API, Congress.gov, OpenStates, FEC, Senate LDA, OGE disclosures

#### 1.3 Election Toolbox (original, enhanced)
- ZIP-first voter lookup → all jurisdictions, registration, ballot tracking
- Candidate profiles with full money trail
- Ballot measures with funding sources (who's paying for/against)
- Historical election results with spending analysis (did the bigger spender win?)
- Upcoming deadlines with notification RSS feeds
- Sources: Google Civic API, Vote.gov, Democracy Works, FEC, state election offices

#### 1.4 Law & Regulation Index (original, enhanced)
- U.S. Code, CFR, state statutes, county/municipal codes
- Regulation lifecycle tracking — proposed rule → public comment period → final rule
- Who commented on proposed rules — corporations, trade associations, advocacy groups
- Executive order tracker with legal status (active, revoked, challenged in court)
- Sources: GovInfo API, Federal Register API, Regulations.gov API, state legal portals, Municode

#### 1.5 Federal Spending by District (new)
- Every federal contract and grant, searchable by congressional district, state, county
- Which companies in your district get federal money, how much, for what
- Cross-reference contractors with campaign donors
- Sources: USAspending API, FPDS, SAM.gov

#### 1.6 Local Government Navigator (new)
- Step-by-step guides for common local government interactions
- "How does my local government work?" explainers by jurisdiction type
- Local meeting calendars and agendas where available
- Public records request templates by state
- Sources: Municipal websites, community contributions, state open records law databases

### Pillar 2: Follow the Money

#### 2.1 The Money Graph (flagship feature)
- Interactive network visualization of donor-PAC-candidate-committee-legislation relationships
- Entry modes:
  - Search for any entity → graph radiates outward
  - "Find connections between A and B" → path-finding view
  - "Show me Industry X's political network" → industry cluster view
  - Pre-built views: "Top 10 most connected donors," "Dark money networks," "Foreign influence map"
- Controls: depth slider (1-5 hops), amount threshold, date range, relationship type toggles, layout switcher
- Click any node → sidebar with entity detail + "make this the center"
- Click any edge → transaction details, filing links, dates
- Export: screenshot, shareable URL, embed code
- Full-network overview mode (Sigma.js) for zooming into clusters
- Tech: Cytoscape.js (primary), D3 Sankey (flow diagrams), Sigma.js (full-network)
- Sources: FEC API, OpenSecrets, Senate LDA, IRS 990, FollowTheMoney

#### 2.2 Dark Money Tracker (new)
- Searchable directory of 501(c)(4) organizations with political spending
- Flow visualization: trace money from nonprofit layer through to candidate ads
- "Dark money index" per race: % of total spending from undisclosed sources
- Leaderboard: biggest dark money spenders by cycle
- Sources: IRS 990 bulk data (AWS S3), ProPublica Nonprofit Explorer API, FEC

#### 2.3 Lobbying Dashboard (new)
- Search by bill, official, industry, or lobbying firm
- Bill view: all lobbying activity on a specific bill, who's for/against, how much spent
- Official view: who's lobbying this person, on what issues
- Industry view: total lobbying spend by sector, top firms, top issues
- Lobbyist profiles with covered positions (revolving door flag)
- Sources: Senate Lobbying Disclosure API

#### 2.4 Revolving Door Tracker (new)
- Career timelines: government positions interleaved with private sector roles
- Cooling-off period violation flags
- Aggregate stats: which agencies/industries have most revolving door traffic
- Sources: Senate LDA, OpenSecrets revolving door data

#### 2.5 Congressional Stock Tracker (new)
- Searchable table of all trades: filterable by member, party, chamber, ticker, date
- Member portfolio view: holdings, trades, committee overlap flags
- Ticker view: which members are trading a specific stock
- "Suspicious timing" flag: trades within N days of related committee action or vote
- Late STOCK Act filing tracker
- Aggregate stats: Congress vs. S&P 500 performance
- Sources: House/Senate disclosure filings, Quiver Quantitative API, SEC EDGAR Form 4

#### 2.6 Foreign Influence Map (new)
- Which foreign governments spend money to influence US policy
- FARA-registered agents: who represents which countries, activities, compensation
- Cross-reference with lobbying disclosures and campaign contributions
- Country-level profiles: total US influence spending
- Sources: FARA database API, Senate LDA, FEC

#### 2.7 Corporate Influence Scores (new)
- Composite score (0-100) per corporation:
  - Lobbying spend (25%)
  - PAC contributions (20%)
  - Revolving door hires (15%)
  - Dark money / 501(c)(4) funding (15%)
  - Government contracts received (10%)
  - Regulatory comments submitted (10%)
  - Trade association memberships (5%)
- Ranked leaderboards by industry and overall
- Historical trends
- Sources: All of the above, aggregated

#### 2.8 Community Data Platform (new, long-term)
- Open submission framework for structured local political money data
- Verification workflow: submitted → reviewed against primary sources → verified
- Data types: local campaign finance, official financial disclosures, meeting records, local lobbying
- API for contributing organizations to push data programmatically
- Attribution and sourcing — every data point links to its source
- Sources: Community contributors, verified against primary source documents

#### 2.9 Political Predictions & Market Intelligence (new)

**Polling Aggregation:**
- Aggregate polling data across major pollsters for federal and state races
- Pollster ratings and methodology transparency
- Historical accuracy tracking
- Trend lines and moving averages
- Sources: FiveThirtyEight/538, RealClearPolitics, The Economist, state pollsters

**Prediction Market Tracking:**
- Real-time odds from Polymarket, Kalshi, Metaculus
- Market-implied probabilities for elections, legislation, policy decisions, geopolitical events
- Historical accuracy: polls vs. prediction markets vs. actual outcomes
- Odds movement visualization correlated with news events
- Cross-market comparison (when markets disagree)

**Prediction Market Insider Trading Detection:**
- Anomalous betting pattern detection: large positions taken before government actions
- Timing analysis: correlate large bets with government announcements, military actions, regulatory decisions, legislative votes, executive orders
- Volume spike detection: abnormal volume before events
- Pattern catalog: public record of suspicious prediction market activity
- Category tracking: foreign policy (highest insider edge), regulatory approvals/denials, appointments, sanctions, legislative outcomes
- Polymarket blockchain analysis: every trade is on-chain (Polygon), enabling wallet tracking and repeat-winner identification

**Integration with Money Graph:**
- Overlay prediction market odds on election pages alongside campaign finance
- "Money vs. Markets" view: does more money = higher odds?
- Prediction market contracts on legislation — does money predict bill passage?

### Pillar 3: Connect the Dots

#### 3.1 Conflict of Interest Alerts (new, automated)
- **Donor-Vote Conflicts**: Legislator votes on bill affecting major donor's industry
- **Stock-Committee Conflicts**: Legislator holds stock in company regulated by their committee
- **Trade-Legislation Timing**: Stock trade within N days of a related vote
- **Judicial-Financial Conflicts**: Judge holds stock in case party
- **Contract-Donor Overlap**: Federal contract to company that donated to relevant legislator
- **Prediction Market Insider**: Large position before government action
- Severity scoring, filterable alert feed, RSS feeds per filter combination
- "Worst offenders" leaderboard
- Sources: Computed from graph relationships

#### 3.2 Judicial Transparency Suite (new)
- **Judge Profiles**: Biographical data, appointing president, confirmation vote, ABA rating, prior career
- **Political Chain**: Who nominated → who confirmed → who funded confirming senators → which industries
- **Financial Disclosures**: Stock holdings, outside income, gifts (CourtListener API)
- **Conflict Detection**: Cross-reference holdings against case parties
- **Recusal Analysis**: Recusal rates compared to expected given holdings
- **Sentencing Analysis**: Deviation from guidelines by judge, offense type, demographics
- **Decision Tracker**: Searchable opinions, issue coding, vote splits (SCOTUS Database)
- **Court Structure Explorer**: Interactive hierarchy, vacancies, pending nominations
- Sources: FJC, CourtListener, USSC, Oyez, SCOTUS Database

#### 3.3 Voting Record Analysis (new)
- Every roll call vote for every legislator, federal and state
- Party loyalty scores, missed vote percentages
- Donor alignment scores: correlation between voting record and top donor industry positions
- Industry group scorecard aggregation
- Vote clustering: which legislators vote together most (network view)
- Bipartisan index
- Sources: Congress.gov, ProPublica, VoteView, OpenStates

#### 3.4 Legislative Text Analysis (new)
- Side-by-side comparison of bill text with model legislation (ALEC, industry proposals)
- Similarity scoring
- Amendment tracking: who changed what, when
- Bill genealogy: trace language through previous sessions
- Sources: GovInfo API, model legislation databases, FOIA archives

#### 3.5 Gerrymandering Visualization (new)
- District maps with compactness scores (Polsby-Popper, Reock, Convex Hull) via PostGIS
- Efficiency gap overlay with precinct-level election results
- Mean-median partisan difference
- Historical comparison across redistricting cycles
- Color-coded: green (compact/fair) → red (gerrymandered)
- Sources: TIGER/Line boundaries, precinct-level election data, Census demographics

#### 3.6 Transparency Scorecards (new)
- Composite rating per official (A-F):
  - Financial disclosure completeness and timeliness
  - STOCK Act compliance
  - Town hall and public meeting frequency
  - Conflicts of interest count
  - Transparency legislation co-sponsorship
  - Small donor percentage
  - Voting attendance rate
  - Press accessibility
- Ranked leaderboards by chamber, state, party
- Sources: Computed from multiple data sources

#### 3.7 Environmental & Regulatory Enforcement (new)
- EPA enforcement actions by facility, searchable by district and company
- OSHA inspection data by employer
- Cross-reference: violators who donate to oversight committee members
- Environmental justice overlay: demographics + environmental hazard proximity
- Sources: EPA ECHO, OSHA enforcement, Census ACS, EJSCREEN

#### 3.8 Real-Time Bill Tracker with Impact Analysis (new)
- Live monitoring of new bills and status changes
- Automated tagging: affected industries, agencies, U.S. Code sections
- CBO cost estimate integration
- "Impact profile" per bill: which states, industries, demographics most affected
- Who's lobbying on this bill + who's donating to sponsors
- RSS feeds per topic/state
- Sources: Congress.gov, ProPublica, GovInfo, CBO

---

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT LAYER                         │
│                                                             │
│  Astro Static Pages          Astro Islands (Interactive)    │
│  ├─ Government structure     ├─ MapLibre GL (maps)          │
│  ├─ Agency directory         ├─ Cytoscape.js (money graph)  │
│  ├─ Official profiles        ├─ D3 Sankey (money flows)     │
│  ├─ Law/regulation index     ├─ Sigma.js (full network)     │
│  ├─ Court structure          ├─ Chart.js (polls/markets)    │
│  └─ Scorecards/reports       ├─ Diff viewer (bill text)     │
│                              └─ Search/filter components    │
├─────────────────────────────────────────────────────────────┤
│                     ASTRO SSR ENDPOINTS                     │
│                                                             │
│  /api/zip-lookup         → jurisdictions + officials        │
│  /api/officials          → officials by jurisdiction        │
│  /api/money-graph        → graph traversal queries          │
│  /api/conflicts          → conflict of interest alerts      │
│  /api/stock-trades       → congressional trading data       │
│  /api/lobbying           → lobbying activity by bill/member │
│  /api/elections          → election data + predictions      │
│  /api/judicial           → judge profiles + decisions       │
│  /api/spending           → federal spending by geography    │
│  /api/search             → full-text search across entities │
│  /api/alerts/feed        → RSS/JSON alert feeds             │
│  /api/community/submit   → community data submissions      │
├─────────────────────────────────────────────────────────────┤
│                      SUPABASE LAYER                         │
│                                                             │
│  PostgreSQL + PostGIS                                       │
│  ├─ Relational tables (jurisdictions, officials, agencies)  │
│  ├─ Graph tables (entities, relationships, edges)           │
│  ├─ Materialized views (precomputed scores, aggregations)   │
│  ├─ Full-text search (pg_trgm + tsvector)                   │
│  ├─ PostGIS (boundary geometries, spatial queries)          │
│  └─ Row-level functions (graph traversal via recursive CTE) │
│                                                             │
│  Supabase Edge Functions                                    │
│  ├─ Conflict detection engine (scheduled)                   │
│  ├─ Prediction market anomaly detection (scheduled)         │
│  └─ Community submission verification queue                 │
│                                                             │
│  Supabase Storage                                           │
│  ├─ PMTiles (map vector tiles)                              │
│  ├─ Cached API responses                                    │
│  └─ PDF financial disclosures (parsed)                      │
├─────────────────────────────────────────────────────────────┤
│                    DATA PIPELINE LAYER                      │
│                                                             │
│  Scheduled Import Jobs (cron)                               │
│  ├─ DAILY:    FEC filings, Congress.gov actions,            │
│  │            Federal Register, prediction markets,         │
│  │            stock trade disclosures                       │
│  ├─ WEEKLY:   Lobbying filings, CourtListener opinions,     │
│  │            USAspending, polling aggregation,             │
│  │            EPA/OSHA enforcement                          │
│  ├─ MONTHLY:  IRS 990 updates, FARA filings,               │
│  │            Census estimates, SAM.gov entities,           │
│  │            FollowTheMoney state data                     │
│  ├─ QUARTERLY: HUD ZIP crosswalk, financial disclosures    │
│  └─ YEARLY:   TIGER/Line boundaries, USSC sentencing,      │
│               redistricting/compactness recalculation       │
│                                                             │
│  ETL Process per Source:                                    │
│  1. Fetch (API call or bulk download)                       │
│  2. Parse (JSON/XML/CSV/PDF → structured data)             │
│  3. Entity Resolution (fuzzy match names across sources)    │
│  4. Normalize (map to unified schema)                       │
│  5. Load (upsert into Supabase)                            │
│  6. Recompute (update materialized views, scores, alerts)   │
│  7. Rebuild (trigger Astro static page regeneration)        │
└─────────────────────────────────────────────────────────────┘
```

### Database Schema

#### Core Government Structure (original)
```sql
jurisdictions        -- hierarchical: federal → state → county → city
                     -- PostGIS geometry, FIPS codes, population, area
offices              -- positions within jurisdictions
officials            -- people holding offices, term dates, contact info
agencies             -- government agencies, parent/child hierarchy
                     -- regulatory_scope (NAICS codes of regulated industries)
zip_jurisdictions    -- ZIP to jurisdiction mapping (HUD crosswalk)
```

#### The Graph: Entities & Relationships (new)
```sql
entities             -- id, entity_type, name, aliases[], external_ids (jsonb:
                     -- fec_id, ein, bioguide_id, ticker, etc), metadata (jsonb)

relationships        -- id, source_entity_id, target_entity_id,
                     -- relationship_type (enum), amount, date_start,
                     -- date_end, metadata (jsonb), confidence_score

-- Entity type-specific detail tables (1:1 with entities)
entity_persons       -- employer, occupation, address
entity_corporations  -- ticker, naics_code, sector, market_cap, parent_corp_id
entity_pacs          -- fec_committee_id, pac_type, sponsor_entity_id
entity_501c4s        -- ein, irs_category, total_revenue, total_grants_made
entity_lobbying_firms -- lda_registrant_id, client_count
entity_foreign_principals -- country, principal_type
```

#### Campaign Finance (new)
```sql
contributions        -- donor_entity_id, recipient_entity_id, amount, date,
                     -- fec_filing_id, contribution_type, employer, occupation
independent_expenditures -- spender_entity_id, candidate_entity_id, amount,
                     -- date, support_oppose, payee, purpose
dark_money_flows     -- source_entity_id, target_entity_id, amount, year, irs_filing
```

#### Lobbying (new)
```sql
lobbying_registrations -- firm_entity_id, client_entity_id, issues[],
                     -- effective_date, termination_date
lobbying_activities  -- registration_id, report_period, amount,
                     -- bills_lobbied[], agencies_contacted[],
                     -- lobbyists (jsonb array with covered_positions)
lobbying_contributions -- lobbyist_entity_id, recipient_entity_id, amount, date
```

#### Legislative (expanded)
```sql
bills                -- bill_id, congress/session, title, summary, status,
                     -- subjects[], naics_affected[], policy_area, text_url
bill_actions         -- bill_id, action_date, action_text, action_type
bill_sponsors        -- bill_id, official_id, sponsor_type
roll_call_votes      -- vote_id, bill_id, chamber, date, result
vote_positions       -- vote_id, official_id, position (yea/nay/present/absent)
```

#### Judicial (new)
```sql
courts               -- court_id, name, type, jurisdiction_id, circuit_number
judges               -- entity_id, court_id, appointing_president_id,
                     -- confirmation_date, confirmation_vote, aba_rating,
                     -- senior_status_date, termination_date
judge_financial_disclosures -- judge_id, year, filing_url, parsed_data (jsonb)
judge_investments    -- disclosure_id, judge_id, asset_name, ticker,
                     -- value_range_low, value_range_high
judicial_decisions   -- case_id, court_id, date, title, citation,
                     -- issue_codes[], disposition, opinion_url
case_judges          -- case_id, judge_id, role (author/concur/dissent)
case_parties         -- case_id, party_entity_id, party_role
sentencing_records   -- judge_id, offense_type, guideline_min, guideline_max,
                     -- actual_sentence, departure_reason, defendant_demographics
```

#### Stock Trading (new)
```sql
stock_trades         -- official_id, ticker, asset_name, trade_type,
                     -- amount_range_low, amount_range_high, trade_date,
                     -- disclosure_date, days_late, filing_url
official_holdings    -- official_id, ticker, asset_name, value_range_low,
                     -- value_range_high, disclosure_year
```

#### Polling & Prediction Markets (new)
```sql
polls                -- poll_id, pollster, race_type, geography, date_conducted,
                     -- sample_size, methodology, candidates (jsonb)
pollster_ratings     -- pollster, accuracy_score, mean_bias, races_polled
prediction_contracts -- contract_id, platform, question, category,
                     -- current_probability, volume_total, open_date, close_date
prediction_trades    -- contract_id, timestamp, price, size, side,
                     -- wallet_address (polymarket)
prediction_anomalies -- contract_id, anomaly_type, detection_timestamp,
                     -- description, severity_score, related_event
```

#### Conflict Detection (new)
```sql
conflict_alerts      -- id, alert_type (enum), severity_score,
                     -- entity_ids[], description, evidence (jsonb),
                     -- detected_at, status (active/reviewed/dismissed)
```

#### Scores (new)
```sql
transparency_scores  -- official_id, score_date, overall_score (0-100),
                     -- component_scores (jsonb), grade (A-F)
corporate_influence_scores -- entity_id, score_date, overall_score (0-100),
                     -- component_scores (jsonb)
```

#### Community Contributions (new)
```sql
community_submissions -- id, submitter_name, submitter_org,
                     -- submission_type, jurisdiction_id, data (jsonb),
                     -- source_url, status (pending/verified/rejected),
                     -- verified_by, verified_at
```

#### Geospatial (expanded)
```sql
district_geometries  -- district_id, district_type, geometry (PostGIS), vintage_year
compactness_scores   -- district_id, polsby_popper, reock, convex_hull,
                     -- efficiency_gap, mean_median_difference, vintage_year
```

### Graph Traversal

Recursive CTEs for graph queries, wrapped in PostgreSQL functions:

```sql
CREATE FUNCTION find_money_paths(
  source_id uuid, target_id uuid, max_hops int DEFAULT 5
) RETURNS TABLE(path uuid[], relationship_types text[], total_amount numeric)
AS $$
  WITH RECURSIVE money_path AS (
    SELECT ARRAY[r.source_entity_id, r.target_entity_id] AS path,
           ARRAY[r.relationship_type::text] AS rel_types,
           COALESCE(r.amount, 0) AS total,
           r.target_entity_id AS current_node,
           1 AS depth
    FROM relationships r
    WHERE r.source_entity_id = source_id
      AND r.relationship_type IN ('DONATED_TO','CONTRIBUTED_TO','GRANTED_TO','SPENT_FOR')
    UNION ALL
    SELECT mp.path || r.target_entity_id,
           mp.rel_types || r.relationship_type::text,
           mp.total + COALESCE(r.amount, 0),
           r.target_entity_id,
           mp.depth + 1
    FROM money_path mp
    JOIN relationships r ON r.source_entity_id = mp.current_node
    WHERE mp.depth < max_hops
      AND r.target_entity_id != ALL(mp.path)
      AND r.relationship_type IN ('DONATED_TO','CONTRIBUTED_TO','GRANTED_TO','SPENT_FOR')
  )
  SELECT path, rel_types, total
  FROM money_path WHERE current_node = target_id
  ORDER BY total DESC;
$$ LANGUAGE sql;
```

### Materialized Views

Precomputed aggregations refreshed on schedule:
- `mv_official_top_donors` — top 20 donors per official (daily)
- `mv_official_industry_funding` — funding by industry per official (daily)
- `mv_official_donor_vote_alignment` — correlation scores (weekly)
- `mv_corporate_influence_rankings` — corporate influence scores (weekly)
- `mv_judge_conflict_flags` — judges with holdings matching case parties (weekly)
- `mv_district_compactness` — gerrymandering metrics (yearly)
- `mv_prediction_anomalies` — flagged suspicious market activity (daily)

### Entity Resolution Pipeline

The hardest problem — same entity appears across FEC, LDA, 990, FARA, state records under different names:

1. **Deterministic matching**: FEC IDs, EINs, bioguide IDs, tickers, DUNS/UEI
2. **Fuzzy matching**: Normalized names, Levenshtein distance, Jaro-Winkler similarity
3. **Contextual matching**: Same address, industry, associated people
4. **Confidence scoring**: Every match gets 0-1 score; below threshold → review queue
5. **Manual overrides**: Curated merge/split list for known entities

### Rendering Strategy

**Static (built at build time):**
- Government structure, agency directory, official profiles, judge profiles, court structure, law index, scorecards, rankings, compactness reports

**Server-rendered (SSR endpoints):**
- ZIP lookup, money graph traversal, conflict alerts, lobbying search, stock trade search, bill tracker, prediction markets, community submissions, entity search, RSS feeds

**Client-side interactive (Astro islands):**
- MapLibre map, Cytoscape.js graph, D3 Sankey flows, Sigma.js network, Chart.js polls/markets, diff viewer, search/filter/sort

**Rebuild:** Static pages daily after pipeline runs; on-demand for breaking changes.

### Performance

- PMTiles for maps (no tile server)
- Materialized views for all expensive aggregations
- Pagination on all endpoints
- CDN edge caching for static pages and common API responses
- Lazy-load graph visualization bundles
- Incremental static regeneration (only rebuild changed pages)
- Composite database indexes on entity_type, relationship_type, jurisdiction_id, geometry, dates
- Supabase pgBouncer for connection pooling

---

## UX & Information Architecture (Expanded)

### Navigation Model

```
Top Nav: [MAP] [Navigate ▼] [Follow the Money ▼] [Connect the Dots ▼]
Global:  [Search everything...] [ZIP Code Lookup]
```

Every page: breadcrumb trail, universal search, ZIP entry.

### Page Types (18 total)

**Navigate Pillar:**
1. Homepage / Map — full-screen map + three-pillar highlights
2. My Government — ZIP lookup result, all officials + donors + alerts + elections
3. Federal Overview — three branches, org charts
4. State Overview (×50+) — executive, legislative, judicial, elections, campaign finance
5. County Overview (×3,143) — officials, services, spending, environment
6. City Overview (×19,000+) — officials, services, elections
7. Agency Detail — mission, budget, regulations, lobbying, revolving door, contractors
8. Law/Regulation Detail — full text, lifecycle, comments, lobbying, affected industries
9. Local Government Navigator — how-to guides, templates, meeting calendars

**Follow the Money Pillar:**
10. Money Graph Explorer — interactive network visualization (flagship)
11. Dark Money Tracker — 501(c)(4) directory, flow visualization, dark money index
12. Lobbying Dashboard — search by bill/official/industry/firm
13. Congressional Stock Tracker — trades, portfolios, timing analysis, late filings
14. Corporate Influence Profiles — composite scores, leaderboards
15. Revolving Door Explorer — career timelines, cooling-off compliance

**Connect the Dots Pillar:**
16. Conflict of Interest Alert Feed — severity-ranked, filterable, RSS
17. Judicial Transparency Center — judge profiles, political chains, sentencing analysis, SCOTUS
18. Predictions & Markets — polling aggregation, prediction market odds, anomaly detection

**Embedded Features (not standalone pages):**
- Gerrymandering visualization → on district/state pages
- Bill text comparison → on bill detail pages
- Voting analysis → on official profiles
- Transparency scorecards → on official profiles + rankings page
- Federal spending drilldown → on jurisdiction pages
- Foreign influence map → within money graph + standalone view

### Key User Flows

**"Who bought my representative?"**
1. Enter ZIP code
2. See all officials representing you
3. Click any official → see top donors, stock trades, conflicts, scorecard
4. Click any donor → money graph radiates outward showing full network
5. Click any bill → see lobbying, donor alignment, vote

**"Follow the money on this bill"**
1. Search for a bill or browse bill tracker
2. See bill detail with lobbying activity and sponsor donors
3. Click "Show money graph" → see all financial connections to this bill
4. Filter by industry to see which sector has the most money flowing toward this bill's outcome

**"Is this judge conflicted?"**
1. Browse court structure or search for judge
2. See judge profile with holdings and case parties
3. Conflict flags highlighted with evidence
4. Click political chain to see appointment path back to donors

---

## Key Design Decisions (Updated)

1. **No user accounts** — completely free and public
2. **Hybrid rendering** — static for structure, server for dynamic lookups
3. **MapLibre over Leaflet** — vector tiles handle the scale
4. **Supabase over flat files** — relational model matches government hierarchy
5. **Scope switcher over disambiguation popups** — cleaner UX for overlapping geographies
6. **ZIP-first voter toolbox** — lowest friction entry point
7. **Fallback messages over broken links** — honest about what jurisdictions offer
8. **Build everything at once** — full geographic and content coverage from launch
9. **Recursive CTEs over separate graph database** — keeps everything in Supabase, avoids operational complexity
10. **Cytoscape.js for graphs** — graph theory operations (centrality, path finding, clustering) built-in
11. **Layered money data** — basic donor info on profiles immediately, full graph explorer as dedicated feature
12. **FollowTheMoney + community contributions** — state campaign finance baseline with crowd-sourced local data for long-term coverage
13. **Full judicial depth** — political chain mapping from donor to judicial appointment, first-mover opportunity
14. **Prediction market integration** — polling + market odds + insider anomaly detection
15. **Automated conflict detection** — computed from graph, not manually curated
16. **RSS over accounts** — alert feeds without requiring user registration
17. **Transparency by default** — every data point links to its source filing
