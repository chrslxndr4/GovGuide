# GovGuide Transparency Platform — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform GovGuide from a civic dashboard into a comprehensive government transparency platform with political money tracking, judicial transparency, conflict of interest detection, and prediction market analysis.

**Architecture:** Builds on existing Astro hybrid site + Supabase. Adds: graph entity/relationship tables, ETL pipeline framework, 50+ API integrations, Cytoscape.js/D3/Sigma.js visualization islands, automated conflict detection engine.

**Tech Stack:** Astro 5, React 19, TypeScript, Tailwind, Supabase (PostgreSQL + PostGIS), MapLibre GL JS, Cytoscape.js, D3.js, Sigma.js, Chart.js, Vitest

**Existing Codebase State:**
- Astro scaffolded with React + Tailwind + MapLibre + Supabase client
- 6 DB migrations (jurisdictions, agencies, officials, elections, laws, zip_lookup)
- Basic components: Header, Footer, Breadcrumb, CategoryCard, InfoBlock, ScopeSwitcher, GovMap
- No tests, no API endpoints, no data pipelines yet
- Pages: only index.astro exists

**Reference:** `docs/plans/2026-03-09-govguide-expanded-design.md`

---

## Phase 1: Foundation & Testing Infrastructure

### Task 1.1: Install Test Framework & New Dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install Vitest and visualization dependencies**

```bash
npm install -D vitest @testing-library/react @testing-library/jest-dom jsdom
npm install cytoscape d3 d3-sankey sigma graphology graphology-layout-forceatlas2 chart.js react-chartjs-2
npm install -D @types/cytoscape @types/d3
```

**Step 2: Create Vitest config**

Create `vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
  },
});
```

**Step 3: Add test script to package.json**

Add to `scripts`: `"test": "vitest run", "test:watch": "vitest"`

**Step 4: Verify test framework works**

Create `src/lib/__tests__/setup.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';

describe('test setup', () => {
  it('works', () => {
    expect(true).toBe(true);
  });
});
```

Run: `npm test`
Expected: 1 test passes.

**Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/lib/__tests__/setup.test.ts
git commit -m "chore: add Vitest test framework and visualization dependencies"
```

---

### Task 1.2: Graph Entity Schema Migration

**Files:**
- Create: `supabase/migrations/007_entities.sql`

**Step 1: Write the entities migration**

```sql
-- Entity types for the relationship graph
CREATE TYPE entity_type AS ENUM (
  'person', 'corporation', 'pac', 'super_pac', 'hybrid_pac',
  '501c4', '501c3', '527_org', 'lobbying_firm', 'trade_association',
  'foreign_principal', 'labor_union', 'political_party'
);

-- Universal entity table (all nodes in the graph)
CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type entity_type NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT[] DEFAULT '{}',
  external_ids JSONB DEFAULT '{}',
  -- external_ids stores: fec_id, ein, bioguide_id, ticker, opensecrets_id,
  -- lda_registrant_id, duns, uei, cik, etc.
  description TEXT,
  website TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Type-specific detail tables
CREATE TABLE entity_persons (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  employer TEXT,
  occupation TEXT,
  city TEXT,
  state CHAR(2),
  zip_code CHAR(5)
);

CREATE TABLE entity_corporations (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  ticker TEXT,
  naics_code TEXT,
  sector TEXT,
  industry TEXT,
  market_cap BIGINT,
  parent_entity_id UUID REFERENCES entities(id),
  cik TEXT -- SEC EDGAR identifier
);

CREATE TABLE entity_pacs (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  fec_committee_id TEXT NOT NULL,
  pac_type TEXT, -- connected, non-connected, super, hybrid, leadership
  designation TEXT, -- authorized, unauthorized, joint_fundraising
  sponsor_entity_id UUID REFERENCES entities(id),
  treasurer_name TEXT,
  filing_frequency TEXT
);

CREATE TABLE entity_nonprofits (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  ein TEXT NOT NULL,
  irs_subsection TEXT, -- 501(c)(3), 501(c)(4), 501(c)(6), etc.
  total_revenue BIGINT,
  total_expenses BIGINT,
  total_assets BIGINT,
  total_grants_made BIGINT,
  political_expenditures BIGINT,
  fiscal_year_end DATE,
  ruling_date DATE
);

CREATE TABLE entity_lobbying_firms (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  lda_registrant_id TEXT,
  client_count INTEGER DEFAULT 0,
  total_income BIGINT DEFAULT 0
);

CREATE TABLE entity_foreign_principals (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  country TEXT NOT NULL,
  principal_type TEXT, -- government, political_party, entity
  registration_date DATE,
  fara_reg_number TEXT
);

-- Indexes
CREATE INDEX idx_entities_type ON entities(entity_type);
CREATE INDEX idx_entities_name ON entities USING gin(name gin_trgm_ops);
CREATE INDEX idx_entities_external_ids ON entities USING gin(external_ids jsonb_path_ops);
CREATE INDEX idx_entities_aliases ON entities USING gin(aliases);
CREATE INDEX idx_entity_corps_ticker ON entity_corporations(ticker);
CREATE INDEX idx_entity_corps_naics ON entity_corporations(naics_code);
CREATE INDEX idx_entity_pacs_fec ON entity_pacs(fec_committee_id);
CREATE INDEX idx_entity_nonprofits_ein ON entity_nonprofits(ein);

-- Enable trigram extension for fuzzy name matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;
```

**Step 2: Commit**

```bash
git add supabase/migrations/007_entities.sql
git commit -m "feat: add entity graph schema with type-specific detail tables"
```

---

### Task 1.3: Relationship Edges Schema Migration

**Files:**
- Create: `supabase/migrations/008_relationships.sql`

**Step 1: Write the relationships migration**

```sql
CREATE TYPE relationship_type AS ENUM (
  -- Money flows
  'donated_to', 'contributed_to', 'spent_for', 'spent_against',
  'granted_to', 'lobbied_via', 'paid_by',
  -- Power relationships
  'represents', 'sits_on', 'appointed_by', 'confirmed_by',
  'employed_by', 'previously_held', 'registered_for',
  -- Legislative
  'sponsored', 'cosponsored', 'voted_yea', 'voted_nay',
  'voted_present', 'voted_absent', 'lobbied_on', 'commented_on',
  'affects_industry',
  -- Judicial
  'decided', 'party_to', 'holds_stock', 'oversees',
  -- Financial
  'traded_stock', 'board_member', 'affiliated_with'
);

CREATE TABLE relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relationship_type relationship_type NOT NULL,
  amount NUMERIC(15,2),
  date_start DATE,
  date_end DATE,
  cycle TEXT, -- election cycle e.g. '2024'
  metadata JSONB DEFAULT '{}',
  -- metadata stores: filing_id, source_url, transaction_id, etc.
  confidence_score NUMERIC(3,2) DEFAULT 1.0,
  source TEXT, -- 'fec', 'lda', 'irs990', 'fara', 'manual', etc.
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Critical indexes for graph traversal
CREATE INDEX idx_relationships_source ON relationships(source_entity_id);
CREATE INDEX idx_relationships_target ON relationships(target_entity_id);
CREATE INDEX idx_relationships_type ON relationships(relationship_type);
CREATE INDEX idx_relationships_source_type ON relationships(source_entity_id, relationship_type);
CREATE INDEX idx_relationships_target_type ON relationships(target_entity_id, relationship_type);
CREATE INDEX idx_relationships_cycle ON relationships(cycle);
CREATE INDEX idx_relationships_amount ON relationships(amount DESC NULLS LAST);
CREATE INDEX idx_relationships_date ON relationships(date_start);

-- Composite index for common graph queries
CREATE INDEX idx_relationships_graph_traverse
  ON relationships(source_entity_id, relationship_type, target_entity_id);
```

**Step 2: Commit**

```bash
git add supabase/migrations/008_relationships.sql
git commit -m "feat: add relationship edges schema for graph traversal"
```

---

### Task 1.4: Campaign Finance Schema Migration

**Files:**
- Create: `supabase/migrations/009_campaign_finance.sql`

**Step 1: Write the campaign finance migration**

```sql
-- Detailed contribution records (FEC Schedule A)
CREATE TABLE contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  donor_entity_id UUID REFERENCES entities(id),
  recipient_entity_id UUID REFERENCES entities(id),
  amount NUMERIC(12,2) NOT NULL,
  contribution_date DATE,
  contribution_type TEXT, -- individual, pac, party, self
  employer TEXT,
  occupation TEXT,
  fec_filing_id TEXT,
  fec_transaction_id TEXT,
  memo TEXT,
  cycle TEXT, -- '2024'
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Independent expenditures (FEC Schedule E)
CREATE TABLE independent_expenditures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spender_entity_id UUID REFERENCES entities(id),
  candidate_entity_id UUID REFERENCES entities(id),
  amount NUMERIC(12,2) NOT NULL,
  expenditure_date DATE,
  support_oppose TEXT CHECK (support_oppose IN ('support', 'oppose')),
  purpose TEXT,
  payee TEXT,
  fec_filing_id TEXT,
  cycle TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Dark money flows (IRS 990 Schedule I grants between orgs)
CREATE TABLE dark_money_flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entity_id UUID REFERENCES entities(id),
  target_entity_id UUID REFERENCES entities(id),
  amount NUMERIC(12,2),
  grant_year INTEGER,
  grant_purpose TEXT,
  irs_filing_year INTEGER,
  source_document TEXT, -- '990_schedule_i'
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_contributions_donor ON contributions(donor_entity_id);
CREATE INDEX idx_contributions_recipient ON contributions(recipient_entity_id);
CREATE INDEX idx_contributions_cycle ON contributions(cycle);
CREATE INDEX idx_contributions_date ON contributions(contribution_date);
CREATE INDEX idx_contributions_amount ON contributions(amount DESC);
CREATE INDEX idx_ie_spender ON independent_expenditures(spender_entity_id);
CREATE INDEX idx_ie_candidate ON independent_expenditures(candidate_entity_id);
CREATE INDEX idx_ie_cycle ON independent_expenditures(cycle);
CREATE INDEX idx_dark_money_source ON dark_money_flows(source_entity_id);
CREATE INDEX idx_dark_money_target ON dark_money_flows(target_entity_id);
```

**Step 2: Commit**

```bash
git add supabase/migrations/009_campaign_finance.sql
git commit -m "feat: add campaign finance schema (contributions, IEs, dark money)"
```

---

### Task 1.5: Lobbying Schema Migration

**Files:**
- Create: `supabase/migrations/010_lobbying.sql`

**Step 1: Write the lobbying migration**

```sql
CREATE TABLE lobbying_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_entity_id UUID REFERENCES entities(id),
  client_entity_id UUID REFERENCES entities(id),
  senate_registration_id TEXT,
  effective_date DATE,
  termination_date DATE,
  general_issues TEXT[],
  specific_issues TEXT,
  foreign_entity_involved BOOLEAN DEFAULT false,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE lobbying_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id UUID REFERENCES lobbying_registrations(id),
  report_year INTEGER NOT NULL,
  report_quarter INTEGER NOT NULL CHECK (report_quarter BETWEEN 1 AND 4),
  income_or_expense NUMERIC(12,2),
  bills_lobbied TEXT[], -- bill IDs e.g. ['hr1234-118', 's567-118']
  agencies_contacted TEXT[], -- agency names
  lobbyists JSONB DEFAULT '[]',
  -- lobbyists: [{name, covered_position, new_lobbyist}]
  general_issues TEXT[],
  specific_issues TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE lobbying_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lobbyist_entity_id UUID REFERENCES entities(id),
  recipient_entity_id UUID REFERENCES entities(id),
  amount NUMERIC(12,2),
  contribution_date DATE,
  contribution_type TEXT,
  fec_filing_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_lobby_reg_firm ON lobbying_registrations(firm_entity_id);
