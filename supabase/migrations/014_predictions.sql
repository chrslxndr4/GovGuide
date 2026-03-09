CREATE TABLE polls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pollster TEXT NOT NULL,
  poll_url TEXT,
  race_type TEXT NOT NULL,
  state TEXT,
  district TEXT,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  sample_size INTEGER,
  margin_of_error NUMERIC(4,2),
  methodology TEXT,
  population TEXT,
  partisan TEXT,
  candidates JSONB NOT NULL,
  cycle TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE pollster_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pollster TEXT NOT NULL UNIQUE,
  accuracy_score NUMERIC(5,3),
  mean_bias NUMERIC(5,3),
  races_polled INTEGER,
  methodology_transparency TEXT,
  is_partisan BOOLEAN DEFAULT false,
  rating_source TEXT,
  metadata JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE prediction_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  platform_contract_id TEXT NOT NULL,
  question TEXT NOT NULL,
  category TEXT,
  subcategory TEXT,
  current_probability NUMERIC(5,4),
  volume_total NUMERIC(15,2),
  open_date TIMESTAMPTZ,
  close_date TIMESTAMPTZ,
  resolved BOOLEAN DEFAULT false,
  resolved_outcome TEXT,
  resolution_date TIMESTAMPTZ,
  contract_url TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(platform, platform_contract_id)
);

CREATE TABLE prediction_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES prediction_contracts(id) ON DELETE CASCADE,
  snapshot_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  probability NUMERIC(5,4) NOT NULL,
  volume_24h NUMERIC(15,2),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE prediction_anomalies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id UUID NOT NULL REFERENCES prediction_contracts(id),
  anomaly_type TEXT NOT NULL,
  detection_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  description TEXT NOT NULL,
  severity_score NUMERIC(3,1),
  probability_before NUMERIC(5,4),
  probability_after NUMERIC(5,4),
  volume_before NUMERIC(15,2),
  volume_after NUMERIC(15,2),
  related_event TEXT,
  related_event_time TIMESTAMPTZ,
  wallet_addresses TEXT[],
  metadata JSONB DEFAULT '{}',
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'reviewed', 'dismissed', 'confirmed')),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_polls_race ON polls(race_type, state);
CREATE INDEX idx_polls_date ON polls(end_date DESC);
CREATE INDEX idx_polls_cycle ON polls(cycle);
CREATE INDEX idx_polls_pollster ON polls(pollster);
CREATE INDEX idx_prediction_contracts_platform ON prediction_contracts(platform);
CREATE INDEX idx_prediction_contracts_category ON prediction_contracts(category);
CREATE INDEX idx_prediction_contracts_active ON prediction_contracts(resolved, close_date) WHERE NOT resolved;
CREATE INDEX idx_prediction_snapshots_contract ON prediction_snapshots(contract_id, snapshot_time DESC);
CREATE INDEX idx_prediction_anomalies_contract ON prediction_anomalies(contract_id);
CREATE INDEX idx_prediction_anomalies_severity ON prediction_anomalies(severity_score DESC);
CREATE INDEX idx_prediction_anomalies_status ON prediction_anomalies(status) WHERE status = 'active';
