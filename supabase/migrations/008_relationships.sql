CREATE TYPE relationship_type AS ENUM (
  -- Money flows
  'donated_to', 'contributed_to', 'spent_for', 'spent_against',
  'granted_to', 'lobbied_via', 'paid_by',
  -- Power relationships
  'represents', 'sits_on', 'appointed_by', 'confirmed_by',
  'employed_by', 'previously_held', 'registered_for',
  -- Legislative
  'sponsored', 'cosponsored', 'voted_yea', 'voted_nay',
  'voted_present', 'voted_absent', 'lobbied_on', 'commented_on',
  'affects_industry',
  -- Judicial
  'decided', 'party_to', 'holds_stock', 'oversees',
  -- Financial
  'traded_stock', 'board_member', 'affiliated_with'
);

CREATE TABLE relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relationship_type relationship_type NOT NULL,
  amount NUMERIC(15,2),
  date_start DATE,
  date_end DATE,
  cycle TEXT,
  metadata JSONB DEFAULT '{}',
  confidence_score NUMERIC(3,2) DEFAULT 1.0,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_relationships_source ON relationships(source_entity_id);
CREATE INDEX idx_relationships_target ON relationships(target_entity_id);
CREATE INDEX idx_relationships_type ON relationships(relationship_type);
CREATE INDEX idx_relationships_source_type ON relationships(source_entity_id, relationship_type);
CREATE INDEX idx_relationships_target_type ON relationships(target_entity_id, relationship_type);
CREATE INDEX idx_relationships_cycle ON relationships(cycle);
CREATE INDEX idx_relationships_amount ON relationships(amount DESC NULLS LAST);
CREATE INDEX idx_relationships_date ON relationships(date_start);
CREATE INDEX idx_relationships_graph_traverse
  ON relationships(source_entity_id, relationship_type, target_entity_id);
