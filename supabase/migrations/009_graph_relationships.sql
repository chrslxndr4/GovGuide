CREATE TYPE relationship_type AS ENUM (
  -- Money flows
  'donated_to', 'contributed_to', 'spent_for', 'spent_against',
  'granted_to', 'lobbied_via', 'paid_by',
  -- Power relationships
  'represents', 'sits_on', 'appointed_by', 'confirmed_by',
  'employed_by', 'previously_held', 'registered_for',
  -- Legislative
  'sponsored', 'cosponsored', 'voted_on', 'lobbied_on',
  'affects_industry', 'commented_on',
  -- Judicial
  'decided', 'party_to', 'holds_stock', 'oversees',
  -- Financial
  'traded', 'late_filed'
);

CREATE TABLE relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relationship_type relationship_type NOT NULL,
  amount NUMERIC,
  date_start DATE,
  date_end DATE,
  metadata JSONB DEFAULT '{}',
  confidence_score NUMERIC(3,2) DEFAULT 1.00,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_rel_source ON relationships(source_entity_id);
CREATE INDEX idx_rel_target ON relationships(target_entity_id);
CREATE INDEX idx_rel_type ON relationships(relationship_type);
CREATE INDEX idx_rel_amount ON relationships(amount) WHERE amount IS NOT NULL;
CREATE INDEX idx_rel_date ON relationships(date_start) WHERE date_start IS NOT NULL;
CREATE INDEX idx_rel_source_type ON relationships(source_entity_id, relationship_type);
CREATE INDEX idx_rel_target_type ON relationships(target_entity_id, relationship_type);
-- Composite for graph traversal queries
CREATE INDEX idx_rel_traversal ON relationships(source_entity_id, relationship_type, target_entity_id);
