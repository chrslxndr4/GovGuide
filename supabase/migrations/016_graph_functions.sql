-- Find all money paths between two entities (up to N hops)
CREATE OR REPLACE FUNCTION find_money_paths(
  p_source_id UUID,
  p_target_id UUID,
  p_max_hops INTEGER DEFAULT 5
)
RETURNS TABLE(
  path UUID[],
  relationship_types TEXT[],
  total_amount NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE money_path AS (
    SELECT
      ARRAY[r.source_entity_id, r.target_entity_id] AS path,
      ARRAY[r.relationship_type::TEXT] AS rel_types,
      COALESCE(r.amount, 0) AS total,
      r.target_entity_id AS current_node,
      1 AS depth
    FROM relationships r
    WHERE r.source_entity_id = p_source_id
      AND r.relationship_type IN (
        'donated_to', 'contributed_to', 'granted_to',
        'spent_for', 'spent_against', 'lobbied_via', 'paid_by'
      )
    UNION ALL
    SELECT
      mp.path || r.target_entity_id,
      mp.rel_types || r.relationship_type::TEXT,
      mp.total + COALESCE(r.amount, 0),
      r.target_entity_id,
      mp.depth + 1
    FROM money_path mp
    JOIN relationships r ON r.source_entity_id = mp.current_node
    WHERE mp.depth < p_max_hops
      AND r.target_entity_id != ALL(mp.path)
      AND r.relationship_type IN (
        'donated_to', 'contributed_to', 'granted_to',
        'spent_for', 'spent_against', 'lobbied_via', 'paid_by'
      )
  )
  SELECT mp.path, mp.rel_types, mp.total
  FROM money_path mp
  WHERE mp.current_node = p_target_id
  ORDER BY mp.total DESC
  LIMIT 50;
END;
$$ LANGUAGE plpgsql STABLE;

-- Get N-hop neighborhood of an entity (for graph visualization)
CREATE OR REPLACE FUNCTION get_entity_neighborhood(
  p_entity_id UUID,
  p_max_hops INTEGER DEFAULT 2,
  p_relationship_types relationship_type[] DEFAULT NULL,
  p_min_amount NUMERIC DEFAULT NULL
)
RETURNS TABLE(
  entity_id UUID,
  entity_name TEXT,
  entity_type entity_type,
  hop_distance INTEGER
) AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE neighborhood AS (
    SELECT p_entity_id AS eid, 0 AS depth
    UNION
    SELECT
      CASE
        WHEN r.source_entity_id = n.eid THEN r.target_entity_id
        ELSE r.source_entity_id
      END AS eid,
      n.depth + 1 AS depth
    FROM neighborhood n
    JOIN relationships r ON (r.source_entity_id = n.eid OR r.target_entity_id = n.eid)
    WHERE n.depth < p_max_hops
      AND (p_relationship_types IS NULL OR r.relationship_type = ANY(p_relationship_types))
      AND (p_min_amount IS NULL OR r.amount >= p_min_amount)
  )
  SELECT DISTINCT ON (e.id)
    e.id,
    e.name,
    e.entity_type,
    MIN(n.depth) AS hop_distance
  FROM neighborhood n
  JOIN entities e ON e.id = n.eid
  GROUP BY e.id, e.name, e.entity_type
  ORDER BY e.id, MIN(n.depth)
  LIMIT 500;
END;
$$ LANGUAGE plpgsql STABLE;

-- Get edges between a set of entities (for graph visualization)
CREATE OR REPLACE FUNCTION get_edges_between(
  p_entity_ids UUID[]
)
RETURNS TABLE(
  relationship_id UUID,
  source_id UUID,
  target_id UUID,
  rel_type relationship_type,
  amount NUMERIC,
  date_start DATE,
  cycle TEXT,
  metadata JSONB
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    r.id,
    r.source_entity_id,
    r.target_entity_id,
    r.relationship_type,
    r.amount,
    r.date_start,
    r.cycle,
    r.metadata
  FROM relationships r
  WHERE r.source_entity_id = ANY(p_entity_ids)
    AND r.target_entity_id = ANY(p_entity_ids);
END;
$$ LANGUAGE plpgsql STABLE;

-- Top donors for an official (aggregated across cycles)
CREATE OR REPLACE FUNCTION get_official_top_donors(
  p_official_id UUID,
  p_limit INTEGER DEFAULT 20,
  p_cycle TEXT DEFAULT NULL
)
RETURNS TABLE(
  donor_entity_id UUID,
  donor_name TEXT,
  donor_type entity_type,
  total_amount NUMERIC,
  contribution_count BIGINT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    e.id,
    e.name,
    e.entity_type,
    SUM(c.amount) AS total_amount,
    COUNT(*) AS contribution_count
  FROM contributions c
  JOIN entities e ON e.id = c.donor_entity_id
  JOIN officials o ON o.id = p_official_id
  JOIN entities oe ON oe.external_ids->>'fec_id' = o.fec_id
  WHERE c.recipient_entity_id = oe.id
    AND (p_cycle IS NULL OR c.cycle = p_cycle)
  GROUP BY e.id, e.name, e.entity_type
  ORDER BY total_amount DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql STABLE;
