-- Required for upsert deduplication in import-statewide-executives.ts
-- Also fixes existing import-state-officials.ts which already uses this conflict key
CREATE UNIQUE INDEX IF NOT EXISTS idx_officials_slug_office
  ON officials(slug, office_id);
