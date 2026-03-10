# GovGuide — Comprehensive Transparency Data Expansion

**Date:** 2026-03-10
**Status:** Approved
**Builds on:** `2026-03-09-govguide-expanded-design.md`

---

## Goal

Make GovGuide the most thorough free transparency tool in existence. Cover every level of government — federal, state, county, city, special district, school district — with officials, financial disclosures, influence networks, lobbying, stock trades, judicial data, and photos. All from free data sources, with a community contribution pipeline for gaps.

## Constraints

- No paid APIs or data sources
- All free tiers, bulk downloads, and public domain data
- Community contributions via GitHub (no web forms, no auth)

---

## 1. New Data Sources & Import Scripts

### 1.1 Federal Judges (FJC CSV — existing script)
- Script: `import-judges.ts`
- Source: `fjc.gov/history/judges/biographical-database-article-iii-federal-judges-export`
- ~3,500 Article III federal judges (current + historical)
- Fields: appointing president, confirmation vote, ABA rating, prior career
- Auto-creates court records in `courts` table

### 1.2 State + Federal Judges (CourtListener API — new script)
- Script: `import-courtlistener-judges.ts` (NEW)
- Source: `courtlistener.com/api/rest/v4/people/`
- ~10,000+ judges including state court judges
- Free API, 5,000 req/day
- Fields: appointed_by, political_affiliation, education, career history, selection method (elected/appointed)

### 1.3 Judge Financial Disclosures (CourtListener — existing script)
- Script: `import-judge-financials.ts`
- Source: `courtlistener.com/api/rest/v4/financial-disclosures/`
- Stock holdings, outside income, gifts, reimbursements
- Tables: `judge_financial_disclosures`, `judge_investments`

### 1.4 Congress Member Photos (Bioguide — new script)
- Script: `import-congress-photos.ts` (NEW)
- Source: `bioguide.congress.gov/bioguide/photo/{bioguideId}.jpg`
- Public domain, all 538 current members
- Stores URL in `officials.photo_url` column

### 1.5 State Legislator Photos (OpenStates — enhance existing)
- Enhance: `import-state-officials.ts` to capture `image` field
- OpenStates returns photo URLs for most legislators
- ~7,000 state legislators with photos
- Stores URL in `officials.photo_url` column

### 1.6 Governor/Judge Photos (Wikimedia Commons — new script)
- Script: `import-wikimedia-photos.ts` (NEW)
- Source: Wikimedia Commons API — search by official name + title
- Covers governors, AGs, secretaries of state, federal judges
- Free, CC-licensed images

### 1.7 LittleSis Relationships (new script — key differentiator)
- Script: `import-littlesis.ts` (NEW)
- Source: `littlesis.org/api/entities` and `/relationships`
- 400K+ entities, 1.5M+ relationships
- Data: board memberships, think tank fellowships, corporate directorships, government positions, donations, lobbying, family ties
- Maps to existing `relationships` table
- Cross-references existing officials/entities by name matching
- Relationship categories: Position, Education, Membership, Family, Donation, Transaction, Lobbying, Social, Professional, Ownership, Hierarchy, Generic

### 1.8 IRS 990 Nonprofits (existing script)
- Script: `import-irs990.ts`
- Source: IRS S3 bulk XML (`s3://irs-form-990/`)
- 501(c)(4) dark money orgs, labor unions, trade associations, 527 political orgs
- Board members + compensation, grants to other orgs (Schedule I)
- Tables: `entities`, `dark_money_flows`, `relationships`

### 1.9 OpenSecrets Free Tier (new script)
- Script: `import-opensecrets.ts` (NEW)
- Source: `opensecrets.org/api` — free API key, 200 req/day
- Priority data: top donors by member, industry totals, revolving door
- Supplements FEC raw data with pre-aggregated industry-coded donor info

### 1.10 FARA Foreign Agents (existing script)
- Script: `import-fara.ts`
- Source: `efile.fara.gov/ords/fara/f?p=API:LANDING`
- Foreign agent registrations, foreign principals, activities

### 1.11 VoteView Ideology Scores (existing script)
- Script: `import-voteview.ts`
- Source: `voteview.com` CSV downloads
- DW-NOMINATE scores for all Congress members, historical

### 1.12 Lobbying Bulk Data (new script — replaces broken API)
- Script: `import-lobbying-bulk.ts` (NEW)
- Source: `lda.senate.gov/system/public/` — quarterly XML bulk downloads
- Replaces `import-lobbying.ts` (Senate LDA API returns 404)
- LD-1 registrations, LD-2 activity reports
- Fields: who lobbied, which bills, which agencies, how much spent, lobbyist covered positions (revolving door flag)
- Schedule: quarterly cron

### 1.13 Congressional Stock Trades from Disclosures (new script)
- Script: `import-stock-trades-disclosures.ts` (NEW)
- Sources:
  - House: `disclosures.house.gov` — periodic transaction reports (PTRs) as XML/CSV
  - Senate: `efdsearch.senate.gov` — searchable filings
- Replaces `import-stock-trades.ts` (Quiver API needs paid key)
- Primary source data — better than aggregator APIs
- Fields: stock trades, asset purchases/sales, transaction dates, amounts (ranges)

### 1.14 Civic Data APIs for Local Officials (new script)
- Script: `import-civic-officials.ts` (NEW)
- Test: Democracy Works, Civic Engine, BallotReady free tiers
- If any provide local official data without paid access, import it
- Fallback: community contributions via GitHub

---

## 2. Schema Changes

### 2.1 New Columns

