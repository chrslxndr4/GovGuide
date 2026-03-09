-- Bills and resolutions
CREATE TABLE bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_number TEXT NOT NULL,
  congress INTEGER,
  session INTEGER,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT,
  subjects TEXT[] DEFAULT '{}',
  naics_affected TEXT[] DEFAULT '{}',
  policy_area TEXT,
  text_url TEXT,
  introduced_date DATE,
  last_action_date DATE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX idx_bills_number_congress ON bills(bill_number, congress);
CREATE INDEX idx_bills_status ON bills(status);
CREATE INDEX idx_bills_subjects ON bills USING gin(subjects);
CREATE INDEX idx_bills_introduced ON bills(introduced_date);
CREATE INDEX idx_bills_title_trgm ON bills USING gin(title gin_trgm_ops);

-- Bill action history
CREATE TABLE bill_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id UUID REFERENCES bills(id) ON DELETE CASCADE,
  action_date DATE,
  action_text TEXT,
  action_type TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_bill_actions_bill ON bill_actions(bill_id);
CREATE INDEX idx_bill_actions_date ON bill_actions(action_date);

-- Bill sponsors and cosponsors
CREATE TABLE bill_sponsors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id UUID REFERENCES bills(id) ON DELETE CASCADE,
  official_id UUID REFERENCES officials(id),
  sponsor_type TEXT CHECK (sponsor_type IN ('sponsor', 'cosponsor')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_bill_sponsors_bill ON bill_sponsors(bill_id);
CREATE INDEX idx_bill_sponsors_official ON bill_sponsors(official_id);

-- Roll call votes
CREATE TABLE roll_call_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id UUID REFERENCES bills(id),
  chamber chamber,
  vote_date DATE,
  result TEXT,
  vote_number INTEGER,
  congress INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_rcv_bill ON roll_call_votes(bill_id);
CREATE INDEX idx_rcv_date ON roll_call_votes(vote_date);
CREATE INDEX idx_rcv_chamber ON roll_call_votes(chamber);

-- Individual member vote positions
CREATE TABLE vote_positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vote_id UUID REFERENCES roll_call_votes(id) ON DELETE CASCADE,
  official_id UUID REFERENCES officials(id),
  position TEXT CHECK (position IN ('yea', 'nay', 'present', 'absent')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_vp_vote ON vote_positions(vote_id);
CREATE INDEX idx_vp_official ON vote_positions(official_id);
CREATE INDEX idx_vp_position ON vote_positions(position);
