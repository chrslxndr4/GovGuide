CREATE TABLE zip_jurisdictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zip_code CHAR(5) NOT NULL,
  state_id UUID REFERENCES jurisdictions(id),
  county_id UUID REFERENCES jurisdictions(id),
  city_id UUID REFERENCES jurisdictions(id),
  congressional_district TEXT,
  state_legislative_upper TEXT,
  state_legislative_lower TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_zip_jurisdictions_zip ON zip_jurisdictions(zip_code);
CREATE INDEX idx_zip_jurisdictions_state ON zip_jurisdictions(state_id);
CREATE INDEX idx_zip_jurisdictions_county ON zip_jurisdictions(county_id);
