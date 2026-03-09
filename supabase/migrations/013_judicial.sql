-- Federal and state courts
CREATE TABLE courts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  court_type TEXT NOT NULL, -- 'supreme', 'appellate', 'district', 'bankruptcy', 'specialized'
  jurisdiction_id UUID REFERENCES jurisdictions(id),
  circuit_number INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_courts_type ON courts(court_type);
CREATE INDEX idx_courts_jurisdiction ON courts(jurisdiction_id);

-- Federal judges
CREATE TABLE judges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID REFERENCES entities(id),
  court_id UUID REFERENCES courts(id),
  appointing_president_id UUID REFERENCES officials(id),
  full_name TEXT NOT NULL,
  slug TEXT NOT NULL,
  confirmation_date DATE,
  confirmation_vote TEXT,
  aba_rating TEXT,
  senior_status_date DATE,
  termination_date DATE,
  termination_reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX idx_judges_slug ON judges(slug);
CREATE INDEX idx_judges_court ON judges(court_id);
CREATE INDEX idx_judges_entity ON judges(entity_id);
CREATE INDEX idx_judges_active ON judges(termination_date) WHERE termination_date IS NULL;

-- Judge financial disclosures
CREATE TABLE judge_financial_disclosures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  judge_id UUID REFERENCES judges(id),
  year INTEGER NOT NULL,
  filing_url TEXT,
  parsed_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_judge_fd_judge ON judge_financial_disclosures(judge_id);

-- Judge investment positions (parsed from disclosures)
CREATE TABLE judge_investments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  disclosure_id UUID REFERENCES judge_financial_disclosures(id),
  judge_id UUID REFERENCES judges(id),
  asset_name TEXT NOT NULL,
  ticker TEXT,
  value_range_low NUMERIC,
  value_range_high NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_judge_inv_judge ON judge_investments(judge_id);
CREATE INDEX idx_judge_inv_ticker ON judge_investments(ticker) WHERE ticker IS NOT NULL;

-- Judicial decisions / opinions
CREATE TABLE judicial_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  court_id UUID REFERENCES courts(id),
  case_date DATE,
  title TEXT NOT NULL,
  citation TEXT,
  issue_codes TEXT[] DEFAULT '{}',
  disposition TEXT,
  opinion_url TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_jd_court ON judicial_decisions(court_id);
CREATE INDEX idx_jd_date ON judicial_decisions(case_date);

-- Judge-case assignments
CREATE TABLE case_judges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID REFERENCES judicial_decisions(id),
  judge_id UUID REFERENCES judges(id),
  role TEXT NOT NULL DEFAULT 'author' -- 'author', 'concur', 'dissent'
);

CREATE INDEX idx_cj_case ON case_judges(case_id);
CREATE INDEX idx_cj_judge ON case_judges(judge_id);

-- Case parties (for conflict detection)
CREATE TABLE case_parties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID REFERENCES judicial_decisions(id),
  party_entity_id UUID REFERENCES entities(id),
  party_role TEXT -- 'plaintiff', 'defendant', 'appellant', 'appellee', 'amicus'
);

CREATE INDEX idx_cp_case ON case_parties(case_id);
CREATE INDEX idx_cp_entity ON case_parties(party_entity_id);

-- Sentencing records (USSC data)
CREATE TABLE sentencing_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  judge_id UUID REFERENCES judges(id),
  offense_type TEXT,
  guideline_min NUMERIC,
  guideline_max NUMERIC,
  actual_sentence NUMERIC,
  departure_reason TEXT,
  defendant_demographics JSONB DEFAULT '{}',
  sentencing_date DATE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_sent_judge ON sentencing_records(judge_id);
CREATE INDEX idx_sent_offense ON sentencing_records(offense_type);
