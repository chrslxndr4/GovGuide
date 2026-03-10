-- Add missing entity_type enum values for IRS 990 and FARA imports
ALTER TYPE entity_type ADD VALUE IF NOT EXISTS '501c3';
ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'labor_union';
ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'super_pac';
ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'hybrid_pac';

-- Add description and website columns to entities table
ALTER TABLE entities ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS website TEXT;

-- Create entity_nonprofits table for IRS 990 data
CREATE TABLE IF NOT EXISTS entity_nonprofits (
  entity_id UUID PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  ein TEXT NOT NULL UNIQUE,
  irs_subsection TEXT,
  total_revenue BIGINT,
  total_expenses BIGINT,
  total_assets BIGINT,
  total_grants_made BIGINT,
  political_expenditures BIGINT,
  fiscal_year_end DATE,
  ruling_date DATE
);

CREATE INDEX IF NOT EXISTS idx_entity_nonprofits_ein ON entity_nonprofits(ein);

-- Add unique constraint on dark_money_flows for upserts
CREATE UNIQUE INDEX IF NOT EXISTS uq_dark_money_flows
  ON dark_money_flows(source_entity_id, target_entity_id, year, irs_filing);
