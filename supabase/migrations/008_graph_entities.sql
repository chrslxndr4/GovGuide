-- Enable trigram extension for fuzzy text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE entity_type AS ENUM (
  'individual', 'officeholder', 'judge', 'lobbyist',
  'corporation', 'pac', '501c4', '527_org', 'lobbying_firm',
  'trade_association', 'foreign_principal',
  'jurisdiction', 'office', 'agency', 'committee', 'court'
);

CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type entity_type NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT[] DEFAULT '{}',
  external_ids JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_entities_type ON entities(entity_type);
CREATE INDEX idx_entities_name_trgm ON entities USING gin(name gin_trgm_ops);
CREATE INDEX idx_entities_external_ids ON entities USING gin(external_ids jsonb_path_ops);
CREATE INDEX idx_entities_name_lower ON entities(lower(name));

-- Corporation details
CREATE TABLE entity_corporations (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  ticker TEXT,
  naics_code TEXT,
  sector TEXT,
  market_cap NUMERIC,
  parent_corp_id UUID REFERENCES entities(id)
);

CREATE INDEX idx_entity_corp_ticker ON entity_corporations(ticker);
CREATE INDEX idx_entity_corp_sector ON entity_corporations(sector);

-- PAC details
CREATE TABLE entity_pacs (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  fec_committee_id TEXT UNIQUE,
  pac_type TEXT,
  sponsor_entity_id UUID REFERENCES entities(id)
);

CREATE INDEX idx_entity_pac_fec ON entity_pacs(fec_committee_id);

-- 501(c)(4) dark money orgs
CREATE TABLE entity_501c4s (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  ein TEXT UNIQUE,
  irs_category TEXT,
  total_revenue NUMERIC,
  total_grants_made NUMERIC
);

-- Lobbying firms
CREATE TABLE entity_lobbying_firms (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  lda_registrant_id TEXT UNIQUE,
  client_count INTEGER DEFAULT 0
);

-- Foreign principals (FARA)
CREATE TABLE entity_foreign_principals (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  country TEXT NOT NULL,
  principal_type TEXT
);

CREATE INDEX idx_entity_foreign_country ON entity_foreign_principals(country);
