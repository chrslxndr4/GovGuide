CREATE TYPE branch AS ENUM ('executive', 'legislative', 'judicial');
CREATE TYPE chamber AS ENUM ('senate', 'house', 'upper', 'lower', 'unicameral');
CREATE TYPE party AS ENUM ('democratic', 'republican', 'independent', 'libertarian', 'green', 'other');

CREATE TABLE offices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  branch branch NOT NULL,
  chamber chamber,
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id),
  district TEXT,
  is_elected BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE officials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  slug TEXT NOT NULL,
  office_id UUID NOT NULL REFERENCES offices(id),
  party party,
  photo_url TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  social_media JSONB DEFAULT '{}',
  term_start DATE,
  term_end DATE,
  is_current BOOLEAN DEFAULT true,
  bioguide_id TEXT,
  fec_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_offices_jurisdiction ON offices(jurisdiction_id);
CREATE INDEX idx_offices_branch ON offices(branch);
CREATE INDEX idx_officials_office ON officials(office_id);
CREATE INDEX idx_officials_current ON officials(is_current);
CREATE INDEX idx_officials_slug ON officials(slug);
CREATE INDEX idx_officials_party ON officials(party);
