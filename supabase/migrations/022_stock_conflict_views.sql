-- Migration 022: Materialized views for stock tracker and conflict timeline
-- Provides pre-joined, indexed snapshots for fast page loads on /stocks and
-- conflict timeline feeds. Refreshed on the same schedule as existing views.

-- ---------------------------------------------------------------------------
-- mv_trade_conflicts
-- One row per stock trade, enriched with conflict alert signals.
-- Powers the /stocks feed and individual trade detail pages.
-- Note: conflict_alerts uses entity_ids UUID[] not official_id.
--       We match via officials.entity_id (if the column exists) or
--       stock_trades.entity_id being ANY of conflict_alerts.entity_ids.
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_trade_conflicts AS
SELECT
  st.id                           AS trade_id,
  st.ticker,
  st.asset_name,
  st.trade_type,
  st.amount_range_low,
  st.amount_range_high,
  st.trade_date,
  st.disclosure_date,
  st.days_late,
  st.filing_url,
  st.official_id,
  o.full_name                     AS official_name,
  o.slug                          AS official_slug,
  o.party,
  te.sector,
  te.committee_overlap,
  te.committee_names,
  te.donor_overlap,
  te.regulatory_overlap,
  COALESCE(ca_agg.conflict_severity, 0) AS conflict_severity,
  COALESCE(ca_agg.conflict_count, 0)    AS conflict_count
FROM stock_trades st
JOIN officials o ON o.id = st.official_id
LEFT JOIN trade_enrichments te ON te.stock_trade_id = st.id
LEFT JOIN LATERAL (
  SELECT
    MAX(ca.severity_score) AS conflict_severity,
    COUNT(*)               AS conflict_count
  FROM conflict_alerts ca
  WHERE ca.alert_type IN ('stock_committee', 'trade_timing')
    AND ca.status = 'active'
    AND ca.detected_at BETWEEN (st.trade_date::timestamptz - INTERVAL '60 days')
                            AND (st.trade_date::timestamptz + INTERVAL '60 days')
    AND st.official_id = ANY(ca.entity_ids)
) ca_agg ON true
ORDER BY st.trade_date DESC;

CREATE UNIQUE INDEX idx_mv_trade_conflicts_trade_id
  ON mv_trade_conflicts (trade_id);

CREATE INDEX idx_mv_trade_conflicts_trade_date
  ON mv_trade_conflicts (trade_date DESC);

CREATE INDEX idx_mv_trade_conflicts_official_id
  ON mv_trade_conflicts (official_id);

CREATE INDEX idx_mv_trade_conflicts_conflict_severity
  ON mv_trade_conflicts (conflict_severity DESC)
  WHERE conflict_severity > 0;

-- ---------------------------------------------------------------------------
-- mv_politician_trade_summary
-- One row per current official with aggregated trading statistics.
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_politician_trade_summary AS
SELECT
  o.id                              AS official_id,
  o.full_name,
  o.slug,
  o.party,
  COUNT(st.id)                      AS total_trades,
  COUNT(st.id) FILTER (WHERE st.days_late IS NOT NULL AND st.days_late > 45)
                                    AS late_filings,
  COUNT(st.id) FILTER (WHERE te.committee_overlap = true)
                                    AS committee_overlaps,
  COUNT(st.id) FILTER (WHERE te.donor_overlap = true)
                                    AS donor_overlaps,
  COALESCE(SUM(st.amount_range_high), 0)
                                    AS total_volume_high,
  MIN(st.trade_date)                AS earliest_trade,
  MAX(st.trade_date)                AS latest_trade,
  COUNT(DISTINCT st.ticker)         AS unique_tickers
FROM officials o
LEFT JOIN stock_trades st ON st.official_id = o.id
LEFT JOIN trade_enrichments te ON te.stock_trade_id = st.id
WHERE o.is_current = true
GROUP BY o.id, o.full_name, o.slug, o.party;

CREATE UNIQUE INDEX idx_mv_politician_trade_summary_official_id
  ON mv_politician_trade_summary (official_id);

-- ---------------------------------------------------------------------------
-- mv_conflict_timeline
-- Chronological stream of active conflict alerts.
-- Uses entity_ids to find the related official (if any).
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_conflict_timeline AS
SELECT
  ca.id             AS alert_id,
  ca.alert_type,
  ca.severity_score,
  ca.description,
  ca.detected_at,
  o.id              AS official_id,
  o.full_name       AS official_name,
  o.slug            AS official_slug,
  o.party,
  ca.evidence,
  ca.status
FROM conflict_alerts ca
LEFT JOIN officials o ON o.id = ANY(ca.entity_ids)
WHERE ca.status = 'active'
ORDER BY ca.detected_at DESC;

CREATE UNIQUE INDEX idx_mv_conflict_timeline_alert_id
  ON mv_conflict_timeline (alert_id);

CREATE INDEX idx_mv_conflict_timeline_detected_at
  ON mv_conflict_timeline (detected_at DESC);

CREATE INDEX idx_mv_conflict_timeline_alert_type
  ON mv_conflict_timeline (alert_type);

-- ---------------------------------------------------------------------------
-- Update refresh function to include new views
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS VOID AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_official_top_donors;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_official_industry_funding;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_corporate_influence_rankings;
  REFRESH MATERIALIZED VIEW mv_judge_conflict_flags;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_trade_conflicts;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_politician_trade_summary;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_conflict_timeline;
END;
$$ LANGUAGE plpgsql;
