-- Top donors per official (refreshed daily)
CREATE MATERIALIZED VIEW mv_official_top_donors AS
SELECT
  o.id AS official_id,
  e.id AS donor_entity_id,
  e.name AS donor_name,
  e.entity_type AS donor_type,
  c.cycle,
  SUM(c.amount) AS total_amount,
  COUNT(*) AS contribution_count,
  ROW_NUMBER() OVER (PARTITION BY o.id, c.cycle ORDER BY SUM(c.amount) DESC) AS rank
FROM officials o
JOIN entities oe ON oe.external_ids->>'fec_id' = o.fec_id AND o.fec_id IS NOT NULL
JOIN contributions c ON c.recipient_entity_id = oe.id
JOIN entities e ON e.id = c.donor_entity_id
GROUP BY o.id, e.id, e.name, e.entity_type, c.cycle;

CREATE UNIQUE INDEX idx_mv_top_donors_pk ON mv_official_top_donors(official_id, donor_entity_id, cycle);
CREATE INDEX idx_mv_top_donors_official ON mv_official_top_donors(official_id, cycle, rank);

-- Industry funding per official (refreshed daily)
CREATE MATERIALIZED VIEW mv_official_industry_funding AS
SELECT
  o.id AS official_id,
  ec.sector,
  ec.industry,
  ec.naics_code,
  c.cycle,
  SUM(c.amount) AS total_amount,
  COUNT(DISTINCT c.donor_entity_id) AS donor_count
FROM officials o
JOIN entities oe ON oe.external_ids->>'fec_id' = o.fec_id AND o.fec_id IS NOT NULL
JOIN contributions c ON c.recipient_entity_id = oe.id
JOIN entities e ON e.id = c.donor_entity_id
LEFT JOIN entity_corporations ec ON ec.entity_id = e.id
WHERE ec.sector IS NOT NULL
GROUP BY o.id, ec.sector, ec.industry, ec.naics_code, c.cycle;

CREATE INDEX idx_mv_industry_funding_official ON mv_official_industry_funding(official_id, cycle);

-- Stock trade alerts (trades near committee-relevant votes)
CREATE MATERIALIZED VIEW mv_stock_trade_alerts AS
SELECT
  st.id AS trade_id,
  st.official_id,
  st.ticker,
  st.asset_name,
  st.trade_type,
  st.amount_range_low,
  st.amount_range_high,
  st.trade_date,
  st.days_late,
  rcv.id AS vote_id,
  b.bill_id AS bill_identifier,
  b.title AS bill_title,
  rcv.vote_date,
  ABS(rcv.vote_date - st.trade_date) AS days_between,
  vp.position AS vote_position
FROM stock_trades st
JOIN officials o ON o.id = st.official_id
JOIN vote_positions vp ON vp.official_id = o.id
JOIN roll_call_votes rcv ON rcv.id = vp.vote_id
JOIN bills b ON b.id = rcv.bill_id
WHERE ABS(rcv.vote_date - st.trade_date) <= 30
  AND st.ticker IS NOT NULL;

CREATE INDEX idx_mv_stock_alerts_official ON mv_stock_trade_alerts(official_id);
CREATE INDEX idx_mv_stock_alerts_days ON mv_stock_trade_alerts(days_between);

-- Refresh function for all materialized views
CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS VOID AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_official_top_donors;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_official_industry_funding;
  REFRESH MATERIALIZED VIEW mv_stock_trade_alerts;
END;
$$ LANGUAGE plpgsql;