CREATE INDEX idx_lobby_reg_client ON lobbying_registrations(client_entity_id);
CREATE INDEX idx_lobby_act_reg ON lobbying_activities(registration_id);
CREATE INDEX idx_lobby_act_year_qtr ON lobbying_activities(report_year, report_quarter);
CREATE INDEX idx_lobby_act_bills ON lobbying_activities USING gin(bills_lobbied);
CREATE INDEX idx_lobby_contrib_lobbyist ON lobbying_contributions(lobbyist_entity_id);
CREATE INDEX idx_lobby_contrib_recipient ON lobbying_contributions(recipient_entity_id);
```

**Step 2: Commit**

```bash
git add supabase/migrations/010_lobbying.sql
git commit -m "feat: add lobbying schema (registrations, activities, contributions)"
```

---

### Task 1.6: Legislative Schema Migration

**Files:**
- Create: `supabase/migrations/011_legislation.sql`

**Step 1: Write the legislation migration**

```sql
CREATE TABLE bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id TEXT NOT NULL UNIQUE, -- e.g. 'hr1234-119'
  congress INTEGER NOT NULL,
  bill_type TEXT NOT NULL, -- hr, s, hjres, sjres, hconres, sconres, hres, sres
  bill_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  short_title TEXT,
  summary TEXT,
  status TEXT, -- introduced, passed_house, passed_senate, enacted, vetoed
  policy_area TEXT,
  subjects TEXT[],
  naics_affected TEXT[], -- industry codes affected
  introduced_date DATE,
  last_action_date DATE,
  last_action_text TEXT,
  sponsor_official_id UUID REFERENCES officials(id),
  text_url TEXT,
  congress_gov_url TEXT,
  cbo_estimate_url TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE bill_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  action_date DATE NOT NULL,
  action_text TEXT NOT NULL,
  action_type TEXT, -- IntroReferral, Committee, Floor, BecameLaw, etc.
  chamber TEXT, -- house, senate
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE bill_cosponsors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  official_id UUID NOT NULL REFERENCES officials(id),
  cosponsor_date DATE,
  withdrawn_date DATE,
  is_original BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(bill_id, official_id)
);

CREATE TABLE roll_call_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vote_id TEXT NOT NULL UNIQUE, -- e.g. 'h2024-123' or 's2024-45'
  bill_id UUID REFERENCES bills(id),
  chamber TEXT NOT NULL, -- house, senate
  congress INTEGER NOT NULL,
  session INTEGER NOT NULL,
  roll_call_number INTEGER NOT NULL,
  vote_date DATE NOT NULL,
  question TEXT,
  result TEXT, -- Passed, Failed, Agreed to
  yea_count INTEGER,
  nay_count INTEGER,
  not_voting_count INTEGER,
  present_count INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE vote_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vote_id UUID NOT NULL REFERENCES roll_call_votes(id) ON DELETE CASCADE,
  official_id UUID NOT NULL REFERENCES officials(id),
  position TEXT NOT NULL CHECK (position IN ('yea', 'nay', 'present', 'not_voting')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(vote_id, official_id)
);

CREATE INDEX idx_bills_congress ON bills(congress);
CREATE INDEX idx_bills_status ON bills(status);
CREATE INDEX idx_bills_bill_id ON bills(bill_id);
CREATE INDEX idx_bills_sponsor ON bills(sponsor_official_id);
CREATE INDEX idx_bills_subjects ON bills USING gin(subjects);
CREATE INDEX idx_bills_naics ON bills USING gin(naics_affected);
CREATE INDEX idx_bills_introduced ON bills(introduced_date DESC);
CREATE INDEX idx_bill_actions_bill ON bill_actions(bill_id);
CREATE INDEX idx_bill_cosponsors_bill ON bill_cosponsors(bill_id);
CREATE INDEX idx_bill_cosponsors_official ON bill_cosponsors(official_id);
CREATE INDEX idx_votes_bill ON roll_call_votes(bill_id);
CREATE INDEX idx_votes_date ON roll_call_votes(vote_date DESC);
CREATE INDEX idx_vote_positions_vote ON vote_positions(vote_id);
CREATE INDEX idx_vote_positions_official ON vote_positions(official_id);
CREATE INDEX idx_vote_positions_official_position ON vote_positions(official_id, position);
```

**Step 2: Commit**

```bash
git add supabase/migrations/011_legislation.sql
git commit -m "feat: add legislation schema (bills, actions, cosponsors, votes)"
```

---

### Task 1.7: Judicial Schema Migration

**Files:**
- Create: `supabase/migrations/012_judicial.sql`

**Step 1: Write the judicial migration**

```sql
CREATE TYPE court_type AS ENUM (
  'supreme', 'circuit', 'district', 'bankruptcy',
  'state_supreme', 'state_appellate', 'state_trial', 'special'
);

CREATE TABLE courts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  court_type court_type NOT NULL,
  jurisdiction_id UUID REFERENCES jurisdictions(id),
  circuit_number INTEGER, -- 1-13 for federal circuits
  website TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE judges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID REFERENCES entities(id),
  court_id UUID REFERENCES courts(id),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  slug TEXT NOT NULL,
  appointing_president TEXT,
  appointing_president_party TEXT,
  nomination_date DATE,
  confirmation_date DATE,
  confirmation_vote TEXT, -- e.g. '52-48'
  commission_date DATE,
  aba_rating TEXT,
  senior_status_date DATE,
  termination_date DATE,
  termination_reason TEXT, -- retired, resigned, deceased, impeached
  birth_year INTEGER,
  gender TEXT,
  race_ethnicity TEXT,
  law_school TEXT,
  prior_positions TEXT[],
  courtlistener_id INTEGER,
  fjc_id INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE judge_financial_disclosures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  judge_id UUID NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
  disclosure_year INTEGER NOT NULL,
  filing_url TEXT,
  courtlistener_disclosure_id INTEGER,
  parsed BOOLEAN DEFAULT false,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE judge_investments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  disclosure_id UUID NOT NULL REFERENCES judge_financial_disclosures(id) ON DELETE CASCADE,
  judge_id UUID NOT NULL REFERENCES judges(id),
  asset_name TEXT NOT NULL,
  ticker TEXT,
  asset_type TEXT, -- stock, bond, mutual_fund, real_estate, etc.
  value_range_low NUMERIC(15,2),
  value_range_high NUMERIC(15,2),
  income_type TEXT,
  income_range_low NUMERIC(12,2),
  income_range_high NUMERIC(12,2),
  entity_id UUID REFERENCES entities(id), -- link to corporation entity
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE judicial_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_name TEXT NOT NULL,
  case_number TEXT,
  court_id UUID REFERENCES courts(id),
  decision_date DATE,
  citation TEXT,
  issue_codes TEXT[],
  disposition TEXT, -- affirmed, reversed, remanded, etc.
  opinion_type TEXT, -- majority, concurrence, dissent, per_curiam
  opinion_url TEXT,
  courtlistener_id INTEGER,
  -- SCOTUS-specific fields
  scotus_vote_majority INTEGER,
  scotus_vote_minority INTEGER,
  scotus_direction TEXT, -- liberal, conservative, unspecifiable
  scotus_issue_area TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE case_judges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL REFERENCES judicial_decisions(id) ON DELETE CASCADE,
  judge_id UUID NOT NULL REFERENCES judges(id),
  role TEXT NOT NULL, -- author, concurring, dissenting, panel
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(decision_id, judge_id)
);

CREATE TABLE case_parties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL REFERENCES judicial_decisions(id) ON DELETE CASCADE,
  entity_id UUID REFERENCES entities(id),
  party_name TEXT NOT NULL,
  party_role TEXT NOT NULL, -- plaintiff, defendant, appellant, appellee, amicus
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE sentencing_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  judge_id UUID REFERENCES judges(id),
  court_id UUID REFERENCES courts(id),
  fiscal_year INTEGER,
  offense_type TEXT,
  primary_offense_code TEXT,
  guideline_min_months NUMERIC(6,1),
  guideline_max_months NUMERIC(6,1),
  actual_sentence_months NUMERIC(6,1),
  departure_reason TEXT,
  departure_direction TEXT, -- above, below, within
  defendant_gender TEXT,
  defendant_race TEXT,
  defendant_age INTEGER,
  criminal_history_category INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_courts_type ON courts(court_type);
CREATE INDEX idx_courts_jurisdiction ON courts(jurisdiction_id);
CREATE INDEX idx_judges_court ON judges(court_id);
CREATE INDEX idx_judges_slug ON judges(slug);
CREATE INDEX idx_judges_entity ON judges(entity_id);
CREATE INDEX idx_judge_investments_judge ON judge_investments(judge_id);
CREATE INDEX idx_judge_investments_ticker ON judge_investments(ticker);
CREATE INDEX idx_judge_investments_entity ON judge_investments(entity_id);
CREATE INDEX idx_judicial_decisions_court ON judicial_decisions(court_id);
CREATE INDEX idx_judicial_decisions_date ON judicial_decisions(decision_date DESC);
CREATE INDEX idx_case_judges_judge ON case_judges(judge_id);
CREATE INDEX idx_case_parties_entity ON case_parties(entity_id);
CREATE INDEX idx_sentencing_judge ON sentencing_records(judge_id);
CREATE INDEX idx_sentencing_offense ON sentencing_records(offense_type);
```

**Step 2: Commit**

```bash
git add supabase/migrations/012_judicial.sql
git commit -m "feat: add judicial schema (courts, judges, disclosures, decisions, sentencing)"
```

---

### Task 1.8: Stock Trading Schema Migration

**Files:**
- Create: `supabase/migrations/013_stock_trading.sql`

**Step 1: Write the stock trading migration**

```sql
CREATE TABLE stock_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  official_id UUID NOT NULL REFERENCES officials(id),
  ticker TEXT,
  asset_name TEXT NOT NULL,
  asset_type TEXT, -- stock, stock_option, bond, mutual_fund, crypto, other
  trade_type TEXT NOT NULL CHECK (trade_type IN ('buy', 'sell', 'exchange', 'receive')),
  amount_range_low NUMERIC(15,2),
  amount_range_high NUMERIC(15,2),
  trade_date DATE NOT NULL,
  disclosure_date DATE NOT NULL,
  days_late INTEGER GENERATED ALWAYS AS (
    GREATEST(0, disclosure_date - trade_date - 45)
  ) STORED,
  filing_url TEXT,
  owner TEXT, -- self, spouse, dependent, joint
  comment TEXT,
  entity_id UUID REFERENCES entities(id), -- link to corporation entity
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE official_holdings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  official_id UUID NOT NULL REFERENCES officials(id),
  ticker TEXT,
  asset_name TEXT NOT NULL,
  asset_type TEXT,
  value_range_low NUMERIC(15,2),
  value_range_high NUMERIC(15,2),
  income_range_low NUMERIC(12,2),
  income_range_high NUMERIC(12,2),
  disclosure_year INTEGER NOT NULL,
  owner TEXT,
  entity_id UUID REFERENCES entities(id),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_stock_trades_official ON stock_trades(official_id);