```sql
-- Photo URLs
ALTER TABLE officials ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE judges ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- Judge selection method
ALTER TABLE judges ADD COLUMN IF NOT EXISTS selection_method TEXT;
-- Values: 'elected', 'appointed', 'merit_selection', 'legislative_appointment'

-- Cross-reference IDs
ALTER TABLE entities ADD COLUMN IF NOT EXISTS littlesis_id TEXT;
ALTER TABLE officials ADD COLUMN IF NOT EXISTS littlesis_id TEXT;

-- Community contribution tracking
ALTER TABLE community_submissions ADD COLUMN IF NOT EXISTS github_issue_url TEXT;
```

### 2.2 Enum Values (already applied)

```sql
-- entity_type
ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'political_party';
ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'other';
ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'nonprofit';
ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'government';

-- jurisdiction_level
ALTER TYPE jurisdiction_level ADD VALUE IF NOT EXISTS 'township';
ALTER TYPE jurisdiction_level ADD VALUE IF NOT EXISTS 'school_district';
ALTER TYPE jurisdiction_level ADD VALUE IF NOT EXISTS 'special_district';
ALTER TYPE jurisdiction_level ADD VALUE IF NOT EXISTS 'local';
```

---

## 3. Import Execution Order & Scheduling

### 3.1 Immediate Imports (no rate limits)

| Priority | Script | Source | Est. Records | Est. Time |
|----------|--------|--------|-------------|-----------|
| 1 | `import-judges.ts` | FJC CSV download | ~3,500 | Minutes |
| 2 | `import-voteview.ts` | VoteView CSV | All Congress historical | Minutes |
| 3 | `import-congress-photos.ts` (NEW) | Bioguide | 538 | Minutes |
| 4 | `import-irs990.ts` | IRS S3 bulk XML | Thousands per run | Hours |

### 3.2 Daily Cron Imports (rate-limited)

| Script | Rate Limit | Est. Days | Cron |
|--------|-----------|-----------|------|
| `import-courtlistener-judges.ts` (NEW) | 5,000/day | 2-3 | Daily |
| `import-judge-financials.ts` | 5,000/day (shared) | 3-5 | Daily |
| `import-littlesis.ts` (NEW) | TBD | Multi-day | Daily |
| `import-opensecrets.ts` (NEW) | 200/day | Weeks | Daily |
| `import-wikimedia-photos.ts` (NEW) | Reasonable | 3-5 | Daily |

### 3.3 Already Scheduled

| Script | Schedule | Status |
|--------|----------|--------|
| State officials (+ photos) | Daily 3am, 7 batches | Running |
| FEC imports | Daily 2am, 2 steps | Running |

### 3.4 Quarterly

| Script | Schedule |
|--------|----------|
| `import-lobbying-bulk.ts` (NEW) | Quarterly XML download |
| `import-stock-trades-disclosures.ts` (NEW) | Monthly disclosure check |

### 3.5 Blocked / Test First

| Script | Blocker |
|--------|---------|
| `import-fara.ts` | Test if API responds |
| `import-civic-officials.ts` (NEW) | Test free tier availability |

---

## 4. Community Contribution Pipeline

### 4.1 GitHub Repo: `thegovguide/community-data`

Structure:
```
community-data/
  README.md                    # Contribution guide
  CONTRIBUTING.md              # Data format specs
  templates/
    local-official.yml         # Issue template
    photo-submission.yml       # Issue template
    correction.yml             # Issue template
  data/
    officials/                 # YAML/JSON files by state/jurisdiction
    photos/                    # Photo URL submissions
    corrections/               # Data corrections
```

### 4.2 Issue Templates

- **Add Local Official**: jurisdiction, name, title, party, contact info, source URL
- **Add Photo**: official name, image URL, license/source
- **Data Correction**: entity, field, current value, correct value, source

### 4.3 GitHub Action

- Validates submission format on PR
- On merge: imports data into Supabase with `source: 'community'` flag
- Labels: `jurisdiction:county`, `jurisdiction:city`, `data-type:official`, `data-type:photo`

### 4.4 Jurisdiction Pages

Each of the 92,114 jurisdiction pages shows:
- What data we have (officials, contacts, website)
- What's missing (officials, photos, meeting schedules)
- "Help fill in this data" link → GitHub issue template pre-filled with jurisdiction info

---

## 5. Expected Coverage at Launch

| Category | Coverage | Source |
|----------|----------|--------|
| Federal officials | 538 Congress + President/VP | Congress.gov, Bioguide |
| State officials | ~7,500 legislators + statewide | OpenStates |
| Federal judges | ~3,500 Article III | FJC |
| State judges | ~10,000+ | CourtListener |
| Local jurisdictions | 92,114 (scaffold) | Census of Governments |
| Local officials | Community-contributed | GitHub |
| Photos | ~11,000+ (Congress + state + judges) | Bioguide, OpenStates, Wikimedia |
| Campaign finance | 45K+ entities, 87K committees | FEC |
| Think tank / board ties | 400K entities, 1.5M relationships | LittleSis |
| Dark money / nonprofits | All politically relevant 990 filers | IRS bulk data |
| Lobbying | Full quarterly filings | Senate LDA bulk XML |
| Stock trades | All congressional disclosures | House/Senate disclosure sites |
| Foreign agents | FARA registrations | FARA API |
| Judge financials | Holdings, income, gifts | CourtListener |
| Ideology scores | All Congress members, historical | VoteView |
| Voting records | 28K+ roll calls, 203K positions | Congress.gov + clerk XML |

**Total: ~500K+ entities with relationship mapping across 92K jurisdictions, entirely from free sources.**
