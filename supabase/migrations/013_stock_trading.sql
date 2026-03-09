CREATE TABLE stock_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  official_id UUID NOT NULL REFERENCES officials(id),
  ticker TEXT,
  asset_name TEXT NOT NULL,
  asset_type TEXT,
  trade_type TEXT NOT NULL CHECK (trade_type IN ('buy', 'sell', 'exchange', 'receive')),
  amount_range_low NUMERIC(15,2),
  amount_range_high NUMERIC(15,2),
  trade_date DATE NOT NULL,
  disclosure_date DATE NOT NULL,
  days_late INTEGER GENERATED ALWAYS AS (
    GREATEST(0, disclosure_date - trade_date - 45)
  ) STORED,
  filing_url TEXT,
  owner TEXT,
  comment TEXT,
  entity_id UUID REFERENCES entities(id),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE official_holdings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  official_id UUID NOT NULL REFERENCES officials(id),
  ticker TEXT,
  asset_name TEXT NOT NULL,
  asset_type TEXT,
  value_range_low NUMERIC(15,2),
  value_range_high NUMERIC(15,2),
  income_range_low NUMERIC(12,2),
  income_range_high NUMERIC(12,2),
  disclosure_year INTEGER NOT NULL,
  owner TEXT,
  entity_id UUID REFERENCES entities(id),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_stock_trades_official ON stock_trades(official_id);
CREATE INDEX idx_stock_trades_ticker ON stock_trades(ticker);
CREATE INDEX idx_stock_trades_date ON stock_trades(trade_date DESC);
CREATE INDEX idx_stock_trades_disclosure ON stock_trades(disclosure_date DESC);
CREATE INDEX idx_stock_trades_late ON stock_trades(days_late DESC) WHERE days_late > 0;
CREATE INDEX idx_stock_trades_entity ON stock_trades(entity_id);
CREATE INDEX idx_official_holdings_official ON official_holdings(official_id);
CREATE INDEX idx_official_holdings_ticker ON official_holdings(ticker);
CREATE INDEX idx_official_holdings_year ON official_holdings(disclosure_year);
