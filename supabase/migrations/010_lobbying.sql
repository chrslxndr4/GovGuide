CREATE TABLE lobbying_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_entity_id UUID REFERENCES entities(id),
  client_entity_id UUID REFERENCES entities(id),
  senate_registration_id TEXT,
  effective_date DATE,
  termination_date DATE,
  general_issues TEXT[],
  specific_issues TEXT,
  foreign_entity_involved BOOLEAN DEFAULT false,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE lobbying_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id UUID REFERENCES lobbying_registrations(id),
  report_year INTEGER NOT NULL,
  report_quarter INTEGER NOT NULL CHECK (report_quarter BETWEEN 1 AND 4),
  income_or_expense NUMERIC(12,2),
  bills_lobbied TEXT[],
  agencies_contacted TEXT[],
  lobbyists JSONB DEFAULT '[]',
  general_issues TEXT[],
  specific_issues TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE lobbying_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lobbyist_entity_id UUID REFERENCES entities(id),
  recipient_entity_id UUID REFERENCES entities(id),
  amount NUMERIC(12,2),
  contribution_date DATE,
  contribution_type TEXT,
  fec_filing_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_lobby_reg_firm ON lobbying_registrations(firm_entity_id);
CREATE INDEX idx_lobby_reg_client ON lobbying_registrations(client_entity_id);
CREATE INDEX idx_lobby_act_reg ON lobbying_activities(registration_id);
CREATE INDEX idx_lobby_act_year_qtr ON lobbying_activities(report_year, report_quarter);
CREATE INDEX idx_lobby_act_bills ON lobbying_activities USING gin(bills_lobbied);
CREATE INDEX idx_lobby_contrib_lobbyist ON lobbying_contributions(lobbyist_entity_id);
CREATE INDEX idx_lobby_contrib_recipient ON lobbying_contributions(recipient_entity_id);
