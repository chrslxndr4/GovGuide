CREATE TYPE conflict_type AS ENUM (
  'donor_vote', 'stock_committee', 'trade_timing',
  'judicial_financial', 'contract_donor', 'revolving_door',
  'prediction_insider', 'dark_money_chain'
);

CREATE TABLE conflict_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type conflict_type NOT NULL,
  severity_score NUMERIC(3,1) NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  entity_ids UUID[] NOT NULL,
  official_id UUID REFERENCES officials(id),
  judge_id UUID REFERENCES judges(id),
  bill_id UUID REFERENCES bills(id),
  evidence JSONB NOT NULL,
  detected_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'reviewed', 'dismissed')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE transparency_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  official_id UUID NOT NULL REFERENCES officials(id),
  score_date DATE NOT NULL,
  overall_score NUMERIC(4,1) NOT NULL,
  grade CHAR(2) NOT NULL,
  component_scores JSONB NOT NULL,
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
  industry_rank INTEGER,
  overall_rank INTEGER,
  methodology_version TEXT DEFAULT 'v1',
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(entity_id, score_date)
);

CREATE TABLE community_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submitter_name TEXT,
  submitter_email TEXT,
  submitter_org TEXT,
  submission_type TEXT NOT NULL,
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

CREATE TABLE district_compactness (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id),
  district_type TEXT NOT NULL,
  district_number TEXT,
  vintage_year INTEGER NOT NULL,
  polsby_popper NUMERIC(5,4),
  reock NUMERIC(5,4),
  convex_hull NUMERIC(5,4),
  efficiency_gap NUMERIC(5,4),
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
