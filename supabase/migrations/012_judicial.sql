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
  circuit_number INTEGER,
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
  confirmation_vote TEXT,
  commission_date DATE,
  aba_rating TEXT,
  senior_status_date DATE,
  termination_date DATE,
  termination_reason TEXT,
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
  asset_type TEXT,
  value_range_low NUMERIC(15,2),
  value_range_high NUMERIC(15,2),
  income_type TEXT,
  income_range_low NUMERIC(12,2),
  income_range_high NUMERIC(12,2),
  entity_id UUID REFERENCES entities(id),
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
  disposition TEXT,
  opinion_type TEXT,
  opinion_url TEXT,
  courtlistener_id INTEGER,
  scotus_vote_majority INTEGER,
  scotus_vote_minority INTEGER,
  scotus_direction TEXT,
  scotus_issue_area TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE case_judges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL REFERENCES judicial_decisions(id) ON DELETE CASCADE,
  judge_id UUID NOT NULL REFERENCES judges(id),
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(decision_id, judge_id)
);

CREATE TABLE case_parties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL REFERENCES judicial_decisions(id) ON DELETE CASCADE,
  entity_id UUID REFERENCES entities(id),
  party_name TEXT NOT NULL,
  party_role TEXT NOT NULL,
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
  departure_direction TEXT,
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
