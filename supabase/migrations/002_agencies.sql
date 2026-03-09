CREATE TYPE agency_type AS ENUM (
  'cabinet_department', 'independent_agency', 'executive_office',
  'regulatory_commission', 'government_corporation', 'quasi_official',
  'state_agency', 'county_agency', 'city_agency'
);

CREATE TABLE agencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  abbreviation TEXT,
  agency_type agency_type NOT NULL,
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id),
  parent_agency_id UUID REFERENCES agencies(id),
  description TEXT,
  website TEXT,
  established_year INTEGER,
  logo_url TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_agencies_jurisdiction ON agencies(jurisdiction_id);
CREATE INDEX idx_agencies_parent ON agencies(parent_agency_id);
CREATE INDEX idx_agencies_slug ON agencies(slug);
CREATE INDEX idx_agencies_type ON agencies(agency_type);
