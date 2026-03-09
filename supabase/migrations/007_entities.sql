-- Entity types for the relationship graph
CREATE TYPE entity_type AS ENUM (
  'person', 'corporation', 'pac', 'super_pac', 'hybrid_pac',
  '501c4', '501c3', '527_org', 'lobbying_firm', 'trade_association',
  'foreign_principal', 'labor_union', 'political_party'
);

-- Universal entity table (all nodes in the graph)
CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type entity_type NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT[] DEFAULT '{}',
  external_ids JSONB DEFAULT '{}',
  description TEXT,
  website TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Type-specific detail tables
CREATE TABLE entity_persons (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  employer TEXT,
  occupation TEXT,
  city TEXT,
  state CHAR(2),
  zip_code CHAR(5)
);

CREATE TABLE entity_corporations (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  ticker TEXT,
  naics_code TEXT,
  sector TEXT,
  industry TEXT,
  market_cap BIGINT,
  parent_entity_id UUID REFERENCES entities(id),
  cik TEXT
);

CREATE TABLE entity_pacs (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  fec_committee_id TEXT NOT NULL,
  pac_type TEXT,
  designation TEXT,
  sponsor_entity_id UUID REFERENCES entities(id),
  treasurer_name TEXT,
  filing_frequency TEXT
);

CREATE TABLE entity_nonprofits (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  ein TEXT NOT NULL,
  irs_subsection TEXT,
  total_revenue BIGINT,
  total_expenses BIGINT,
  total_assets BIGINT,
  total_grants_made BIGINT,
  political_expenditures BIGINT,
  fiscal_year_end DATE,
  ruling_date DATE
);

CREATE TABLE entity_lobbying_firms (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  lda_registrant_id TEXT,
  client_count INTEGER DEFAULT 0,
  total_income BIGINT DEFAULT 0
);

CREATE TABLE entity_foreign_principals (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  country TEXT NOT NULL,
  principal_type TEXT,
  registration_date DATE,
  fara_reg_number TEXT
);

-- Indexes
CREATE INDEX idx_entities_type ON entities(entity_type);
CREATE INDEX idx_entities_name ON entities USING gin(name gin_trgm_ops);
CREATE INDEX idx_entities_external_ids ON entities USING gin(external_ids jsonb_path_ops);
CREATE INDEX idx_entities_aliases ON entities USING gin(aliases);
CREATE INDEX idx_entity_corps_ticker ON entity_corporations(ticker);
CREATE INDEX idx_entity_corps_naics ON entity_corporations(naics_code);
CREATE INDEX idx_entity_pacs_fec ON entity_pacs(fec_committee_id);
CREATE INDEX idx_entity_nonprofits_ein ON entity_nonprofits(ein);

-- Enable trigram extension for fuzzy name matching
CREATE EXTENSION IF NOT EXISTS pg_trgm;
