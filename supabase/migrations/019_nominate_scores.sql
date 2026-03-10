-- DW-NOMINATE ideology scores sourced from VoteView (voteview.com).
--
-- Stores one row per member per congress.  The primary key for lookup is
-- (bioguide_id, congress) — VoteView provides a bioguide_id for every member
-- since the 95th Congress (1977).  Historical members without a bioguide_id
-- are excluded by the import script.
--
-- Dimension interpretation:
--   nominate_dim1  — primary dimension: liberal (-1.0) to conservative (+1.0)
--   nominate_dim2  — secondary dimension: captures cross-cutting issues
--                    (e.g. slavery era, civil rights era social conservatism)
--
-- nokken_poole scores are congress-specific (re-estimated within each term)
-- whereas nominate scores represent career-span positions.

CREATE TABLE nominate_scores (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Member identification
  bioguide_id                 TEXT NOT NULL,          -- links to officials.bioguide_id
  congress                    INTEGER NOT NULL,        -- e.g. 119
  chamber                     TEXT NOT NULL            -- 'house' | 'senate'
                                CHECK (chamber IN ('house', 'senate')),
  icpsr                       INTEGER NOT NULL,        -- VoteView internal member ID
  party_code                  INTEGER NOT NULL,        -- 100=Democrat, 200=Republican, etc.
  state_abbrev                TEXT NOT NULL,           -- two-letter state abbreviation

  -- DW-NOMINATE career scores (estimated across all congresses served)
  nominate_dim1               NUMERIC(6,4),            -- −1.0 to +1.0
  nominate_dim2               NUMERIC(6,4),            -- −1.0 to +1.0
  nominate_log_likelihood     NUMERIC(10,6),
  nominate_geo_mean_probability NUMERIC(7,6),          -- 0.0 to 1.0
  nominate_number_of_votes    INTEGER,
  nominate_number_of_errors   INTEGER,

  -- Nokken-Poole congress-specific scores
  nokken_poole_dim1           NUMERIC(6,4),
  nokken_poole_dim2           NUMERIC(6,4),

  -- Extra fields from VoteView (bioname, birth/death years, etc.)
  metadata                    JSONB DEFAULT '{}',

  created_at                  TIMESTAMPTZ DEFAULT now(),
  updated_at                  TIMESTAMPTZ DEFAULT now(),

  -- One score row per member per congress
  UNIQUE (bioguide_id, congress)
);

-- Trigger to keep updated_at current.
CREATE OR REPLACE FUNCTION set_nominate_scores_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_nominate_scores_updated_at
  BEFORE UPDATE ON nominate_scores
  FOR EACH ROW EXECUTE FUNCTION set_nominate_scores_updated_at();

-- Indexes
CREATE INDEX idx_nominate_bioguide      ON nominate_scores (bioguide_id);
CREATE INDEX idx_nominate_congress      ON nominate_scores (congress);
CREATE INDEX idx_nominate_dim1          ON nominate_scores (nominate_dim1);
CREATE INDEX idx_nominate_chamber       ON nominate_scores (chamber);
CREATE INDEX idx_nominate_party_code    ON nominate_scores (party_code);
CREATE INDEX idx_nominate_state         ON nominate_scores (state_abbrev);