CREATE INDEX idx_stock_trades_ticker ON stock_trades(ticker);
CREATE INDEX idx_stock_trades_date ON stock_trades(trade_date DESC);
CREATE INDEX idx_stock_trades_disclosure ON stock_trades(disclosure_date DESC);
CREATE INDEX idx_stock_trades_late ON stock_trades(days_late DESC) WHERE days_late > 0;
CREATE INDEX idx_stock_trades_entity ON stock_trades(entity_id);
CREATE INDEX idx_official_holdings_official ON official_holdings(official_id);
CREATE INDEX idx_official_holdings_ticker ON official_holdings(ticker);
CREATE INDEX idx_official_holdings_year ON official_holdings(disclosure_year);
```

**Step 2: Commit**

```bash
git add supabase/migrations/013_stock_trading.sql
git commit -m "feat: add congressional stock trading schema"
```

---

### Task 1.9: Polling & Prediction Markets Schema Migration

**Files:**
- Create: `supabase/migrations/014_predictions.sql`

**Step 1: Write the predictions migration**

```sql
CREATE TABLE polls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pollster TEXT NOT NULL,
  poll_url TEXT,
  race_type TEXT NOT NULL, -- presidential, senate, house, governor, generic_ballot
  state TEXT, -- null for national
  district TEXT, -- for house races
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  sample_size INTEGER,
  margin_of_error NUMERIC(4,2),
  methodology TEXT, -- live_phone, online, ivr, mixed
  population TEXT, -- registered, likely, adult
  partisan TEXT, -- null, R, D (sponsor)
  candidates JSONB NOT NULL, -- [{name, party, percentage}]
  cycle TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE pollster_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pollster TEXT NOT NULL UNIQUE,
  accuracy_score NUMERIC(5,3),
  mean_bias NUMERIC(5,3), -- positive = R bias, negative = D bias
  races_polled INTEGER,
  methodology_transparency TEXT, -- high, medium, low
  is_partisan BOOLEAN DEFAULT false,
  rating_source TEXT, -- '538', 'custom'
  metadata JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE prediction_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL, -- polymarket, kalshi, metaculus
  platform_contract_id TEXT NOT NULL,
  question TEXT NOT NULL,
  category TEXT, -- election, legislation, policy, geopolitical, regulatory
  subcategory TEXT,
  current_probability NUMERIC(5,4), -- 0.0000 to 1.0000
  volume_total NUMERIC(15,2),
  open_date TIMESTAMPTZ,
  close_date TIMESTAMPTZ,
  resolved BOOLEAN DEFAULT false,
  resolved_outcome TEXT, -- 'yes', 'no', null
  resolution_date TIMESTAMPTZ,
  contract_url TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(platform, platform_contract_id)
);

CREATE TABLE prediction_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES prediction_contracts(id) ON DELETE CASCADE,
  snapshot_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  probability NUMERIC(5,4) NOT NULL,
  volume_24h NUMERIC(15,2),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE prediction_anomalies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES prediction_contracts(id),
  anomaly_type TEXT NOT NULL, -- volume_spike, rapid_price_move, large_single_trade, pre_event_move
  detection_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  description TEXT NOT NULL,
  severity_score NUMERIC(3,1), -- 1.0 to 10.0
  probability_before NUMERIC(5,4),
  probability_after NUMERIC(5,4),
  volume_before NUMERIC(15,2),
  volume_after NUMERIC(15,2),
  related_event TEXT,
  related_event_time TIMESTAMPTZ,
  wallet_addresses TEXT[], -- for polymarket on-chain analysis
  metadata JSONB DEFAULT '{}',
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'reviewed', 'dismissed', 'confirmed')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_polls_race ON polls(race_type, state);
CREATE INDEX idx_polls_date ON polls(end_date DESC);
CREATE INDEX idx_polls_cycle ON polls(cycle);
CREATE INDEX idx_polls_pollster ON polls(pollster);
CREATE INDEX idx_prediction_contracts_platform ON prediction_contracts(platform);
CREATE INDEX idx_prediction_contracts_category ON prediction_contracts(category);
CREATE INDEX idx_prediction_contracts_active ON prediction_contracts(resolved, close_date) WHERE NOT resolved;
CREATE INDEX idx_prediction_snapshots_contract ON prediction_snapshots(contract_id, snapshot_time DESC);
CREATE INDEX idx_prediction_anomalies_contract ON prediction_anomalies(contract_id);
CREATE INDEX idx_prediction_anomalies_severity ON prediction_anomalies(severity_score DESC);
CREATE INDEX idx_prediction_anomalies_status ON prediction_anomalies(status) WHERE status = 'active';
```

**Step 2: Commit**

```bash
git add supabase/migrations/014_predictions.sql
git commit -m "feat: add polling and prediction markets schema"
```

---

### Task 1.10: Conflict Alerts & Scores Schema Migration

**Files:**
- Create: `supabase/migrations/015_conflicts_and_scores.sql`

**Step 1: Write the conflicts and scoring migration**

```sql
CREATE TYPE conflict_type AS ENUM (
  'donor_vote', 'stock_committee', 'trade_timing',
  'judicial_financial', 'contract_donor', 'revolving_door',
  'prediction_insider', 'dark_money_chain'
);

CREATE TABLE conflict_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type conflict_type NOT NULL,
  severity_score NUMERIC(3,1) NOT NULL, -- 1.0 to 10.0
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  entity_ids UUID[] NOT NULL, -- all involved entities
  official_id UUID REFERENCES officials(id),
  judge_id UUID REFERENCES judges(id),
  bill_id UUID REFERENCES bills(id),
  evidence JSONB NOT NULL,
  -- evidence: {amounts, dates, filings, relationship_path, etc.}
  detected_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'reviewed', 'dismissed')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE transparency_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  official_id UUID NOT NULL REFERENCES officials(id),
  score_date DATE NOT NULL,
  overall_score NUMERIC(4,1) NOT NULL, -- 0.0 to 100.0
  grade CHAR(2) NOT NULL, -- A+, A, A-, B+, B, B-, C+, C, C-, D, F
  component_scores JSONB NOT NULL,
  -- {disclosure_completeness, stock_act_compliance, town_halls,
  --  conflicts_count, transparency_legislation, small_donor_pct,
  --  attendance_rate, press_accessibility}
  methodology_version TEXT DEFAULT 'v1',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(official_id, score_date)
);

CREATE TABLE corporate_influence_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entities(id),
  score_date DATE NOT NULL,
  overall_score NUMERIC(4,1) NOT NULL,
  component_scores JSONB NOT NULL,
  -- {lobbying_spend, pac_contributions, revolving_door_hires,
  --  dark_money_funding, government_contracts, regulatory_comments,
  --  trade_association_memberships}
  industry_rank INTEGER,
  overall_rank INTEGER,
  methodology_version TEXT DEFAULT 'v1',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(entity_id, score_date)
);

-- Community contributions
CREATE TABLE community_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submitter_name TEXT,
  submitter_email TEXT,
  submitter_org TEXT,
  submission_type TEXT NOT NULL, -- campaign_finance, disclosure, meeting, lobbying, other
  jurisdiction_id UUID REFERENCES jurisdictions(id),
  title TEXT NOT NULL,
  data JSONB NOT NULL,
  source_url TEXT,
  source_document_url TEXT,
  notes TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'verified', 'rejected')),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Geospatial (compactness scores for gerrymandering analysis)
CREATE TABLE district_compactness (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id),
  district_type TEXT NOT NULL, -- congressional, state_upper, state_lower
  district_number TEXT,
  vintage_year INTEGER NOT NULL,
  polsby_popper NUMERIC(5,4), -- 0 to 1, higher = more compact
  reock NUMERIC(5,4),
  convex_hull NUMERIC(5,4),
  efficiency_gap NUMERIC(5,4), -- negative = D advantage, positive = R advantage
  mean_median_difference NUMERIC(5,4),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(jurisdiction_id, district_type, district_number, vintage_year)
);

