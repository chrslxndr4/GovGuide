-- Polling data
CREATE TABLE polls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pollster TEXT NOT NULL,
  race_type TEXT, -- 'presidential', 'senate', 'house', 'governor', 'ballot_measure'
  geography TEXT, -- state abbr or 'national'
  date_conducted DATE,
  sample_size INTEGER,
  methodology TEXT,
  margin_of_error NUMERIC(4,2),
  candidates JSONB DEFAULT '{}', -- { "Biden": 45.2, "Trump": 44.1 }
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_polls_pollster ON polls(pollster);
CREATE INDEX idx_polls_race ON polls(race_type);
CREATE INDEX idx_polls_geo ON polls(geography);
CREATE INDEX idx_polls_date ON polls(date_conducted);

-- Pollster accuracy ratings
CREATE TABLE pollster_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pollster TEXT NOT NULL UNIQUE,
  accuracy_score NUMERIC(5,3),
  mean_bias NUMERIC(5,3),
  races_polled INTEGER,
  methodology_rating TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Prediction market contracts
CREATE TABLE prediction_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL, -- 'polymarket', 'kalshi', 'metaculus'
  question TEXT NOT NULL,
  category TEXT, -- 'election', 'legislation', 'policy', 'geopolitical'
  current_probability NUMERIC(5,4),
  volume_total NUMERIC,
  open_date DATE,
  close_date DATE,
  resolved BOOLEAN DEFAULT false,
  resolution TEXT,
  external_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_pred_platform ON prediction_contracts(platform);
CREATE INDEX idx_pred_category ON prediction_contracts(category);
CREATE INDEX idx_pred_active ON prediction_contracts(resolved) WHERE resolved = false;
CREATE INDEX idx_pred_external ON prediction_contracts(platform, external_id);

-- Prediction market individual trades (for anomaly detection)
CREATE TABLE prediction_trades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID REFERENCES prediction_contracts(id),
  trade_timestamp TIMESTAMPTZ NOT NULL,
  price NUMERIC(5,4),
  size NUMERIC,
  side TEXT CHECK (side IN ('buy', 'sell')),
  wallet_address TEXT, -- polymarket on-chain address
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_pred_trades_contract ON prediction_trades(contract_id);
CREATE INDEX idx_pred_trades_time ON prediction_trades(trade_timestamp);
CREATE INDEX idx_pred_trades_wallet ON prediction_trades(wallet_address) WHERE wallet_address IS NOT NULL;

-- Detected anomalies in prediction markets
CREATE TABLE prediction_anomalies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID REFERENCES prediction_contracts(id),
  anomaly_type TEXT NOT NULL, -- 'volume_spike', 'price_jump', 'insider_pattern', 'cross_market'
  detection_timestamp TIMESTAMPTZ DEFAULT now(),
  description TEXT,
  severity_score NUMERIC(3,1),
  related_event TEXT,
  evidence JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_anomalies_contract ON prediction_anomalies(contract_id);
CREATE INDEX idx_anomalies_type ON prediction_anomalies(anomaly_type);
CREATE INDEX idx_anomalies_severity ON prediction_anomalies(severity_score);
