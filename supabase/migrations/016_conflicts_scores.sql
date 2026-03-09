-- Automated conflict of interest alerts
CREATE TYPE conflict_type AS ENUM (
  'donor_vote',         -- voted on bill affecting major donor's industry
  'stock_committee',    -- holds stock in company regulated by their committee
  'trade_timing',       -- stock trade within N days of related vote
  'judicial_financial', -- judge holds stock in case party
  'contract_donor',     -- federal contract to company that donated to relevant legislator
  'revolving_door',     -- official left agency, now lobbies it within cooling-off period
  'dark_money_chain',   -- traceable 501c4 grant chain to super PAC expenditure
  'prediction_insider'  -- large prediction market position before government action
);

CREATE TYPE alert_status AS ENUM ('active', 'reviewed', 'dismissed');

CREATE TABLE conflict_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_type conflict_type NOT NULL,
  severity_score NUMERIC(3,1) NOT NULL, -- 0.0 to 10.0
  entity_ids UUID[] NOT NULL,
  description TEXT NOT NULL,
  evidence JSONB DEFAULT '{}',
  detected_at TIMESTAMPTZ DEFAULT now(),
  status alert_status DEFAULT 'active',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_conflicts_type ON conflict_alerts(alert_type);
CREATE INDEX idx_conflicts_severity ON conflict_alerts(severity_score);
CREATE INDEX idx_conflicts_status ON conflict_alerts(status);
CREATE INDEX idx_conflicts_detected ON conflict_alerts(detected_at);
CREATE INDEX idx_conflicts_entities ON conflict_alerts USING gin(entity_ids);

-- Official transparency scorecards
CREATE TABLE transparency_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  official_id UUID REFERENCES officials(id),
  score_date DATE NOT NULL,
  overall_score NUMERIC(4,1) NOT NULL, -- 0-100
  grade CHAR(2), -- A+, A, A-, B+, ... F
  component_scores JSONB DEFAULT '{}',
  -- Components: disclosure_completeness, stock_act_compliance, town_halls,
  -- conflicts_count, transparency_cosponsorship, small_donor_pct,
  -- voting_attendance, press_accessibility
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_tscore_official ON transparency_scores(official_id);
CREATE INDEX idx_tscore_date ON transparency_scores(score_date);
CREATE INDEX idx_tscore_grade ON transparency_scores(grade);

-- Corporate influence scores
CREATE TABLE corporate_influence_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID REFERENCES entities(id),
  score_date DATE NOT NULL,
  overall_score NUMERIC(4,1) NOT NULL, -- 0-100
  component_scores JSONB DEFAULT '{}',
  -- Components: lobbying_spend (25%), pac_contributions (20%),
  -- revolving_door (15%), dark_money (15%), gov_contracts (10%),
  -- reg_comments (10%), trade_associations (5%)
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_ciscore_entity ON corporate_influence_scores(entity_id);
CREATE INDEX idx_ciscore_date ON corporate_influence_scores(score_date);
CREATE INDEX idx_ciscore_score ON corporate_influence_scores(overall_score);

-- Community data submissions
CREATE TABLE community_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  submitter_name TEXT,
  submitter_org TEXT,
  submission_type TEXT NOT NULL,
  jurisdiction_id UUID REFERENCES jurisdictions(id),
  data JSONB NOT NULL,
  source_url TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected')),
  verified_by TEXT,
  verified_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_community_status ON community_submissions(status);
CREATE INDEX idx_community_jurisdiction ON community_submissions(jurisdiction_id);
CREATE INDEX idx_community_type ON community_submissions(submission_type);

-- District geometries for gerrymandering analysis
CREATE TABLE district_geometries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id TEXT NOT NULL,
  district_type TEXT NOT NULL, -- 'congressional', 'state_senate', 'state_house'
  geometry GEOMETRY(MultiPolygon, 4326),
  vintage_year INTEGER NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_distgeo_type ON district_geometries(district_type);
CREATE INDEX idx_distgeo_year ON district_geometries(vintage_year);
CREATE INDEX idx_distgeo_geom ON district_geometries USING GIST(geometry);

-- Compactness scores for gerrymandering detection
CREATE TABLE compactness_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  district_id TEXT NOT NULL,
  polsby_popper NUMERIC(5,4),
  reock NUMERIC(5,4),
  convex_hull NUMERIC(5,4),
  efficiency_gap NUMERIC(5,4),
  mean_median_difference NUMERIC(5,4),
  vintage_year INTEGER NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_compact_district ON compactness_scores(district_id);
CREATE INDEX idx_compact_year ON compactness_scores(vintage_year);
