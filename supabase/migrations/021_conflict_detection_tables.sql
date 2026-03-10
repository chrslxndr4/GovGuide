-- Migration 021: Conflict detection tables
-- Adds ticker_metadata and trade_enrichments to support the congressional
-- stock trade conflict detection engine.

-- ---------------------------------------------------------------------------
-- ticker_metadata
-- Stores company-level metadata resolved from ticker symbols (SIC, sector,
-- CIK, exchange). One row per ticker; updated in place via ON CONFLICT.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ticker_metadata (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    ticker          TEXT        NOT NULL UNIQUE,
    company_name    TEXT,
    sic_code        TEXT,
    sic_description TEXT,
    sector          TEXT,
    exchange        TEXT,
    cik             TEXT,
    metadata        JSONB       NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ticker_metadata_ticker
    ON ticker_metadata (ticker);

CREATE INDEX IF NOT EXISTS idx_ticker_metadata_sic_code
    ON ticker_metadata (sic_code);

CREATE INDEX IF NOT EXISTS idx_ticker_metadata_sector
    ON ticker_metadata (sector);

-- ---------------------------------------------------------------------------
-- trade_enrichments
-- One enrichment record per stock_trade; captures detected overlaps between
-- a trade and the official's committee assignments, donor network, and
-- regulatory/legislative activity. Populated by the conflict detection script.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trade_enrichments (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_trade_id          UUID        NOT NULL UNIQUE
                                            REFERENCES stock_trades (id)
                                            ON DELETE CASCADE,
    ticker_metadata_id      UUID        REFERENCES ticker_metadata (id),
    sector                  TEXT,
    committee_overlap       BOOLEAN     NOT NULL DEFAULT false,
    committee_names         TEXT[],
    related_bill_ids        UUID[],
    related_lobbying_ids    UUID[],
    donor_overlap           BOOLEAN     NOT NULL DEFAULT false,
    donor_entity_ids        UUID[],
    regulatory_overlap      BOOLEAN     NOT NULL DEFAULT false,
    related_regulation_ids  UUID[],
    enriched_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trade_enrichments_stock_trade_id
    ON trade_enrichments (stock_trade_id);

-- Partial indexes so conflict queries only scan rows where overlap exists.
CREATE INDEX IF NOT EXISTS idx_trade_enrichments_committee_overlap
    ON trade_enrichments (stock_trade_id)
    WHERE committee_overlap = true;

CREATE INDEX IF NOT EXISTS idx_trade_enrichments_donor_overlap
    ON trade_enrichments (stock_trade_id)
    WHERE donor_overlap = true;

CREATE INDEX IF NOT EXISTS idx_trade_enrichments_sector
    ON trade_enrichments (sector);
