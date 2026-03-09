CREATE TYPE election_type AS ENUM ('general', 'primary', 'runoff', 'special', 'recall', 'referendum');

CREATE TABLE elections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  election_type election_type NOT NULL,
  election_date DATE NOT NULL,
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id),
  registration_deadline DATE,
  early_voting_start DATE,
  early_voting_end DATE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id UUID NOT NULL REFERENCES elections(id),
  office_id UUID NOT NULL REFERENCES offices(id),
  official_id UUID REFERENCES officials(id),
  name TEXT NOT NULL,
  party party,
  is_incumbent BOOLEAN DEFAULT false,
  website TEXT,
  fec_id TEXT,
  votes_received INTEGER,
  vote_percentage NUMERIC(5,2),
  won BOOLEAN,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE ballot_measures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id UUID NOT NULL REFERENCES elections(id),
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id),
  title TEXT NOT NULL,
  description TEXT,
  measure_type TEXT,
  result TEXT,
  yes_votes INTEGER,
  no_votes INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE election_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id),
  registration_url TEXT,
  registration_status_url TEXT,
  ballot_tracking_url TEXT,
  election_office_name TEXT,
  election_office_phone TEXT,
  election_office_email TEXT,
  election_office_address TEXT,
  has_online_registration BOOLEAN DEFAULT false,
  has_ballot_tracking BOOLEAN DEFAULT false,
  requirements TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(jurisdiction_id)
);

CREATE INDEX idx_elections_jurisdiction ON elections(jurisdiction_id);
CREATE INDEX idx_elections_date ON elections(election_date);
CREATE INDEX idx_candidates_election ON candidates(election_id);
CREATE INDEX idx_ballot_measures_election ON ballot_measures(election_id);
CREATE INDEX idx_election_services_jurisdiction ON election_services(jurisdiction_id);
