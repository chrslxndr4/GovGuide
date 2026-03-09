CREATE TABLE contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  donor_entity_id UUID REFERENCES entities(id),
  recipient_entity_id UUID REFERENCES entities(id),
  amount NUMERIC(12,2) NOT NULL,
  contribution_date DATE,
  contribution_type TEXT,
  employer TEXT,
  occupation TEXT,
  fec_filing_id TEXT,
  fec_transaction_id TEXT,
  memo TEXT,
  cycle TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE independent_expenditures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spender_entity_id UUID REFERENCES entities(id),
  candidate_entity_id UUID REFERENCES entities(id),
  amount NUMERIC(12,2) NOT NULL,
  expenditure_date DATE,
  support_oppose TEXT CHECK (support_oppose IN ('support', 'oppose')),
  purpose TEXT,
  payee TEXT,
  fec_filing_id TEXT,
  cycle TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE dark_money_flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entity_id UUID REFERENCES entities(id),
  target_entity_id UUID REFERENCES entities(id),
  amount NUMERIC(12,2),
  grant_year INTEGER,
  grant_purpose TEXT,
  irs_filing_year INTEGER,
  source_document TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_contributions_donor ON contributions(donor_entity_id);
CREATE INDEX idx_contributions_recipient ON contributions(recipient_entity_id);
CREATE INDEX idx_contributions_cycle ON contributions(cycle);
CREATE INDEX idx_contributions_date ON contributions(contribution_date);
CREATE INDEX idx_contributions_amount ON contributions(amount DESC);
CREATE INDEX idx_ie_spender ON independent_expenditures(spender_entity_id);
CREATE INDEX idx_ie_candidate ON independent_expenditures(candidate_entity_id);
CREATE INDEX idx_ie_cycle ON independent_expenditures(cycle);
CREATE INDEX idx_dark_money_source ON dark_money_flows(source_entity_id);
CREATE INDEX idx_dark_money_target ON dark_money_flows(target_entity_id);
