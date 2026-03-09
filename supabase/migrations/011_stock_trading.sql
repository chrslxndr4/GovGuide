-- Congressional stock trades (STOCK Act disclosures)
CREATE TABLE stock_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  official_id UUID REFERENCES officials(id),
  ticker TEXT,
  asset_name TEXT NOT NULL,
  trade_type TEXT CHECK (trade_type IN ('purchase', 'sale', 'exchange')),
  amount_range_low NUMERIC,
  amount_range_high NUMERIC,
  trade_date DATE,
  disclosure_date DATE,
  days_late INTEGER,
  filing_url TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_stock_trades_official ON stock_trades(official_id);
CREATE INDEX idx_stock_trades_ticker ON stock_trades(ticker);
CREATE INDEX idx_stock_trades_date ON stock_trades(trade_date);
CREATE INDEX idx_stock_trades_late ON stock_trades(days_late) WHERE days_late > 0;

-- Official financial holdings (annual disclosures)
CREATE TABLE official_holdings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  official_id UUID REFERENCES officials(id),
  ticker TEXT,
  asset_name TEXT NOT NULL,
  value_range_low NUMERIC,
  value_range_high NUMERIC,
  disclosure_year INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_holdings_official ON official_holdings(official_id);
CREATE INDEX idx_holdings_ticker ON official_holdings(ticker);
CREATE INDEX idx_holdings_year ON official_holdings(disclosure_year);
