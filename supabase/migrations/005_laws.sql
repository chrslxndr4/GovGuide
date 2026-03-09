CREATE TYPE law_type AS ENUM (
  'constitution', 'statute', 'regulation', 'executive_order',
  'ordinance', 'administrative_code', 'municipal_code'
);

CREATE TABLE law_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id),
  law_type law_type NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  source_url TEXT,
  api_url TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_law_sources_jurisdiction ON law_sources(jurisdiction_id);
CREATE INDEX idx_law_sources_type ON law_sources(law_type);
