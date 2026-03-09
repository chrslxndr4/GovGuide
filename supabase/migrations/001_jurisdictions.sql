CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TYPE jurisdiction_level AS ENUM ('federal', 'state', 'county', 'city');

CREATE TABLE jurisdictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  level jurisdiction_level NOT NULL,
  fips_code TEXT,
  state_abbr CHAR(2),
  parent_id UUID REFERENCES jurisdictions(id),
  population INTEGER,
  website TEXT,
  geometry GEOMETRY(MultiPolygon, 4326),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_jurisdictions_level ON jurisdictions(level);
CREATE INDEX idx_jurisdictions_parent ON jurisdictions(parent_id);
CREATE INDEX idx_jurisdictions_slug ON jurisdictions(slug);
CREATE INDEX idx_jurisdictions_fips ON jurisdictions(fips_code);
CREATE INDEX idx_jurisdictions_state ON jurisdictions(state_abbr);
CREATE INDEX idx_jurisdictions_geometry ON jurisdictions USING GIST(geometry);

INSERT INTO jurisdictions (name, slug, level, fips_code)
VALUES ('United States of America', 'usa', 'federal', 'US');
