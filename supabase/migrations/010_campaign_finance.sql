-- Individual and organizational contributions
CREATE TABLE contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  donor_entity_id UUID REFERENCES entities(id),
  recipient_entity_id UUID REFERENCES entities(id),
  amount NUMERIC NOT NULL,
  contribution_date DATE,
  fec_filing_id TEXT,
  contribution_type TEXT,
  employer TEXT,
  occupation TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_contributions_donor ON contributions(donor_entity_id);
CREATE INDEX idx_contributions_recipient ON contributions(recipient_entity_id);
CREATE INDEX idx_contributions_date ON contributions(contribution_date);
CREATE INDEX idx_contributions_amount ON contributions(amount);
CREATE INDEX idx_contributions_fec ON contributions(fec_filing_id) WHERE fec_filing_id IS NOT NULL;

-- Independent expenditures (Super PAC spending for/against candidates)
CREATE TABLE independent_expenditures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  spender_entity_id UUID REFERENCES entities(id),
  candidate_entity_id UUID REFERENCES entities(id),
  amount NUMERIC NOT NULL,
  expenditure_date DATE,
  support_oppose TEXT CHECK (support_oppose IN ('support', 'oppose')),
  payee TEXT,
  purpose TEXT,
  fec_filing_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_ie_spender ON independent_expenditures(spender_entity_id);
CREATE INDEX idx_ie_candidate ON independent_expenditures(candidate_entity_id);
CREATE INDEX idx_ie_date ON independent_expenditures(expenditure_date);

-- Dark money flows (501c4 → PAC/501c4 grants)
CREATE TABLE dark_money_flows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entity_id UUID REFERENCES entities(id),
  target_entity_id UUID REFERENCES entities(id),
  amount NUMERIC NOT NULL,
  year INTEGER,
  irs_filing TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_dark_money_source ON dark_money_flows(source_entity_id);
CREATE INDEX idx_dark_money_target ON dark_money_flows(target_entity_id);
CREATE INDEX idx_dark_money_year ON dark_money_flows(year);
