-- Top 20 donors per official (refreshed daily)
CREATE MATERIALIZED VIEW mv_official_top_donors AS
SELECT
  c.recipient_entity_id AS official_entity_id,
  c.donor_entity_id,
  e.name AS donor_name,
  e.entity_type AS donor_type,
  SUM(c.amount) AS total_donated,
  COUNT(*) AS contribution_count,
  MIN(c.contribution_date) AS first_donation,
  MAX(c.contribution_date) AS last_donation
FROM contributions c
JOIN entities e ON e.id = c.donor_entity_id
GROUP BY c.recipient_entity_id, c.donor_entity_id, e.name, e.entity_type
ORDER BY c.recipient_entity_id, SUM(c.amount) DESC;

CREATE UNIQUE INDEX idx_mv_top_donors ON mv_official_top_donors(official_entity_id, donor_entity_id);

-- Funding by industry per official (refreshed daily)
CREATE MATERIALIZED VIEW mv_official_industry_funding AS
SELECT
  c.recipient_entity_id AS official_entity_id,
  COALESCE(ec.sector, 'Unknown') AS industry,
  SUM(c.amount) AS total_amount,
  COUNT(DISTINCT c.donor_entity_id) AS donor_count
FROM contributions c
LEFT JOIN entity_corporations ec ON ec.entity_id = c.donor_entity_id
GROUP BY c.recipient_entity_id, COALESCE(ec.sector, 'Unknown')
ORDER BY c.recipient_entity_id, SUM(c.amount) DESC;

CREATE UNIQUE INDEX idx_mv_industry_funding ON mv_official_industry_funding(official_entity_id, industry);

-- Corporate influence rankings (refreshed weekly)
CREATE MATERIALIZED VIEW mv_corporate_influence_rankings AS
SELECT
  e.id AS entity_id,
  e.name,
  COALESCE(lobby.total_lobbying, 0) AS lobbying_spend,
  COALESCE(pac.total_pac, 0) AS pac_contributions,
  COALESCE(contracts.total_contracts, 0) AS gov_contracts,
  (
    COALESCE(lobby.total_lobbying, 0) * 0.25 +
    COALESCE(pac.total_pac, 0) * 0.20 +
    COALESCE(contracts.total_contracts, 0) * 0.10
  ) / NULLIF(
    GREATEST(
      COALESCE(lobby.total_lobbying, 0),
      COALESCE(pac.total_pac, 0),
      COALESCE(contracts.total_contracts, 0),
      1
    ), 0
  ) * 100 AS influence_score
FROM entities e
LEFT JOIN (
  SELECT client_entity_id, SUM(la.amount) AS total_lobbying
  FROM lobbying_registrations lr
  JOIN lobbying_activities la ON la.registration_id = lr.id
  GROUP BY client_entity_id
) lobby ON lobby.client_entity_id = e.id
LEFT JOIN (
  SELECT donor_entity_id, SUM(amount) AS total_pac
  FROM contributions
  GROUP BY donor_entity_id
) pac ON pac.donor_entity_id = e.id
LEFT JOIN (
  SELECT target_entity_id, SUM(amount) AS total_contracts
  FROM relationships
  WHERE relationship_type = 'paid_by'
  GROUP BY target_entity_id
) contracts ON contracts.target_entity_id = e.id
WHERE e.entity_type IN ('corporation', 'trade_association')
ORDER BY influence_score DESC;

CREATE UNIQUE INDEX idx_mv_corp_influence ON mv_corporate_influence_rankings(entity_id);

-- Judge conflict flags (refreshed weekly)
CREATE MATERIALIZED VIEW mv_judge_conflict_flags AS
SELECT DISTINCT
  j.id AS judge_id,
  j.full_name AS judge_name,
  ji.ticker,
  ji.asset_name,
  cp.case_id,
  jd.title AS case_title,
  cp.party_entity_id,
  e.name AS party_name,
  ji.value_range_low,
  ji.value_range_high
FROM judges j
JOIN judge_investments ji ON ji.judge_id = j.id
JOIN case_judges cj ON cj.judge_id = j.id
JOIN judicial_decisions jd ON jd.id = cj.case_id
JOIN case_parties cp ON cp.case_id = cj.case_id
JOIN entities e ON e.id = cp.party_entity_id
LEFT JOIN entity_corporations ec ON ec.entity_id = e.id
WHERE ji.ticker IS NOT NULL
  AND ec.ticker IS NOT NULL
  AND LOWER(ji.ticker) = LOWER(ec.ticker);

CREATE INDEX idx_mv_judge_conflicts ON mv_judge_conflict_flags(judge_id);

-- Helper function to refresh all materialized views
CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_official_top_donors;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_official_industry_funding;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_corporate_influence_rankings;
  REFRESH MATERIALIZED VIEW mv_judge_conflict_flags; -- no unique index for CONCURRENTLY
END;
$$;
