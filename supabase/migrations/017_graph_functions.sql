-- Find all money paths between two entities (recursive CTE with cycle detection)
CREATE OR REPLACE FUNCTION find_money_paths(
  source_id UUID,
  target_id UUID,
  max_hops INT DEFAULT 5
)
RETURNS TABLE(path UUID[], relationship_types TEXT[], total_amount NUMERIC)
LANGUAGE sql STABLE
AS $$
  WITH RECURSIVE money_path AS (
    SELECT
      ARRAY[r.source_entity_id, r.target_entity_id] AS path,
      ARRAY[r.relationship_type::TEXT] AS rel_types,
      COALESCE(r.amount, 0) AS total,
      r.target_entity_id AS current_node,
      1 AS depth
    FROM relationships r
    WHERE r.source_entity_id = source_id
      AND r.relationship_type IN ('donated_to', 'contributed_to', 'granted_to', 'spent_for', 'lobbied_via', 'paid_by')

    UNION ALL

    SELECT
      mp.path || r.target_entity_id,
      mp.rel_types || r.relationship_type::TEXT,
      mp.total + COALESCE(r.amount, 0),
      r.target_entity_id,
      mp.depth + 1
    FROM money_path mp
    JOIN relationships r ON r.source_entity_id = mp.current_node
    WHERE mp.depth < max_hops
      AND r.target_entity_id != ALL(mp.path) -- cycle detection
      AND r.relationship_type IN ('donated_to', 'contributed_to', 'granted_to', 'spent_for', 'lobbied_via', 'paid_by')
  )
  SELECT path, rel_types, total
  FROM money_path
  WHERE current_node = target_id
  ORDER BY total DESC
  LIMIT 100;
$$;

-- Get all entities within N hops of a given entity (for graph visualization)
CREATE OR REPLACE FUNCTION get_entity_network(
  center_id UUID,
  max_depth INT DEFAULT 3,
  min_amount NUMERIC DEFAULT 0
)
RETURNS TABLE(
  entity_id UUID,
  entity_name TEXT,
  entity_type entity_type,
  depth INT,
  relationship_id UUID,
  rel_type relationship_type,
  rel_source UUID,
  rel_target UUID,
  rel_amount NUMERIC
)
LANGUAGE sql STABLE
AS $$
  WITH RECURSIVE network AS (
    -- Start from center
    SELECT
      center_id AS entity_id,
      0 AS depth,
      ARRAY[center_id] AS visited

    UNION ALL

    -- Expand outward (both directions)
    SELECT
      CASE
        WHEN r.source_entity_id = n.entity_id THEN r.target_entity_id
        ELSE r.source_entity_id
      END AS entity_id,
      n.depth + 1,
      n.visited || CASE
        WHEN r.source_entity_id = n.entity_id THEN r.target_entity_id
        ELSE r.source_entity_id
      END
    FROM network n
    JOIN relationships r ON (r.source_entity_id = n.entity_id OR r.target_entity_id = n.entity_id)
    WHERE n.depth < max_depth
      AND COALESCE(r.amount, 0) >= min_amount
      AND CASE
        WHEN r.source_entity_id = n.entity_id THEN r.target_entity_id
        ELSE r.source_entity_id
      END != ALL(n.visited) -- cycle detection
  )
  SELECT DISTINCT ON (e.id, r.id)
    e.id AS entity_id,
    e.name AS entity_name,
    e.entity_type,
    n.depth,
    r.id AS relationship_id,
    r.relationship_type AS rel_type,
    r.source_entity_id AS rel_source,
    r.target_entity_id AS rel_target,
    r.amount AS rel_amount
  FROM network n
  JOIN entities e ON e.id = n.entity_id
  LEFT JOIN relationships r ON (
    (r.source_entity_id = n.entity_id OR r.target_entity_id = n.entity_id)
    AND COALESCE(r.amount, 0) >= min_amount
  )
  ORDER BY e.id, r.id, n.depth;
$$;

-- Find all connections between two entities (any relationship type)
CREATE OR REPLACE FUNCTION find_connections(
  entity_a UUID,
  entity_b UUID,
  max_hops INT DEFAULT 4
)
RETURNS TABLE(path UUID[], relationship_types TEXT[])
LANGUAGE sql STABLE
AS $$
  WITH RECURSIVE conn AS (
    SELECT
      ARRAY[r.source_entity_id, r.target_entity_id] AS path,
      ARRAY[r.relationship_type::TEXT] AS rel_types,
      r.target_entity_id AS current_node,
      1 AS depth
    FROM relationships r
    WHERE r.source_entity_id = entity_a

    UNION ALL

    SELECT
      c.path || r.target_entity_id,
      c.rel_types || r.relationship_type::TEXT,
      r.target_entity_id,
      c.depth + 1
    FROM conn c
    JOIN relationships r ON r.source_entity_id = c.current_node
    WHERE c.depth < max_hops
      AND r.target_entity_id != ALL(c.path)
  )
  SELECT path, rel_types
  FROM conn
  WHERE current_node = entity_b
  ORDER BY array_length(path, 1)
  LIMIT 50;
$$;

-- Calculate donor-vote alignment for an official
CREATE OR REPLACE FUNCTION calculate_donor_vote_alignment(
  official_uuid UUID
)
RETURNS TABLE(industry TEXT, donation_total NUMERIC, aligned_votes INT, total_votes INT, alignment_pct NUMERIC)
LANGUAGE sql STABLE
AS $$
  WITH official_entity AS (
    SELECT e.id FROM entities e
    JOIN officials o ON e.external_ids->>'bioguide_id' = o.bioguide_id
    WHERE o.id = official_uuid
    LIMIT 1
  ),
  donor_industries AS (
    SELECT
      ec.sector AS industry,
      SUM(c.amount) AS total_donated
    FROM contributions c
    JOIN entities donor ON donor.id = c.donor_entity_id
    LEFT JOIN entity_corporations ec ON ec.entity_id = donor.id
    WHERE c.recipient_entity_id = (SELECT id FROM official_entity)
      AND ec.sector IS NOT NULL
    GROUP BY ec.sector
  )
  SELECT
    di.industry,
    di.total_donated AS donation_total,
    0 AS aligned_votes, -- placeholder: requires bill-industry mapping
    0 AS total_votes,
    0.0 AS alignment_pct
  FROM donor_industries di
  ORDER BY di.total_donated DESC
  LIMIT 20;
$$;