CREATE INDEX idx_conflict_alerts_type ON conflict_alerts(alert_type);
CREATE INDEX idx_conflict_alerts_severity ON conflict_alerts(severity_score DESC);
CREATE INDEX idx_conflict_alerts_official ON conflict_alerts(official_id);
CREATE INDEX idx_conflict_alerts_status ON conflict_alerts(status);
CREATE INDEX idx_conflict_alerts_detected ON conflict_alerts(detected_at DESC);
CREATE INDEX idx_transparency_scores_official ON transparency_scores(official_id);
CREATE INDEX idx_transparency_scores_grade ON transparency_scores(grade);
CREATE INDEX idx_corporate_influence_entity ON corporate_influence_scores(entity_id);
CREATE INDEX idx_corporate_influence_rank ON corporate_influence_scores(overall_rank);
CREATE INDEX idx_community_submissions_status ON community_submissions(status);
CREATE INDEX idx_community_submissions_jurisdiction ON community_submissions(jurisdiction_id);
CREATE INDEX idx_district_compactness_jurisdiction ON district_compactness(jurisdiction_id);
```

**Step 2: Commit**

```bash
git add supabase/migrations/015_conflicts_and_scores.sql
git commit -m "feat: add conflict alerts, transparency scores, community submissions, compactness schemas"
```

---

### Task 1.11: Graph Traversal Functions

**Files:**
- Create: `supabase/migrations/016_graph_functions.sql`

**Step 1: Write the graph traversal functions**

```sql
-- Find all money paths between two entities (up to N hops)
CREATE OR REPLACE FUNCTION find_money_paths(
  p_source_id UUID,
  p_target_id UUID,
  p_max_hops INTEGER DEFAULT 5
)
RETURNS TABLE(
  path UUID[],
  relationship_types TEXT[],
  total_amount NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE money_path AS (
    SELECT
      ARRAY[r.source_entity_id, r.target_entity_id] AS path,
      ARRAY[r.relationship_type::TEXT] AS rel_types,
      COALESCE(r.amount, 0) AS total,
      r.target_entity_id AS current_node,
      1 AS depth
    FROM relationships r
    WHERE r.source_entity_id = p_source_id
      AND r.relationship_type IN (
        'donated_to', 'contributed_to', 'granted_to',
        'spent_for', 'spent_against', 'lobbied_via', 'paid_by'
      )
    UNION ALL
    SELECT
      mp.path || r.target_entity_id,
      mp.rel_types || r.relationship_type::TEXT,
      mp.total + COALESCE(r.amount, 0),
      r.target_entity_id,
      mp.depth + 1
    FROM money_path mp
    JOIN relationships r ON r.source_entity_id = mp.current_node
    WHERE mp.depth < p_max_hops
      AND r.target_entity_id != ALL(mp.path)
      AND r.relationship_type IN (
        'donated_to', 'contributed_to', 'granted_to',
        'spent_for', 'spent_against', 'lobbied_via', 'paid_by'
      )
  )
  SELECT mp.path, mp.rel_types, mp.total
  FROM money_path mp
  WHERE mp.current_node = p_target_id
  ORDER BY mp.total DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql STABLE;

-- Get N-hop neighborhood of an entity (for graph visualization)
CREATE OR REPLACE FUNCTION get_entity_neighborhood(
  p_entity_id UUID,
  p_max_hops INTEGER DEFAULT 2,
  p_relationship_types relationship_type[] DEFAULT NULL,
  p_min_amount NUMERIC DEFAULT NULL
)
RETURNS TABLE(
  entity_id UUID,
  entity_name TEXT,
  entity_type entity_type,
  hop_distance INTEGER
) AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE neighborhood AS (
    SELECT p_entity_id AS eid, 0 AS depth
    UNION
    SELECT
      CASE
        WHEN r.source_entity_id = n.eid THEN r.target_entity_id
        ELSE r.source_entity_id
      END AS eid,
      n.depth + 1 AS depth
    FROM neighborhood n
    JOIN relationships r ON (r.source_entity_id = n.eid OR r.target_entity_id = n.eid)
    WHERE n.depth < p_max_hops
      AND (p_relationship_types IS NULL OR r.relationship_type = ANY(p_relationship_types))
      AND (p_min_amount IS NULL OR r.amount >= p_min_amount)
  )
  SELECT DISTINCT ON (e.id)
    e.id,
    e.name,
    e.entity_type,
    MIN(n.depth) AS hop_distance
  FROM neighborhood n
  JOIN entities e ON e.id = n.eid
  GROUP BY e.id, e.name, e.entity_type
  ORDER BY e.id, MIN(n.depth)
  LIMIT 500;
END;
$$ LANGUAGE plpgsql STABLE;

-- Get edges between a set of entities (for graph visualization)
CREATE OR REPLACE FUNCTION get_edges_between(
  p_entity_ids UUID[]
)
RETURNS TABLE(
  relationship_id UUID,
  source_id UUID,
  target_id UUID,
  rel_type relationship_type,
  amount NUMERIC,
  date_start DATE,
  cycle TEXT,
  metadata JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    r.id,
    r.source_entity_id,
    r.target_entity_id,
    r.relationship_type,
    r.amount,
    r.date_start,
    r.cycle,
    r.metadata
  FROM relationships r
  WHERE r.source_entity_id = ANY(p_entity_ids)
    AND r.target_entity_id = ANY(p_entity_ids);
END;
$$ LANGUAGE plpgsql STABLE;

-- Top donors for an official (aggregated across cycles)
CREATE OR REPLACE FUNCTION get_official_top_donors(
  p_official_id UUID,
  p_limit INTEGER DEFAULT 20,
  p_cycle TEXT DEFAULT NULL
)
RETURNS TABLE(
  donor_entity_id UUID,
  donor_name TEXT,
  donor_type entity_type,
  total_amount NUMERIC,
  contribution_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id,
    e.name,
    e.entity_type,
    SUM(c.amount) AS total_amount,
    COUNT(*) AS contribution_count
  FROM contributions c
  JOIN entities e ON e.id = c.donor_entity_id
  JOIN officials o ON o.id = p_official_id
  JOIN entities oe ON oe.external_ids->>'fec_id' = o.fec_id
  WHERE c.recipient_entity_id = oe.id
    AND (p_cycle IS NULL OR c.cycle = p_cycle)
  GROUP BY e.id, e.name, e.entity_type
  ORDER BY total_amount DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE;
```

**Step 2: Commit**

```bash
git add supabase/migrations/016_graph_functions.sql
git commit -m "feat: add graph traversal functions (money paths, neighborhood, top donors)"
```

---

### Task 1.12: Materialized Views

**Files:**
- Create: `supabase/migrations/017_materialized_views.sql`

**Step 1: Write the materialized views**

```sql
-- Top donors per official (refreshed daily)
CREATE MATERIALIZED VIEW mv_official_top_donors AS
SELECT
  o.id AS official_id,
  e.id AS donor_entity_id,
  e.name AS donor_name,
  e.entity_type AS donor_type,
  c.cycle,
  SUM(c.amount) AS total_amount,
  COUNT(*) AS contribution_count,
  ROW_NUMBER() OVER (PARTITION BY o.id, c.cycle ORDER BY SUM(c.amount) DESC) AS rank
FROM officials o
JOIN entities oe ON oe.external_ids->>'fec_id' = o.fec_id AND o.fec_id IS NOT NULL
JOIN contributions c ON c.recipient_entity_id = oe.id
JOIN entities e ON e.id = c.donor_entity_id
GROUP BY o.id, e.id, e.name, e.entity_type, c.cycle;

CREATE UNIQUE INDEX idx_mv_top_donors_pk ON mv_official_top_donors(official_id, donor_entity_id, cycle);
CREATE INDEX idx_mv_top_donors_official ON mv_official_top_donors(official_id, cycle, rank);

-- Industry funding per official (refreshed daily)
CREATE MATERIALIZED VIEW mv_official_industry_funding AS
SELECT
  o.id AS official_id,
  ec.sector,
  ec.industry,
  ec.naics_code,
  c.cycle,
  SUM(c.amount) AS total_amount,
  COUNT(DISTINCT c.donor_entity_id) AS donor_count
FROM officials o
JOIN entities oe ON oe.external_ids->>'fec_id' = o.fec_id AND o.fec_id IS NOT NULL
JOIN contributions c ON c.recipient_entity_id = oe.id
JOIN entities e ON e.id = c.donor_entity_id
LEFT JOIN entity_corporations ec ON ec.entity_id = e.id
WHERE ec.sector IS NOT NULL
GROUP BY o.id, ec.sector, ec.industry, ec.naics_code, c.cycle;

CREATE INDEX idx_mv_industry_funding_official ON mv_official_industry_funding(official_id, cycle);

-- Stock trade alerts (trades near committee-relevant votes)
CREATE MATERIALIZED VIEW mv_stock_trade_alerts AS
SELECT
  st.id AS trade_id,
  st.official_id,
  st.ticker,
  st.asset_name,
  st.trade_type,
  st.amount_range_low,
  st.amount_range_high,
  st.trade_date,
  st.days_late,
  rcv.id AS vote_id,
  b.bill_id AS bill_identifier,
  b.title AS bill_title,
  rcv.vote_date,
  ABS(rcv.vote_date - st.trade_date) AS days_between,
  vp.position AS vote_position
FROM stock_trades st
JOIN officials o ON o.id = st.official_id
JOIN vote_positions vp ON vp.official_id = o.id
JOIN roll_call_votes rcv ON rcv.id = vp.vote_id
JOIN bills b ON b.id = rcv.bill_id
WHERE ABS(rcv.vote_date - st.trade_date) <= 30
  AND st.ticker IS NOT NULL;

CREATE INDEX idx_mv_stock_alerts_official ON mv_stock_trade_alerts(official_id);
CREATE INDEX idx_mv_stock_alerts_days ON mv_stock_trade_alerts(days_between);

-- Refresh function for all materialized views
CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS VOID AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_official_top_donors;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_official_industry_funding;
  REFRESH MATERIALIZED VIEW mv_stock_trade_alerts;
END;
$$ LANGUAGE plpgsql;
```

**Step 2: Commit**

```bash
git add supabase/migrations/017_materialized_views.sql
git commit -m "feat: add materialized views for top donors, industry funding, stock alerts"
```

---

## Phase 2: Data Pipeline Infrastructure

### Task 2.1: Pipeline Framework & Types

**Files:**
- Create: `src/lib/types/entities.ts`
- Create: `src/lib/types/api-clients.ts`
- Create: `scripts/pipeline/base.ts`

**Step 1: Create entity type definitions**

`src/lib/types/entities.ts`:
```typescript
export type EntityType =
  | 'person' | 'corporation' | 'pac' | 'super_pac' | 'hybrid_pac'
  | '501c4' | '501c3' | '527_org' | 'lobbying_firm' | 'trade_association'
  | 'foreign_principal' | 'labor_union' | 'political_party';

export type RelationshipType =
  | 'donated_to' | 'contributed_to' | 'spent_for' | 'spent_against'
  | 'granted_to' | 'lobbied_via' | 'paid_by'
  | 'represents' | 'sits_on' | 'appointed_by' | 'confirmed_by'
  | 'employed_by' | 'previously_held' | 'registered_for'
  | 'sponsored' | 'cosponsored' | 'voted_yea' | 'voted_nay'
  | 'voted_present' | 'voted_absent' | 'lobbied_on' | 'commented_on'
  | 'affects_industry'
  | 'decided' | 'party_to' | 'holds_stock' | 'oversees'
  | 'traded_stock' | 'board_member' | 'affiliated_with';

export interface Entity {
  id?: string;
  entity_type: EntityType;
  name: string;
  aliases?: string[];
  external_ids?: Record<string, string>;
  description?: string;
  website?: string;
  metadata?: Record<string, unknown>;
}

export interface Relationship {
  id?: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: RelationshipType;
  amount?: number;
  date_start?: string;
  date_end?: string;
  cycle?: string;
  metadata?: Record<string, unknown>;
  confidence_score?: number;
  source?: string;
}
```

**Step 2: Create API client types**

`src/lib/types/api-clients.ts`:
```typescript
export interface PipelineResult {
  source: string;
  records_fetched: number;
  records_inserted: number;
  records_updated: number;
  records_skipped: number;
  errors: string[];
  duration_ms: number;
}

export interface PipelineConfig {
  name: string;
  schedule: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  enabled: boolean;
}

export interface FECApiConfig {
  apiKey: string;
  baseUrl: string;
  rateLimit: number; // requests per hour
}

export interface CongressApiConfig {
  apiKey: string;
  baseUrl: string;
  rateLimit: number;
}
```

**Step 3: Create pipeline base**

`scripts/pipeline/base.ts`:
```typescript
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { PipelineResult } from '../../src/lib/types/api-clients.js';

export abstract class BasePipeline {
  protected supabase: SupabaseClient;
  protected results: PipelineResult;
  protected startTime: number;

  constructor() {
    const url = process.env.PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Missing Supabase credentials');
    this.supabase = createClient(url, key);
    this.startTime = Date.now();
    this.results = {
      source: this.getName(),
      records_fetched: 0,
      records_inserted: 0,
      records_updated: 0,
      records_skipped: 0,
      errors: [],
      duration_ms: 0,
    };
  }

  abstract getName(): string;
  abstract run(): Promise<void>;

  async execute(): Promise<PipelineResult> {
    console.log(`[${this.getName()}] Starting pipeline...`);
    try {
      await this.run();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.results.errors.push(msg);
      console.error(`[${this.getName()}] Fatal error: ${msg}`);
    }
    this.results.duration_ms = Date.now() - this.startTime;
    console.log(`[${this.getName()}] Complete.`, {
      fetched: this.results.records_fetched,
      inserted: this.results.records_inserted,
      updated: this.results.records_updated,
      errors: this.results.errors.length,
      duration: `${this.results.duration_ms}ms`,
    });
    return this.results;
  }

  protected async upsertEntity(
    entity: { entity_type: string; name: string; external_ids?: Record<string, string> },
    matchField: string,
    matchValue: string
  ): Promise<string> {
    // Try to find existing entity by external ID
    const { data: existing } = await this.supabase
      .from('entities')
      .select('id')
      .contains('external_ids', { [matchField]: matchValue })
      .single();

    if (existing) return existing.id;

    // Insert new entity
    const { data: inserted, error } = await this.supabase
      .from('entities')
      .insert({
        entity_type: entity.entity_type,
        name: entity.name,
        external_ids: entity.external_ids || { [matchField]: matchValue },
      })
      .select('id')
      .single();

    if (error) throw new Error(`Entity insert failed: ${error.message}`);
    this.results.records_inserted++;
    return inserted!.id;
  }

  protected async rateLimitedFetch(url: string, delayMs: number = 100): Promise<Response> {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${url}`);
    }
    return response;
  }
}
```

**Step 4: Commit**

```bash
git add src/lib/types/entities.ts src/lib/types/api-clients.ts scripts/pipeline/base.ts
git commit -m "feat: add pipeline framework, entity types, and base pipeline class"
```

---

### Task 2.2: FEC API Client

**Files:**
- Create: `scripts/pipeline/clients/fec.ts`
- Create: `scripts/pipeline/__tests__/fec.test.ts`

**Step 1: Write the FEC client test**

`scripts/pipeline/__tests__/fec.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { FECClient } from '../clients/fec.js';

describe('FECClient', () => {
  it('constructs valid candidate search URL', () => {
    const client = new FECClient('TEST_KEY');
    const url = client.buildUrl('/candidates/', { state: 'CA', office: 'S' });
    expect(url).toContain('api.open.fec.gov/v1/candidates/');
    expect(url).toContain('api_key=TEST_KEY');
    expect(url).toContain('state=CA');
    expect(url).toContain('office=S');
  });

  it('constructs valid schedule_a URL with pagination', () => {
    const client = new FECClient('TEST_KEY');
    const url = client.buildUrl('/schedules/schedule_a/', {
      committee_id: 'C00001234',
      per_page: '100',
    });
    expect(url).toContain('committee_id=C00001234');
    expect(url).toContain('per_page=100');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/pipeline/__tests__/fec.test.ts`
Expected: FAIL — module not found.

**Step 3: Write the FEC client**

`scripts/pipeline/clients/fec.ts`:
```typescript
const FEC_BASE_URL = 'https://api.open.fec.gov/v1';

export class FECClient {
  private apiKey: string;
  private requestCount = 0;
  private windowStart = Date.now();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  buildUrl(endpoint: string, params: Record<string, string> = {}): string {
    const url = new URL(`${FEC_BASE_URL}${endpoint}`);
    url.searchParams.set('api_key', this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private async throttle(): Promise<void> {
    this.requestCount++;
    if (this.requestCount >= 950) { // stay under 1000/hr limit
      const elapsed = Date.now() - this.windowStart;
      if (elapsed < 3600000) {
        const wait = 3600000 - elapsed + 1000;
        console.log(`[FEC] Rate limit approaching, waiting ${wait}ms`);
        await new Promise(resolve => setTimeout(resolve, wait));
      }
      this.requestCount = 0;
      this.windowStart = Date.now();
    }
    // Minimum 100ms between requests
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  async fetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    await this.throttle();
    const url = this.buildUrl(endpoint, params);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`FEC API error ${response.status}: ${endpoint}`);
    }
    return response.json() as Promise<T>;
  }

  async fetchAllPages<T>(
    endpoint: string,
    params: Record<string, string> = {},
    maxPages: number = 100
  ): Promise<T[]> {
    const allResults: T[] = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= maxPages) {
      const data = await this.fetch<{
        results: T[];
        pagination: { pages: number; page: number; count: number };
      }>(endpoint, { ...params, page: String(page), per_page: '100' });

      allResults.push(...data.results);
      hasMore = page < data.pagination.pages;
      page++;
    }

    return allResults;
  }

  // Convenience methods for common endpoints
  async getCandidates(params: Record<string, string> = {}) {
    return this.fetchAllPages<FECCandidate>('/candidates/', params);
  }

  async getCommittees(params: Record<string, string> = {}) {
    return this.fetchAllPages<FECCommittee>('/committees/', params);
  }

  async getContributions(committeeId: string, params: Record<string, string> = {}) {
    return this.fetchAllPages<FECContribution>(
      '/schedules/schedule_a/',
      { committee_id: committeeId, ...params }
    );
  }

  async getIndependentExpenditures(params: Record<string, string> = {}) {
    return this.fetchAllPages<FECIndependentExpenditure>(
      '/schedules/schedule_e/',
      params
    );
  }
}

// FEC API response types
export interface FECCandidate {
  candidate_id: string;
  name: string;
  party: string;
  state: string;
  district: string;
  office: string;
  incumbent_challenge: string;
  candidate_status: string;
  principal_committees: { committee_id: string; name: string }[];
}

export interface FECCommittee {
  committee_id: string;
  name: string;
  committee_type: string;
  designation: string;
  party: string;
  state: string;
  treasurer_name: string;
  sponsor_candidate_ids: string[];
}

export interface FECContribution {
  committee_id: string;
  contributor_name: string;
  contributor_employer: string;
  contributor_occupation: string;
  contributor_city: string;
  contributor_state: string;
  contributor_zip: string;
  contribution_receipt_amount: number;
  contribution_receipt_date: string;
  fec_election_type_desc: string;
  memo_text: string;
  sub_id: string;
}

export interface FECIndependentExpenditure {
  committee_id: string;
  committee_name: string;
  candidate_id: string;
  candidate_name: string;
  support_oppose_indicator: string;
  expenditure_amount: number;
  expenditure_date: string;
  purpose: string;
  payee_name: string;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/pipeline/__tests__/fec.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add scripts/pipeline/clients/fec.ts scripts/pipeline/__tests__/fec.test.ts
git commit -m "feat: add FEC API client with rate limiting and pagination"
```

---

### Task 2.3: Congress.gov API Client

**Files:**
- Create: `scripts/pipeline/clients/congress.ts`

**Step 1: Write the Congress.gov client**

`scripts/pipeline/clients/congress.ts`:
```typescript
const CONGRESS_BASE_URL = 'https://api.congress.gov/v3';

export class CongressClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  buildUrl(endpoint: string, params: Record<string, string> = {}): string {
    const url = new URL(`${CONGRESS_BASE_URL}${endpoint}`);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('format', 'json');
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async fetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    await new Promise(resolve => setTimeout(resolve, 750)); // ~5000/hr
    const url = this.buildUrl(endpoint, params);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Congress API ${response.status}: ${endpoint}`);
    return response.json() as Promise<T>;
  }

  async fetchAllPages<T>(
    endpoint: string,
    resultsKey: string,
    params: Record<string, string> = {},
    maxPages: number = 100
  ): Promise<T[]> {
    const all: T[] = [];
    let offset = 0;
    const limit = 250;
    let hasMore = true;

    while (hasMore && offset / limit < maxPages) {
      const data = await this.fetch<Record<string, unknown>>(endpoint, {
        ...params,
        offset: String(offset),
        limit: String(limit),
      });
      const results = (data[resultsKey] as T[]) || [];
      all.push(...results);
      hasMore = results.length === limit;
      offset += limit;
    }
    return all;
  }

  async getBills(congress: number, params: Record<string, string> = {}) {
    return this.fetchAllPages<CongressBill>(
      `/bill/${congress}`, 'bills', params
    );
  }

  async getBillDetail(congress: number, type: string, number: number) {
    return this.fetch<{ bill: CongressBillDetail }>(
      `/bill/${congress}/${type}/${number}`
    );
  }

  async getMembers(params: Record<string, string> = {}) {
    return this.fetchAllPages<CongressMember>('/member', 'members', params);
  }

  async getMemberDetail(bioguideId: string) {
    return this.fetch<{ member: CongressMemberDetail }>(`/member/${bioguideId}`);
  }
}

export interface CongressBill {
  congress: number;
  type: string;
  number: number;
  title: string;
  latestAction: { actionDate: string; text: string };
  url: string;
}

export interface CongressBillDetail {
  congress: number;
  type: string;
  number: number;
  title: string;
  introducedDate: string;
  sponsors: { bioguideId: string; fullName: string }[];
  policyArea: { name: string };
  subjects: { legislativeSubjects: { name: string }[] };
  actions: { count: number };
  cosponsors: { count: number };
  latestAction: { actionDate: string; text: string };
}

export interface CongressMember {
  bioguideId: string;
  name: string;
  partyName: string;
  state: string;
  district?: number;
  terms: { item: { chamber: string; startYear: number; endYear?: number }[] };
}

export interface CongressMemberDetail extends CongressMember {
  birthYear: string;
  depiction: { imageUrl: string };
  sponsoredLegislation: { count: number };
  cosponsoredLegislation: { count: number };
}
```

**Step 2: Commit**

```bash
git add scripts/pipeline/clients/congress.ts
git commit -m "feat: add Congress.gov API client with pagination"
```

---

### Task 2.4: Senate LDA (Lobbying) API Client

**Files:**
- Create: `scripts/pipeline/clients/senate-lda.ts`

**Step 1: Write the Senate LDA client**

`scripts/pipeline/clients/senate-lda.ts`:
```typescript
const LDA_BASE_URL = 'https://lda.senate.gov/api/v1';

export class SenateLDAClient {
  async fetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    await new Promise(resolve => setTimeout(resolve, 200));
    const url = new URL(`${LDA_BASE_URL}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url.toString());
    if (!response.ok) throw new Error(`LDA API ${response.status}: ${endpoint}`);
    return response.json() as Promise<T>;
  }

  async fetchAllPages<T>(
    endpoint: string,
    params: Record<string, string> = {},
    maxPages: number = 100
  ): Promise<T[]> {
    const all: T[] = [];
    let nextUrl: string | null = null;
    let page = 0;

    const firstPage = await this.fetch<LDAPaginatedResponse<T>>(endpoint, {
      ...params,
      page_size: '25',
    });
    all.push(...firstPage.results);
    nextUrl = firstPage.next;
    page++;

    while (nextUrl && page < maxPages) {
      await new Promise(resolve => setTimeout(resolve, 200));
      const response = await fetch(nextUrl);
      if (!response.ok) break;
      const data = (await response.json()) as LDAPaginatedResponse<T>;
      all.push(...data.results);
      nextUrl = data.next;
      page++;
    }
    return all;
  }

  async getFilings(params: Record<string, string> = {}) {
    return this.fetchAllPages<LDAFiling>('/filings/', params);
  }

  async getRegistrants(params: Record<string, string> = {}) {
    return this.fetchAllPages<LDARegistrant>('/registrants/', params);
  }

  async getClients(params: Record<string, string> = {}) {
    return this.fetchAllPages<LDAClient>('/clients/', params);
  }

  async getContributions(params: Record<string, string> = {}) {
    return this.fetchAllPages<LDAContribution>('/contributions/', params);
  }
}

interface LDAPaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface LDAFiling {
  filing_uuid: string;
  filing_type: string;
  filing_year: number;
  filing_period: string;
  registrant: { id: number; name: string };
  client: { id: number; name: string };
  income: string | null;
  expenses: string | null;
  lobbying_activities: LDALobbyingActivity[];
  posted_by_name: string;
  dt_posted: string;
}

export interface LDALobbyingActivity {
  general_issue_code: string;
  general_issue_code_display: string;
  description: string;
  lobbyists: { lobbyist: { id: number; name: string }; covered_position: string }[];
  government_entities: { id: number; name: string }[];
}

export interface LDARegistrant {
  id: number;
  name: string;
  description: string;
  address: string;
  country: string;
}

export interface LDAClient {
  id: number;
  name: string;
  general_description: string;
  country: string;
  state: string;
}

export interface LDAContribution {
  filing_uuid: string;
  lobbyist_name: string;
  contributor_name: string;
  payee_name: string;
  amount: string;
  contribution_date: string;
  contribution_type: string;
}
```

**Step 2: Commit**

```bash
git add scripts/pipeline/clients/senate-lda.ts
git commit -m "feat: add Senate LDA lobbying API client"
```

---

### Task 2.5: CourtListener API Client

**Files:**
- Create: `scripts/pipeline/clients/courtlistener.ts`

**Step 1: Write the CourtListener client**

`scripts/pipeline/clients/courtlistener.ts`:
```typescript
const CL_BASE_URL = 'https://www.courtlistener.com/api/rest/v4';

export class CourtListenerClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  async fetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    await new Promise(resolve => setTimeout(resolve, 200)); // ~5000/day budget
    const url = new URL(`${CL_BASE_URL}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Token ${this.token}` },
    });
    if (!response.ok) throw new Error(`CourtListener ${response.status}: ${endpoint}`);
    return response.json() as Promise<T>;
  }

  async fetchAllPages<T>(
    endpoint: string,
    params: Record<string, string> = {},
    maxPages: number = 50
  ): Promise<T[]> {
    const all: T[] = [];
    let nextUrl: string | null = null;
    let page = 0;

    const first = await this.fetch<CLPaginatedResponse<T>>(endpoint, params);
    all.push(...first.results);
    nextUrl = first.next;
    page++;

    while (nextUrl && page < maxPages) {
      await new Promise(resolve => setTimeout(resolve, 200));
      const resp = await fetch(nextUrl, {
        headers: { Authorization: `Token ${this.token}` },
      });
      if (!resp.ok) break;
      const data = (await resp.json()) as CLPaginatedResponse<T>;
      all.push(...data.results);
      nextUrl = data.next;
      page++;
    }
    return all;
  }

  async getJudges(params: Record<string, string> = {}) {
    return this.fetchAllPages<CLJudge>('/people/', params);
  }

  async getFinancialDisclosures(params: Record<string, string> = {}) {
    return this.fetchAllPages<CLFinancialDisclosure>('/financial-disclosures/', params);
  }

  async getInvestments(params: Record<string, string> = {}) {
    return this.fetchAllPages<CLInvestment>('/investments/', params);
  }

  async getOpinions(params: Record<string, string> = {}) {
    return this.fetchAllPages<CLOpinion>('/opinions/', params);
  }

  async getCourts(params: Record<string, string> = {}) {
    return this.fetchAllPages<CLCourt>('/courts/', params);
  }
}

interface CLPaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface CLJudge {
  id: number;
  resource_uri: string;
  name_first: string;
  name_last: string;
  name_middle: string;
  date_dob: string;
  gender: string;
  race: string[];
  positions: CLPosition[];
  educations: CLEducation[];
  aba_ratings: CLABARating[];
}

export interface CLPosition {
  court: string;
  date_start: string;
  date_termination: string | null;
  appointer: string | null;
  how_selected: string;
  nomination_process: string;
  date_confirmation: string;
  votes_yes: number;
  votes_no: number;
}

export interface CLEducation {
  school: { name: string };
  degree_level: string;
  degree_year: number;
}

export interface CLABARating {
  rating: string;
  year_rated: number;
}

export interface CLFinancialDisclosure {
  id: number;
  person: string;
  year: number;
  investments: string[];
  has_been_extracted: boolean;
}

export interface CLInvestment {
  id: number;
  financial_disclosure: string;
  description: string;
  page_number: number;
  gross_value_code: string;
  income_during_reporting_period_code: string;
}

export interface CLOpinion {
  id: number;
  resource_uri: string;
  cluster: string;
  author: string;
  type: string;
  date_created: string;
  plain_text: string;
  html: string;
}

export interface CLCourt {
  id: string;
  full_name: string;
  short_name: string;
  jurisdiction: string;
  date_modified: string;
}
```

**Step 2: Commit**

```bash
git add scripts/pipeline/clients/courtlistener.ts
git commit -m "feat: add CourtListener API client for judicial data"
```

---

### Task 2.6: Prediction Market Clients (Polymarket + Kalshi)

**Files:**
- Create: `scripts/pipeline/clients/polymarket.ts`
- Create: `scripts/pipeline/clients/kalshi.ts`

**Step 1: Write the Polymarket client**

`scripts/pipeline/clients/polymarket.ts`:
```typescript
const POLYMARKET_BASE_URL = 'https://clob.polymarket.com';
const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';

export class PolymarketClient {
  async getMarkets(params: { next_cursor?: string; limit?: number } = {}): Promise<PolymarketMarketsResponse> {
    const url = new URL(`${GAMMA_BASE_URL}/markets`);
    if (params.next_cursor) url.searchParams.set('next_cursor', params.next_cursor);
    url.searchParams.set('limit', String(params.limit || 100));
    url.searchParams.set('active', 'true');
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`Polymarket ${resp.status}`);
    return resp.json() as Promise<PolymarketMarketsResponse>;
  }

  async getMarketBySlug(slug: string): Promise<PolymarketMarket> {
    const resp = await fetch(`${GAMMA_BASE_URL}/markets?slug=${slug}`);
    if (!resp.ok) throw new Error(`Polymarket ${resp.status}`);
    const data = await resp.json() as PolymarketMarket[];
    if (!data.length) throw new Error(`Market not found: ${slug}`);
    return data[0];
  }

  async getElectionMarkets(): Promise<PolymarketMarket[]> {
    const all: PolymarketMarket[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const resp = await this.getMarkets({ next_cursor: cursor });
      const political = resp.data?.filter((m: PolymarketMarket) =>
        m.category === 'Politics' || m.tags?.includes('elections')
      ) || [];
      all.push(...political);
      if (!resp.next_cursor) break;
      cursor = resp.next_cursor;
      await new Promise(r => setTimeout(r, 200));
    }
    return all;
  }
}

export interface PolymarketMarket {
  id: string;
  question: string;
  slug: string;
  category: string;
  tags?: string[];
  outcomes: string[];
  outcomePrices: string[];
  volume: string;
  liquidity: string;
  startDate: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  resolved: boolean;
  resolutionSource: string;
}

interface PolymarketMarketsResponse {
  data: PolymarketMarket[];
  next_cursor?: string;
}
```

**Step 2: Write the Kalshi client**

`scripts/pipeline/clients/kalshi.ts`:
```typescript
const KALSHI_BASE_URL = 'https://trading-api.kalshi.com/trade-api/v2';

export class KalshiClient {
  async fetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    await new Promise(r => setTimeout(r, 200));
    const url = new URL(`${KALSHI_BASE_URL}${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`Kalshi ${resp.status}: ${endpoint}`);
    return resp.json() as Promise<T>;
  }

  async getEvents(params: Record<string, string> = {}): Promise<KalshiEvent[]> {
    const data = await this.fetch<{ events: KalshiEvent[] }>('/events', params);
    return data.events;
  }

  async getMarkets(eventTicker: string): Promise<KalshiMarket[]> {
    const data = await this.fetch<{ markets: KalshiMarket[] }>(
      '/markets', { event_ticker: eventTicker }
    );
    return data.markets;
  }

  async getMarketHistory(ticker: string): Promise<KalshiSnapshot[]> {
    const data = await this.fetch<{ history: KalshiSnapshot[] }>(
      `/markets/${ticker}/history`, { limit: '1000' }
    );
    return data.history;
  }

  async getPoliticalEvents(): Promise<KalshiEvent[]> {
    return this.getEvents({ category: 'Politics' });
  }
}

export interface KalshiEvent {
  event_ticker: string;
  title: string;
  category: string;
  sub_title: string;
  markets: { ticker: string; outcome: string; yes_price: number; volume: number }[];
}

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  outcome: string;
  yes_price: number;
  no_price: number;
  volume: number;
  open_time: string;
  close_time: string;
  status: string;
  result: string;
}

export interface KalshiSnapshot {
  ts: number;
  yes_price: number;
  volume: number;
}
```

**Step 3: Commit**

```bash
git add scripts/pipeline/clients/polymarket.ts scripts/pipeline/clients/kalshi.ts
git commit -m "feat: add Polymarket and Kalshi prediction market API clients"
```

---

### Task 2.7: Additional API Clients (ProPublica, Federal Register, USAspending)

**Files:**
- Create: `scripts/pipeline/clients/propublica.ts`
- Create: `scripts/pipeline/clients/federal-register.ts`
- Create: `scripts/pipeline/clients/usaspending.ts`

**Step 1: Write ProPublica client**

`scripts/pipeline/clients/propublica.ts`:
```typescript
const PP_CONGRESS_URL = 'https://api.propublica.org/congress/v1';
const PP_NONPROFIT_URL = 'https://projects.propublica.org/nonprofits/api/v2';

export class ProPublicaCongressClient {
  private apiKey: string;
  constructor(apiKey: string) { this.apiKey = apiKey; }

  async fetch<T>(endpoint: string): Promise<T> {
    await new Promise(r => setTimeout(r, 200));
    const resp = await fetch(`${PP_CONGRESS_URL}${endpoint}`, {
      headers: { 'X-API-Key': this.apiKey },
    });
    if (!resp.ok) throw new Error(`ProPublica ${resp.status}: ${endpoint}`);
    const data = await resp.json() as { results: T[] };
    return data.results[0] as T;
  }

  async getMembers(congress: number, chamber: 'senate' | 'house') {
    return this.fetch<{ members: PPMember[] }>(`/${congress}/${chamber}/members.json`);
  }

  async getMemberVotes(memberId: string) {
    return this.fetch<{ votes: PPVote[] }>(`/members/${memberId}/votes.json`);
  }

  async getRecentBills(congress: number, chamber: string, type: string) {
    return this.fetch<{ bills: PPBill[] }>(`/${congress}/${chamber}/bills/${type}.json`);
  }
}

export class ProPublicaNonprofitClient {
  async search(query: string): Promise<PPNonprofit[]> {
    await new Promise(r => setTimeout(r, 100));
    const resp = await fetch(`${PP_NONPROFIT_URL}/search.json?q=${encodeURIComponent(query)}`);
    if (!resp.ok) throw new Error(`PP Nonprofit ${resp.status}`);
    const data = await resp.json() as { organizations: PPNonprofit[] };
    return data.organizations;
  }

  async getOrganization(ein: string): Promise<PPNonprofitDetail> {
    const resp = await fetch(`${PP_NONPROFIT_URL}/organizations/${ein}.json`);
    if (!resp.ok) throw new Error(`PP Nonprofit ${resp.status}: ${ein}`);
    return resp.json() as Promise<PPNonprofitDetail>;
  }
}

export interface PPMember {
  id: string;
  first_name: string;
  last_name: string;
  party: string;
  state: string;
  district: string;
  votes_with_party_pct: number;
  missed_votes_pct: number;
  total_votes: number;
}

export interface PPVote {
  bill: { bill_id: string; title: string };
  position: string;
  date: string;
  result: string;
}

export interface PPBill {
  bill_id: string;
  title: string;
  sponsor_id: string;
  cosponsors: number;
  latest_major_action: string;
  latest_major_action_date: string;
}

export interface PPNonprofit {
  ein: string;
  name: string;
  city: string;
  state: string;
  ntee_code: string;
  income_amount: number;
  revenue_amount: number;
}

export interface PPNonprofitDetail extends PPNonprofit {
  filings_with_data: PPFiling[];
}

export interface PPFiling {
  tax_prd_yr: number;
  totrevenue: number;
  totfuncexpns: number;
  totassetsend: number;
  pdf_url: string;
}
```

**Step 2: Write Federal Register client**

`scripts/pipeline/clients/federal-register.ts`:
```typescript
const FR_BASE_URL = 'https://www.federalregister.gov/api/v1';

export class FederalRegisterClient {
  async fetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    await new Promise(r => setTimeout(r, 100));
    const url = new URL(`${FR_BASE_URL}${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`FedReg ${resp.status}: ${endpoint}`);
    return resp.json() as Promise<T>;
  }

  async getDocuments(params: Record<string, string> = {}): Promise<FRDocument[]> {
    const data = await this.fetch<{ results: FRDocument[] }>('/documents.json', {
      per_page: '100',
      order: 'newest',
      ...params,
    });
    return data.results;
  }

  async getExecutiveOrders(president?: string): Promise<FRDocument[]> {
    const params: Record<string, string> = {
      'conditions[type][]': 'PRESDOCU',
      'conditions[presidential_document_type][]': 'executive_order',
      per_page: '100',
    };
    if (president) params['conditions[president]'] = president;
    return this.getDocuments(params);
  }

  async getRecentRules(daysBack: number = 7): Promise<FRDocument[]> {
    const since = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
    return this.getDocuments({
      'conditions[type][]': 'RULE',
      'conditions[publication_date][gte]': since,
    });
  }
}

export interface FRDocument {
  document_number: string;
  title: string;
  type: string;
  abstract: string;
  publication_date: string;
  agencies: { raw_name: string; id: number }[];
  docket_ids: string[];
  cfr_references: { title: number; part: number }[];
  html_url: string;
  pdf_url: string;
  effective_on: string;
  presidential_document_type?: string;
  executive_order_number?: number;
  signing_date?: string;
  significant: boolean;
}
```

**Step 3: Write USAspending client**

`scripts/pipeline/clients/usaspending.ts`:
```typescript
const USA_BASE_URL = 'https://api.usaspending.gov/api/v2';

export class USAspendingClient {
  async post<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
    await new Promise(r => setTimeout(r, 200));
    const resp = await fetch(`${USA_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`USAspending ${resp.status}: ${endpoint}`);
    return resp.json() as Promise<T>;
  }

  async getSpendingByDistrict(state: string, district: string, fiscalYear: number) {
    return this.post<USASpendingGeoResponse>('/search/spending_by_geography/', {
      scope: 'place_of_performance',
      geo_layer: 'district',
      geo_layer_filters: [`${state}-${district}`],
      filters: {
        time_period: [{ start_date: `${fiscalYear}-10-01`, end_date: `${fiscalYear + 1}-09-30` }],
      },
    });
  }

  async getTopContractors(state: string, fiscalYear: number, limit: number = 20) {
    return this.post<USASpendingCategoryResponse>('/search/spending_by_category/recipient/', {
      filters: {
        time_period: [{ start_date: `${fiscalYear}-10-01`, end_date: `${fiscalYear + 1}-09-30` }],
        place_of_performance_locations: [{ country: 'USA', state }],
      },
      limit,
      page: 1,
    });
  }

  async searchAwards(keyword: string, limit: number = 25) {
    return this.post<USASpendingAwardResponse>('/search/spending_by_award/', {
      filters: { keywords: [keyword] },
      fields: [
        'Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency',
        'Award Type', 'Start Date', 'End Date', 'Description',
      ],
      limit,
      page: 1,
      sort: 'Award Amount',
      order: 'desc',
    });
  }
}

export interface USASpendingGeoResponse {
  results: { display_name: string; aggregated_amount: number; per_capita: number }[];
}

export interface USASpendingCategoryResponse {
  results: { name: string; amount: number; id: string }[];
  category: string;
}

export interface USASpendingAwardResponse {
  results: Record<string, unknown>[];
  page_metadata: { page: number; hasNext: boolean; total: number };
}
```

**Step 4: Commit**

```bash
git add scripts/pipeline/clients/propublica.ts scripts/pipeline/clients/federal-register.ts scripts/pipeline/clients/usaspending.ts
git commit -m "feat: add ProPublica, Federal Register, and USAspending API clients"
```

---

### Task 2.8: Pipeline Runner & .env Update

**Files:**
- Create: `scripts/pipeline/run.ts`
- Modify: `.env.example`

**Step 1: Create pipeline runner**

`scripts/pipeline/run.ts`:
```typescript
import { BasePipeline } from './base.js';
import type { PipelineResult } from '../../src/lib/types/api-clients.js';

// Pipeline registry — import and register pipelines as they're built
const PIPELINES: Record<string, () => BasePipeline> = {
  // Phase 3+: pipelines registered here as they're built
  // 'fec-committees': () => new FECCommitteesPipeline(),
  // 'fec-contributions': () => new FECContributionsPipeline(),
  // 'congress-members': () => new CongressMembersPipeline(),
  // 'congress-bills': () => new CongressBillsPipeline(),
  // 'lobbying': () => new LobbyingPipeline(),
  // 'courtlistener-judges': () => new CourtListenerJudgesPipeline(),
  // 'prediction-markets': () => new PredictionMarketsPipeline(),
};

async function main() {
  const args = process.argv.slice(2);
  const pipelineName = args[0];

  if (pipelineName === '--list') {
    console.log('Available pipelines:', Object.keys(PIPELINES).join(', '));
    return;
  }

  if (pipelineName === '--all') {
    const results: PipelineResult[] = [];
    for (const [name, factory] of Object.entries(PIPELINES)) {
      console.log(`\n${'='.repeat(60)}\nRunning: ${name}\n${'='.repeat(60)}`);
      const pipeline = factory();
      results.push(await pipeline.execute());
    }
    console.log('\n\nSummary:');
    for (const r of results) {
      const status = r.errors.length ? 'ERRORS' : 'OK';
      console.log(`  ${r.source}: ${status} (${r.records_inserted} inserted, ${r.records_updated} updated, ${r.errors.length} errors, ${r.duration_ms}ms)`);
    }
    return;
  }

  if (!pipelineName || !PIPELINES[pipelineName]) {
    console.error(`Usage: npx tsx scripts/pipeline/run.ts <pipeline-name|--all|--list>`);
    console.error(`Available: ${Object.keys(PIPELINES).join(', ')}`);
    process.exit(1);
  }

  const pipeline = PIPELINES[pipelineName]();
  await pipeline.execute();
}

main().catch(console.error);
```

**Step 2: Update .env.example**

Add to `.env.example`:
```
# Prediction Markets
POLYMARKET_API_URL=https://gamma-api.polymarket.com
KALSHI_API_URL=https://trading-api.kalshi.com/trade-api/v2

# Judicial
COURTLISTENER_API_TOKEN=

# Additional API Keys
OPENSECRETS_API_KEY=
QUIVER_QUANT_API_KEY=

# Pipeline
PIPELINE_LOG_LEVEL=info
```

**Step 3: Add tsx as dev dependency for running TypeScript scripts**

```bash
npm install -D tsx
```

**Step 4: Add pipeline scripts to package.json**

Add to `scripts`:
```json
"pipeline": "tsx scripts/pipeline/run.ts",
"pipeline:all": "tsx scripts/pipeline/run.ts --all",
"pipeline:list": "tsx scripts/pipeline/run.ts --list"
```

**Step 5: Commit**

```bash
git add scripts/pipeline/run.ts .env.example package.json package-lock.json
git commit -m "feat: add pipeline runner, env config, and tsx for TypeScript scripts"
```

---

## Phase 3: Core Data Import Pipelines

### Task 3.1: FEC Committees Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/fec-committees.ts`

Imports all PACs, Super PACs, party committees from FEC API. Creates entity records with `entity_type = 'pac' | 'super_pac' | 'hybrid_pac'`. Stores FEC committee_id in `external_ids`. Populates `entity_pacs` detail table.

Register in `run.ts` as `'fec-committees'`.

### Task 3.2: FEC Contributions Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/fec-contributions.ts`

For each committee, fetches Schedule A contributions. Creates person entities for donors (employer/occupation). Creates contribution records. Links donor → recipient via relationships table.

### Task 3.3: FEC Independent Expenditures Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/fec-independent-expenditures.ts`

Fetches Schedule E data. Creates `independent_expenditures` records. Creates `spent_for` / `spent_against` relationships.

### Task 3.4: Congress Members Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/congress-members.ts`

Fetches all current members from Congress.gov API. Updates `officials` table. Creates entity records linked via bioguide_id. Fetches committee assignments and creates `sits_on` relationships.

### Task 3.5: Congress Bills Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/congress-bills.ts`

Fetches recent bills. Populates `bills`, `bill_actions`, `bill_cosponsors` tables. Creates `sponsored` / `cosponsored` relationships.

### Task 3.6: Congress Votes Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/congress-votes.ts`

Fetches roll call votes. Populates `roll_call_votes` and `vote_positions`. Creates `voted_yea` / `voted_nay` relationships.

### Task 3.7: Lobbying Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/lobbying.ts`

Fetches from Senate LDA API. Creates lobbying_firm and client entities. Populates `lobbying_registrations`, `lobbying_activities`. Creates `lobbied_via`, `lobbied_on` relationships. Extracts covered positions for revolving door data.

### Task 3.8: CourtListener Judges Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/courtlistener-judges.ts`

Fetches judge data. Populates `judges`, `courts` tables. Creates entity records. Fetches financial disclosures and investments. Creates `appointed_by`, `holds_stock` relationships.

### Task 3.9: Stock Trades Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/stock-trades.ts`

Fetches from Quiver Quantitative API (or parses House/Senate disclosure PDFs). Populates `stock_trades`, `official_holdings`. Creates `traded_stock` relationships. Links to corporation entities via ticker.

### Task 3.10: Prediction Markets Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/prediction-markets.ts`

Fetches political contracts from Polymarket and Kalshi. Populates `prediction_contracts`, `prediction_snapshots`. Runs anomaly detection (volume spikes, rapid price moves) and writes to `prediction_anomalies`.

### Task 3.11: Polling Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/polling.ts`

Fetches polling data from 538/RCP (scraping or data files). Populates `polls` and `pollster_ratings` tables.

### Task 3.12: Federal Register Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/federal-register.ts`

Fetches recent rules, proposed rules, and executive orders. Links to agencies. Useful for the law/regulation index and executive order tracker.

### Task 3.13: USAspending Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/usaspending.ts`

Fetches federal contract and grant data by state/district. Populates spending records. Creates `paid_by` relationships linking agencies to contractor entities.

**Note:** Tasks 3.1-3.13 each follow the same pattern: extend `BasePipeline`, implement `getName()` and `run()`, register in `run.ts`. Each should be committed individually. Implementation details for each pipeline follow the API client patterns established in Phase 2 — fetch data, normalize to schema, upsert entities, create relationships.

---

## Phase 4: Conflict Detection Engine

### Task 4.1: Donor-Vote Conflict Detector

**Files:**
- Create: `scripts/pipeline/detectors/donor-vote.ts`

Queries: for each roll call vote, find officials who voted and whose top donors are in industries affected by the bill. Write `conflict_alerts` with `alert_type = 'donor_vote'`.

SQL pattern:
```sql
SELECT o.id, b.id, b.naics_affected, mif.naics_code, mif.total_amount, vp.position
FROM vote_positions vp
JOIN officials o ON o.id = vp.official_id
JOIN roll_call_votes rcv ON rcv.id = vp.vote_id
JOIN bills b ON b.id = rcv.bill_id
JOIN mv_official_industry_funding mif ON mif.official_id = o.id
WHERE b.naics_affected && ARRAY[mif.naics_code]
  AND mif.total_amount > 10000;
```

### Task 4.2: Stock-Committee Conflict Detector

**Files:**
- Create: `scripts/pipeline/detectors/stock-committee.ts`

Cross-references `official_holdings` with committee jurisdiction NAICS codes. Flags officials holding stock in industries their committee regulates.

### Task 4.3: Trade-Timing Conflict Detector

**Files:**
- Create: `scripts/pipeline/detectors/trade-timing.ts`

Uses `mv_stock_trade_alerts` materialized view to find trades within 30 days of related votes. Writes alerts with timeline evidence.

### Task 4.4: Judicial-Financial Conflict Detector

**Files:**
- Create: `scripts/pipeline/detectors/judicial-financial.ts`

Cross-references `judge_investments` with `case_parties` to find judges with holdings in companies appearing before them.

### Task 4.5: Prediction Market Anomaly Detector

**Files:**
- Create: `scripts/pipeline/detectors/prediction-anomaly.ts`

Analyzes `prediction_snapshots` for volume spikes and rapid price moves. Correlates timing with government actions from Federal Register, congressional votes, and executive announcements. Writes `prediction_anomalies`.

### Task 4.6: Conflict Detection Runner

**Files:**
- Create: `scripts/pipeline/detect-conflicts.ts`

Runs all detectors sequentially. Refreshes materialized views first. Designed to run as daily scheduled job after data pipelines complete.

---

## Phase 5: API Endpoints

### Task 5.1: Switch Astro to Hybrid Mode

**Files:**
- Modify: `astro.config.mjs`

Change `output: 'static'` to `output: 'hybrid'` to enable per-route SSR while keeping default static.

### Task 5.2: ZIP Lookup Endpoint

**Files:**
- Create: `src/pages/api/zip-lookup.ts`

```typescript
export const prerender = false;

import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const GET: APIRoute = async ({ url }) => {
  const zip = url.searchParams.get('zip');
  if (!zip || !/^\d{5}$/.test(zip)) {
    return new Response(JSON.stringify({ error: 'Valid 5-digit ZIP required' }), { status: 400 });
  }

  const { data: jurisdictions } = await supabase
    .from('zip_jurisdictions')
    .select(`
      *,
      state:state_id(id, name, slug),
      county:county_id(id, name, slug),
      city:city_id(id, name, slug)
    `)
    .eq('zip_code', zip);

  // Also fetch officials for these jurisdictions
  const jurisdictionIds = [
    ...new Set(
      (jurisdictions || []).flatMap(j => [j.state_id, j.county_id, j.city_id].filter(Boolean))
    ),
  ];

  const { data: officials } = await supabase
    .from('officials')
    .select('*, office:office_id(title, branch, chamber, jurisdiction_id)')
    .in('office.jurisdiction_id', jurisdictionIds)
    .eq('is_current', true);

  return new Response(JSON.stringify({ jurisdictions, officials }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
```

### Task 5.3: Money Graph Endpoint

**Files:**
- Create: `src/pages/api/money-graph.ts`

Accepts `entity_id`, `hops`, `min_amount`, `relationship_types[]`. Calls `get_entity_neighborhood` and `get_edges_between` functions. Returns nodes + edges for Cytoscape.js rendering.

### Task 5.4: Conflict Alerts Endpoint

**Files:**
- Create: `src/pages/api/conflicts.ts`

Returns paginated conflict alerts, filterable by type, severity, official, jurisdiction. Also serves RSS feed when `Accept: application/rss+xml`.

### Task 5.5: Officials Endpoint

**Files:**
- Create: `src/pages/api/officials.ts`

Returns officials by jurisdiction, with top donors and transparency scores from materialized views.

### Task 5.6: Stock Trades Endpoint

**Files:**
- Create: `src/pages/api/stock-trades.ts`

Returns congressional stock trades, filterable by official, ticker, date range, trade type.

### Task 5.7: Lobbying Endpoint

**Files:**
- Create: `src/pages/api/lobbying.ts`

Returns lobbying activity, filterable by bill, official, industry, firm.

### Task 5.8: Judicial Endpoint

**Files:**
- Create: `src/pages/api/judicial.ts`

Returns judge profiles, decisions, financial disclosures, conflict flags.

### Task 5.9: Elections & Predictions Endpoint

**Files:**
- Create: `src/pages/api/elections.ts`

Returns election data by jurisdiction with polling averages and prediction market odds.

### Task 5.10: Search Endpoint

**Files:**
- Create: `src/pages/api/search.ts`

Full-text search across entities, officials, bills, judges using `pg_trgm` and `tsvector`.

### Task 5.11: RSS Alert Feeds

**Files:**
- Create: `src/pages/api/feeds/[type].ts`

Generates RSS XML for conflict alerts, filterable by type, jurisdiction, severity.

---

## Phase 6: Frontend — Graph Visualization Components

### Task 6.1: Cytoscape.js Money Graph Component

**Files:**
- Create: `src/components/graph/MoneyGraph.tsx`

React component wrapping Cytoscape.js. Accepts nodes/edges from API. Force-directed layout with `cose-bilkent`. Node sizing by centrality. Edge thickness by amount. Click handlers for drill-down. Controls for depth, filters, layout switching.

### Task 6.2: D3 Sankey Flow Component

**Files:**
- Create: `src/components/graph/MoneyFlow.tsx`

D3 Sankey diagram for donor → PAC → candidate flows. Used on official profiles and dark money tracker.

### Task 6.3: Graph Controls Component

**Files:**
- Create: `src/components/graph/GraphControls.tsx`

Depth slider, amount threshold, date range picker, relationship type toggles, layout switcher, export button.

### Task 6.4: Entity Search Component

**Files:**
- Create: `src/components/search/EntitySearch.tsx`

Autocomplete search across all entity types. Used as entry point for money graph and universal search.

---

## Phase 7: Frontend — Page Templates

### Task 7.1: Update Header Navigation

**Files:**
- Modify: `src/components/Header.astro`

Add three-pillar navigation: Navigate, Follow the Money, Connect the Dots. Each with dropdown menus.

### Task 7.2: My Government Page (ZIP Lookup Result)

**Files:**
- Create: `src/pages/my-government.astro`

ZIP-driven page showing all officials, top donors, alerts, elections, predictions, spending.

### Task 7.3: Federal Overview Page

**Files:**
- Create: `src/pages/federal/index.astro`

Three branches with interactive org charts.

### Task 7.4: State Overview Pages

**Files:**
- Create: `src/pages/states/[slug].astro`

Dynamic state pages with officials, legislature, campaign finance.

### Task 7.5: County & City Overview Pages

**Files:**
- Create: `src/pages/counties/[slug].astro`
- Create: `src/pages/cities/[slug].astro`

### Task 7.6: Official Profile Page

**Files:**
- Create: `src/pages/officials/[slug].astro`

The enhanced official page: bio + donors + stock trades + voting record + lobbying + scorecard + mini money graph.

### Task 7.7: Money Graph Explorer Page

**Files:**
- Create: `src/pages/money-graph.astro`

Full-page interactive graph. Entry via search, pre-built views, or URL params.

### Task 7.8: Dark Money Tracker Page

**Files:**
- Create: `src/pages/dark-money.astro`

501(c)(4) directory, flow visualization, dark money index.

### Task 7.9: Lobbying Dashboard Page

**Files:**
- Create: `src/pages/lobbying.astro`

Search by bill, official, industry. Activity tables with money totals.

### Task 7.10: Congressional Stock Tracker Page

**Files:**
- Create: `src/pages/stock-tracker.astro`

Trade table, portfolio views, timing alerts, late filing tracker.

### Task 7.11: Judicial Transparency Page

**Files:**
- Create: `src/pages/judicial/index.astro`
- Create: `src/pages/judicial/judges/[slug].astro`

Court structure, judge profiles with political chains and conflict flags.

### Task 7.12: Conflict Alert Feed Page

**Files:**
- Create: `src/pages/conflicts.astro`

Reverse-chronological alert feed with filters and severity ranking.

### Task 7.13: Predictions & Markets Page

**Files:**
- Create: `src/pages/predictions.astro`

Polling aggregation, prediction market odds, anomaly detector feed.

### Task 7.14: Corporate Influence Page

**Files:**
- Create: `src/pages/corporate/[slug].astro`

Per-corporation influence score breakdown, officials funded, bills lobbied.

### Task 7.15: Agency Detail Page

**Files:**
- Create: `src/pages/agencies/[slug].astro`

Mission, budget, regulations, lobbying, revolving door, contractors.

### Task 7.16: Bill Detail Page

**Files:**
- Create: `src/pages/bills/[id].astro`

Full text link, sponsors, lobbying, donor alignment, vote breakdown.

### Task 7.17: Transparency Scorecards Page

**Files:**
- Create: `src/pages/scorecards.astro`

Ranked leaderboards by chamber, state, party. A-F grades with breakdowns.

### Task 7.18: Local Government Navigator

**Files:**
- Create: `src/pages/local-guide/index.astro`
- Create: `src/pages/local-guide/[topic].astro`

How-to guides, templates, meeting calendars.

---

## Phase 8: Scoring & Analysis

### Task 8.1: Transparency Score Calculator

**Files:**
- Create: `scripts/pipeline/scorers/transparency.ts`

Computes transparency scores for all officials based on disclosure compliance, attendance, small donor percentage, conflict count, etc.

### Task 8.2: Corporate Influence Score Calculator

**Files:**
- Create: `scripts/pipeline/scorers/corporate-influence.ts`

Computes composite influence scores from lobbying, PAC, revolving door, contracts, regulatory comments, dark money components.

### Task 8.3: Donor-Vote Alignment Calculator

**Files:**
- Create: `scripts/pipeline/scorers/donor-alignment.ts`

Correlates voting record with top donor industry positions. Uses industry group scorecards (Chamber of Commerce, AFL-CIO, LCV, NRA, etc.) as proxies for industry positions.

### Task 8.4: Gerrymandering Metrics Calculator

**Files:**
- Create: `scripts/pipeline/scorers/compactness.ts`

Computes Polsby-Popper, Reock, and Convex Hull scores from district geometries using PostGIS. Writes to `district_compactness` table.

---

## Phase 9: Community Platform & Polish

### Task 9.1: Community Submission Form

**Files:**
- Create: `src/components/community/SubmissionForm.tsx`
- Create: `src/pages/api/community/submit.ts`

Form for submitting local government data. API endpoint validates and stores in `community_submissions`.

### Task 9.2: Accessibility Audit

Ensure WCAG 2.1 AA: high-contrast mode for visualizations, screen reader alternatives for graphs (tabular data fallbacks), keyboard navigation for all interactive elements.

### Task 9.3: Mobile Responsive Layouts

Graph visualizations simplify to tables on mobile. Map goes full-width. All pages responsive.

### Task 9.4: Performance Optimization

Lazy-load Cytoscape/Sigma/D3 bundles. CDN caching headers on API responses. Image optimization. Bundle analysis.

### Task 9.5: RSS Feeds for All Alert Types

Per-type, per-jurisdiction, per-severity RSS feeds. Also JSON feed format.

---

## Execution Order & Dependencies

```
Phase 1 (Foundation) — no dependencies, start here
  ↓
Phase 2 (Pipeline Infrastructure) — depends on Phase 1 schemas
  ↓
Phase 3 (Data Import) — depends on Phase 2 clients
  ↓                        ↓
Phase 4 (Conflict Detection)  Phase 5 (API Endpoints)
  — depends on Phase 3 data    — depends on Phase 1 schemas
  ↓                        ↓
Phase 6 (Graph Visualization) — depends on Phase 5 APIs
  ↓
Phase 7 (Pages) — depends on Phases 5 + 6
  ↓
Phase 8 (Scoring) — depends on Phase 3 data
  ↓
Phase 9 (Polish) — depends on everything above
```

**Phases 4, 5, and 8 can run in parallel** once Phase 3 has populated data.
**Phase 6 can start once Phase 5 has the money-graph endpoint.**
**Phase 7 tasks are largely independent** and can be parallelized across subagents.

---

## Total Estimated Scope

- **9 phases, ~60 tasks**
- **11 database migrations** (007-017)
- **10 API clients**
- **13 data import pipelines**
- **5 conflict detectors**
- **11 SSR API endpoints**
- **4 visualization components**
- **18 page templates**
- **4 scoring calculators**
- **Community platform + accessibility + performance**
