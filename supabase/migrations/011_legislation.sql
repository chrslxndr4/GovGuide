CREATE TABLE bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id TEXT NOT NULL UNIQUE,
  congress INTEGER NOT NULL,
  bill_type TEXT NOT NULL,
  bill_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  short_title TEXT,
  summary TEXT,
  status TEXT,
  policy_area TEXT,
  subjects TEXT[],
  naics_affected TEXT[],
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
  action_type TEXT,
  chamber TEXT,
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
  vote_id TEXT NOT NULL UNIQUE,
  bill_id UUID REFERENCES bills(id),
  chamber TEXT NOT NULL,
  congress INTEGER NOT NULL,
  session INTEGER NOT NULL,
  roll_call_number INTEGER NOT NULL,
  vote_date DATE NOT NULL,
  question TEXT,
  result TEXT,
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
