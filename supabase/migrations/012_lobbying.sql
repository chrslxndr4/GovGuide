-- Lobbying registrations (LD-1 filings)
CREATE TABLE lobbying_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_entity_id UUID REFERENCES entities(id),
  client_entity_id UUID REFERENCES entities(id),
  issues TEXT[] DEFAULT '{}',
  effective_date DATE,
  termination_date DATE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_lobby_reg_firm ON lobbying_registrations(firm_entity_id);
CREATE INDEX idx_lobby_reg_client ON lobbying_registrations(client_entity_id);
CREATE INDEX idx_lobby_reg_active ON lobbying_registrations(termination_date) WHERE termination_date IS NULL;

-- Lobbying activity reports (LD-2 filings)
CREATE TABLE lobbying_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id UUID REFERENCES lobbying_registrations(id),
  report_period TEXT,
  amount NUMERIC,
  bills_lobbied TEXT[] DEFAULT '{}',
  agencies_contacted TEXT[] DEFAULT '{}',
  lobbyists JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_lobby_act_reg ON lobbying_activities(registration_id);
CREATE INDEX idx_lobby_act_amount ON lobbying_activities(amount) WHERE amount IS NOT NULL;
CREATE INDEX idx_lobby_act_bills ON lobbying_activities USING gin(bills_lobbied);

-- Lobbyist political contributions (LD-203 filings)
CREATE TABLE lobbying_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lobbyist_entity_id UUID REFERENCES entities(id),
  recipient_entity_id UUID REFERENCES entities(id),
  amount NUMERIC NOT NULL,
  contribution_date DATE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_lobby_contrib_lobbyist ON lobbying_contributions(lobbyist_entity_id);
CREATE INDEX idx_lobby_contrib_recipient ON lobbying_contributions(recipient_entity_id);
