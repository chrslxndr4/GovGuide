# Entity Enrichment & Pipelines Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 10 new data sources (Wikidata, OpenCorporates, Crunchbase, ICIJ, OpenSanctions, Ballotpedia, FARA enrichment, OpenSecrets, FEC Bulk, USAspending sub-awards) to enrich entity profiles with biographical, corporate, risk, and financial data.

**Architecture:** Each source gets a typed API client in `scripts/pipeline/clients/` and a pipeline class in `scripts/pipeline/pipelines/` extending `BasePipeline`. Bulk sources (ICIJ, OpenSanctions, OpenSecrets) use download-and-import scripts with staging tables. Entity resolution runs after all sources to cross-link discovered entities. Materialized views aggregate data for the UI layer.

**Tech Stack:** TypeScript, Supabase (PostgreSQL), existing `BasePipeline` pattern, `entity-resolver.ts` library.

**Spec:** `docs/superpowers/specs/2026-03-10-entity-enrichment-design.md`

---

## Chunk 1: Database Migrations

### Task 1: Migration 025 — Extend entity_persons and entity_corporations

**Files:**
- Create: `supabase/migrations/025_enrichment_schema.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 025_enrichment_schema.sql
-- Extends existing tables for enrichment data

-- === entity_persons extensions ===
ALTER TABLE entity_persons
  ADD COLUMN IF NOT EXISTS bio_summary TEXT,
  ADD COLUMN IF NOT EXISTS net_worth_low BIGINT,
  ADD COLUMN IF NOT EXISTS net_worth_high BIGINT,
  ADD COLUMN IF NOT EXISTS birth_date DATE,
  ADD COLUMN IF NOT EXISTS birth_place TEXT,
  ADD COLUMN IF NOT EXISTS photo_url_fallback TEXT,
  ADD COLUMN IF NOT EXISTS last_enriched_at TIMESTAMPTZ;

-- === entity_corporations extensions ===
ALTER TABLE entity_corporations
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS industry TEXT,
  ADD COLUMN IF NOT EXISTS founded_date DATE,
  ADD COLUMN IF NOT EXISTS headquarters TEXT,
  ADD COLUMN IF NOT EXISTS govt_contract_total BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_enriched_at TIMESTAMPTZ;

-- Note: entity_corporations already has sector, so skip that column

-- === entity_nonprofits extensions ===
ALTER TABLE entity_nonprofits
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS irs_990_top_compensation JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS last_enriched_at TIMESTAMPTZ;
-- Note: entity_nonprofits already has total_revenue and total_expenses from migration 024

-- === entity_foreign_principals extensions (FARA) ===
ALTER TABLE entity_foreign_principals
  ADD COLUMN IF NOT EXISTS fara_registration_date DATE,
  ADD COLUMN IF NOT EXISTS fara_termination_date DATE,
  ADD COLUMN IF NOT EXISTS fara_payment_total NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS fara_activities TEXT,
  ADD COLUMN IF NOT EXISTS fara_foreign_govt_contacts TEXT[],
  ADD COLUMN IF NOT EXISTS last_enriched_at TIMESTAMPTZ;

-- === entity_lobbying_firms extensions ===
ALTER TABLE entity_lobbying_firms
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS founded_date DATE,
  ADD COLUMN IF NOT EXISTS headquarters TEXT,
  ADD COLUMN IF NOT EXISTS last_enriched_at TIMESTAMPTZ;

-- === entity_flags table (queryable structured flags) ===
CREATE TYPE flag_type AS ENUM (
  'sanction', 'pep', 'offshore', 'watchlist', 'foreign_agent'
);

CREATE TABLE entity_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  flag_type flag_type NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT,
  list_name TEXT,
  reason TEXT,
  jurisdiction TEXT,
  date_added DATE,
  date_removed DATE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_entity_flags_entity_id ON entity_flags(entity_id);
CREATE INDEX idx_entity_flags_flag_type ON entity_flags(flag_type);
CREATE UNIQUE INDEX idx_entity_flags_dedup ON entity_flags(entity_id, flag_type, source, source_id);

-- === enrichment_runs table ===
CREATE TABLE enrichment_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  entities_processed INT DEFAULT 0,
  entities_enriched INT DEFAULT 0,
  entities_skipped INT DEFAULT 0,
  errors INT DEFAULT 0,
  error_details JSONB DEFAULT '[]',
  duration_ms INT
);

CREATE INDEX idx_enrichment_runs_source ON enrichment_runs(source);

-- === enrichment_errors table ===
CREATE TABLE enrichment_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES enrichment_runs(id) ON DELETE CASCADE,
  entity_id UUID REFERENCES entities(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  error_message TEXT NOT NULL,
  retry_count INT DEFAULT 0,
  resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_enrichment_errors_entity ON enrichment_errors(entity_id);
CREATE INDEX idx_enrichment_errors_unresolved ON enrichment_errors(resolved) WHERE resolved = false;

-- === entity_merge_candidates table (for manual review) ===
CREATE TABLE entity_merge_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  confidence_score NUMERIC(3,2) NOT NULL,
  matching_signals JSONB NOT NULL DEFAULT '{}',
  reviewed BOOLEAN DEFAULT false,
  reviewer_decision TEXT, -- 'merge', 'distinct', 'skip'
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX idx_merge_candidates_pair
  ON entity_merge_candidates(source_entity_id, target_entity_id);
```

- [ ] **Step 2: Apply migration locally**

Run: `npx supabase db push` or `npx supabase migration up`
Expected: Migration applies without errors

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/025_enrichment_schema.sql
git commit -m "feat: add enrichment schema - entity extensions, flags, runs, merge candidates"
```

### Task 2: Migration 026 — New relationship types

**Files:**
- Create: `supabase/migrations/026_enrichment_relationship_types.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 026_enrichment_relationship_types.sql
-- Add new relationship types for enrichment data

ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'subsidiary_of';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'sanctioned_by';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'offshore_entity_of';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'foreign_agent_for';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'contracted_with';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'sub_contracted_to';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'funded_by';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'acquired';

-- Also add types from migration 021 that may be missing in some environments
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'educated_at';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'fellow_of';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'member_of';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'family_of';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'owns';
```

- [ ] **Step 2: Apply migration locally**

Run: `npx supabase db push`
Expected: Migration applies. Note: `ADD VALUE IF NOT EXISTS` is safe for re-runs.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/026_enrichment_relationship_types.sql
git commit -m "feat: add enrichment relationship types - subsidiary, sanctions, offshore, contracts"
```

### Task 3: Migration 027 — Enrichment materialized views

**Files:**
- Create: `supabase/migrations/027_enrichment_materialized_views.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 027_enrichment_materialized_views.sql

-- === mv_entity_red_flags ===
-- Union of conflict_alerts + entity_flags for unified red flag display
CREATE MATERIALIZED VIEW mv_entity_red_flags AS
SELECT entity_id, flag_type, description, severity_score, detected_at, source_table, source_id
FROM (
  SELECT
    official_id::uuid AS entity_id,
    alert_type::text AS flag_type,
    description,
    severity_score,
    detected_at,
    'conflict_alert' AS source_table,
    id AS source_id
  FROM conflict_alerts
  WHERE status = 'active'

  UNION ALL

  SELECT
    entity_id,
    flag_type::text AS flag_type,
    reason AS description,
    CASE flag_type
      WHEN 'sanction' THEN 9.0
      WHEN 'offshore' THEN 7.0
      WHEN 'foreign_agent' THEN 6.0
      WHEN 'watchlist' THEN 5.0
      WHEN 'pep' THEN 3.0
    END AS severity_score,
    created_at AS detected_at,
    'entity_flag' AS source_table,
    id AS source_id
  FROM entity_flags
  WHERE date_removed IS NULL
) combined
ORDER BY severity_score DESC;

CREATE UNIQUE INDEX idx_mv_red_flags_pk ON mv_entity_red_flags(source_table, source_id);
CREATE INDEX idx_mv_red_flags_entity ON mv_entity_red_flags(entity_id);

-- === mv_entity_metrics ===
-- Monthly aggregates over trailing 24 months per entity for sparklines
CREATE MATERIALIZED VIEW mv_entity_metrics AS
WITH months AS (
  SELECT generate_series(
    date_trunc('month', now()) - interval '23 months',
    date_trunc('month', now()),
    interval '1 month'
  )::date AS month
),
donation_metrics AS (
  SELECT
    recipient_entity_id AS entity_id,
    date_trunc('month', contribution_date)::date AS month,
    COUNT(*) AS donation_count,
    COALESCE(SUM(amount), 0) AS donation_total
  FROM contributions
  WHERE contribution_date >= now() - interval '24 months'
  GROUP BY 1, 2
),
trade_metrics AS (
  SELECT
    o.entity_id,
    date_trunc('month', st.trade_date)::date AS month,
    COUNT(*) AS trade_count
  FROM stock_trades st
  JOIN officials o ON o.id = st.official_id
  WHERE st.trade_date >= now() - interval '24 months'
  GROUP BY 1, 2
)
SELECT
  e.id AS entity_id,
  m.month,
  COALESCE(dm.donation_count, 0) AS donation_count,
  COALESCE(dm.donation_total, 0) AS donation_total,
  COALESCE(tm.trade_count, 0) AS trade_count
FROM entities e
CROSS JOIN months m
LEFT JOIN donation_metrics dm ON dm.entity_id = e.id AND dm.month = m.month
LEFT JOIN trade_metrics tm ON tm.entity_id = e.id AND tm.month = m.month
WHERE e.entity_type IN ('person', 'corporation', 'pac', 'super_pac');

CREATE UNIQUE INDEX idx_mv_entity_metrics_pk ON mv_entity_metrics(entity_id, month);
CREATE INDEX idx_mv_entity_metrics_entity ON mv_entity_metrics(entity_id);
CREATE INDEX idx_mv_entity_metrics_month ON mv_entity_metrics(month);

-- === mv_anomaly_scores ===
-- Percentile ranks within cohorts (distribution-agnostic)
CREATE MATERIALIZED VIEW mv_anomaly_scores AS
WITH entity_totals AS (
  SELECT
    e.id AS entity_id,
    e.entity_type,
    COALESCE(SUM(c.amount), 0) AS total_donations_received,
    COUNT(DISTINCT c.id) AS donor_count,
    COUNT(DISTINCT ef.id) AS flag_count
  FROM entities e
  LEFT JOIN contributions c ON c.recipient_entity_id = e.id
  LEFT JOIN entity_flags ef ON ef.entity_id = e.id AND ef.date_removed IS NULL
  GROUP BY e.id, e.entity_type
)
SELECT
  entity_id,
  entity_type,
  total_donations_received,
  donor_count,
  flag_count,
  PERCENT_RANK() OVER (PARTITION BY entity_type ORDER BY total_donations_received) AS donations_percentile,
  PERCENT_RANK() OVER (PARTITION BY entity_type ORDER BY donor_count) AS donor_count_percentile,
  PERCENT_RANK() OVER (PARTITION BY entity_type ORDER BY flag_count) AS flag_count_percentile
FROM entity_totals;

CREATE UNIQUE INDEX idx_mv_anomaly_entity ON mv_anomaly_scores(entity_id);

-- === mv_comparison_medians ===
-- Median values per metric per entity_type for comparison anchoring
CREATE MATERIALIZED VIEW mv_comparison_medians AS
SELECT
  entity_type,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_donations_received) AS median_donations,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY donor_count) AS median_donor_count,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY flag_count) AS median_flag_count
FROM mv_anomaly_scores
GROUP BY entity_type;

CREATE UNIQUE INDEX idx_mv_comparison_medians_type ON mv_comparison_medians(entity_type);

-- === mv_entity_timeline ===
-- Merged chronological feed for narrative timeline component
CREATE MATERIALIZED VIEW mv_entity_timeline AS
SELECT entity_id, event_date, event_type, summary, metadata, source_table, source_id
FROM (
  -- Career/education relationships
  SELECT
    r.source_entity_id AS entity_id,
    COALESCE(r.date_start, r.date_end) AS event_date,
    r.relationship_type::text AS event_type,
    e2.name AS summary,
    r.metadata,
    'relationships' AS source_table,
    r.id AS source_id
  FROM relationships r
  JOIN entities e2 ON e2.id = r.target_entity_id
  WHERE r.relationship_type IN ('employed_by', 'educated_at', 'board_member', 'member_of', 'fellow_of')

  UNION ALL

  -- Campaign contributions received
  SELECT
    c.recipient_entity_id AS entity_id,
    c.contribution_date AS event_date,
    'contribution_received' AS event_type,
    'Contribution from ' || COALESCE(e.name, 'unknown') AS summary,
    jsonb_build_object('amount', c.amount, 'type', c.contribution_type) AS metadata,
    'contributions' AS source_table,
    c.id AS source_id
  FROM contributions c
  LEFT JOIN entities e ON e.id = c.donor_entity_id

  UNION ALL

  -- Stock trades
  SELECT
    o.entity_id,
    st.trade_date AS event_date,
    'stock_trade' AS event_type,
    st.trade_type || ' ' || st.ticker || ' (' || st.asset_name || ')' AS summary,
    jsonb_build_object('amount_low', st.amount_range_low, 'amount_high', st.amount_range_high, 'days_late', st.days_late) AS metadata,
    'stock_trades' AS source_table,
    st.id AS source_id
  FROM stock_trades st
  JOIN officials o ON o.id = st.official_id
) combined
WHERE event_date IS NOT NULL
ORDER BY event_date DESC;

CREATE INDEX idx_mv_timeline_entity ON mv_entity_timeline(entity_id);
CREATE INDEX idx_mv_timeline_date ON mv_entity_timeline(event_date DESC);
CREATE UNIQUE INDEX idx_mv_timeline_pk ON mv_entity_timeline(source_table, source_id);

-- === mv_sector_money_flows ===
-- Industry → PAC → official aggregation for Sankey diagrams
CREATE MATERIALIZED VIEW mv_sector_money_flows AS
SELECT
  ec.industry AS sector,
  ec.sector AS sector_group,
  donor.id AS donor_entity_id,
  donor.name AS donor_name,
  recipient.id AS recipient_entity_id,
  recipient.name AS recipient_name,
  recipient.entity_type AS recipient_type,
  SUM(c.amount) AS total_amount,
  COUNT(c.id) AS contribution_count,
  MIN(c.contribution_date) AS first_contribution,
  MAX(c.contribution_date) AS last_contribution
FROM contributions c
JOIN entities donor ON donor.id = c.donor_entity_id
JOIN entities recipient ON recipient.id = c.recipient_entity_id
LEFT JOIN entity_corporations ec ON ec.entity_id = donor.id
WHERE ec.industry IS NOT NULL
GROUP BY ec.industry, ec.sector, donor.id, donor.name, recipient.id, recipient.name, recipient.entity_type
HAVING SUM(c.amount) > 1000;

CREATE INDEX idx_mv_sector_flows_sector ON mv_sector_money_flows(sector);
CREATE INDEX idx_mv_sector_flows_recipient ON mv_sector_money_flows(recipient_entity_id);
CREATE UNIQUE INDEX idx_mv_sector_flows_pk ON mv_sector_money_flows(donor_entity_id, recipient_entity_id);

-- === Update refresh_all_materialized_views() ===
CREATE OR REPLACE FUNCTION refresh_all_materialized_views()
RETURNS void AS $$
BEGIN
  -- Existing views (from migration 022)
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_official_top_donors;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_official_industry_funding;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_stock_trade_alerts;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_lobbying_summary;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_politician_trade_summary;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_committee_stock_overlap;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_late_trade_filings;
  -- New enrichment views
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_entity_red_flags;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_entity_metrics;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_anomaly_scores;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_comparison_medians;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_entity_timeline;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_sector_money_flows;
END;
$$ LANGUAGE plpgsql;
```

- [ ] **Step 2: Apply migration locally**

Run: `npx supabase db push`
Expected: Migration applies. Materialized views created (empty until data exists).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/027_enrichment_materialized_views.sql
git commit -m "feat: add enrichment materialized views - red flags, metrics, anomaly scores"
```

---

## Chunk 2: API Clients

### Task 4: Wikidata API Client

**Files:**
- Create: `scripts/pipeline/clients/wikidata.ts`

- [ ] **Step 1: Write the Wikidata client**

```typescript
// scripts/pipeline/clients/wikidata.ts

const WIKIDATA_API_URL = 'https://www.wikidata.org/w/api.php';
const WIKIDATA_SPARQL_URL = 'https://query.wikidata.org/sparql';

export interface WikidataEntity {
  id: string; // Q-id
  labels: Record<string, { value: string }>;
  descriptions: Record<string, { value: string }>;
  claims: Record<string, WikidataClaim[]>;
  sitelinks?: Record<string, { title: string; url?: string }>;
}

export interface WikidataClaim {
  mainsnak: {
    datatype: string;
    datavalue?: {
      type: string;
      value: any;
    };
  };
  qualifiers?: Record<string, WikidataClaim['mainsnak'][]>;
}

export interface WikidataSearchResult {
  id: string;
  label: string;
  description: string;
}

export interface ParsedWikidataProfile {
  wikidataId: string;
  name: string;
  description: string | null;
  birthDate: string | null;
  birthPlace: string | null;
  education: { institution: string; degree: string | null; field: string | null; year: number | null }[];
  positions: { org: string; role: string; start: string | null; end: string | null; isGovernment: boolean }[];
  spouseName: string | null;
  photoUrl: string | null;
  externalIds: {
    bioguideId?: string;
    fecId?: string;
    opensecrets_id?: string;
    linkedin_url?: string;
    ballotpedia_url?: string;
    wikipedia_url?: string;
  };
}

// Wikidata property IDs
const PROPS = {
  INSTANCE_OF: 'P31',
  DATE_OF_BIRTH: 'P569',
  PLACE_OF_BIRTH: 'P19',
  EDUCATED_AT: 'P69',
  POSITION_HELD: 'P39',
  EMPLOYER: 'P108',
  SPOUSE: 'P26',
  IMAGE: 'P18',
  BIOGUIDE_ID: 'P1157',
  FEC_ID: 'P4887',
  OPENSECRETS_ID: 'P2686',
  LINKEDIN_ID: 'P6634',
  BALLOTPEDIA_ID: 'P2390',
  START_TIME: 'P580',
  END_TIME: 'P582',
  ACADEMIC_DEGREE: 'P512',
  ACADEMIC_MAJOR: 'P812',
} as const;

export class WikidataClient {
  private delayMs: number;

  constructor(delayMs: number = 200) {
    this.delayMs = delayMs;
  }

  private async delay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  async searchEntities(query: string, type: 'item' = 'item', limit: number = 5): Promise<WikidataSearchResult[]> {
    await this.delay();
    const params = new URLSearchParams({
      action: 'wbsearchentities',
      search: query,
      language: 'en',
      format: 'json',
      type,
      limit: String(limit),
    });
    const response = await fetch(`${WIKIDATA_API_URL}?${params}`);
    if (!response.ok) throw new Error(`Wikidata search failed: ${response.status}`);
    const data = await response.json();
    return (data.search ?? []).map((r: any) => ({
      id: r.id,
      label: r.label,
      description: r.description ?? '',
    }));
  }

  async getEntity(qid: string): Promise<WikidataEntity | null> {
    await this.delay();
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: qid,
      languages: 'en',
      format: 'json',
    });
    const response = await fetch(`${WIKIDATA_API_URL}?${params}`);
    if (!response.ok) throw new Error(`Wikidata fetch failed: ${response.status}`);
    const data = await response.json();
    return data.entities?.[qid] ?? null;
  }

  async getEntitiesBatch(qids: string[]): Promise<Map<string, WikidataEntity>> {
    const results = new Map<string, WikidataEntity>();
    // Wikidata allows up to 50 IDs per request
    for (let i = 0; i < qids.length; i += 50) {
      await this.delay();
      const batch = qids.slice(i, i + 50);
      const params = new URLSearchParams({
        action: 'wbgetentities',
        ids: batch.join('|'),
        languages: 'en',
        format: 'json',
      });
      const response = await fetch(`${WIKIDATA_API_URL}?${params}`);
      if (!response.ok) throw new Error(`Wikidata batch fetch failed: ${response.status}`);
      const data = await response.json();
      for (const [qid, entity] of Object.entries(data.entities ?? {})) {
        results.set(qid, entity as WikidataEntity);
      }
    }
    return results;
  }

  async findByExternalId(property: string, value: string): Promise<string | null> {
    await this.delay();
    const sparql = `SELECT ?item WHERE { ?item wdt:${property} "${value}". } LIMIT 1`;
    const params = new URLSearchParams({ query: sparql, format: 'json' });
    const response = await fetch(`${WIKIDATA_SPARQL_URL}?${params}`, {
      headers: { 'Accept': 'application/sparql-results+json' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    const bindings = data.results?.bindings ?? [];
    if (bindings.length === 0) return null;
    const uri = bindings[0].item?.value ?? '';
    return uri.split('/').pop() ?? null;
  }

  parseProfile(entity: WikidataEntity): ParsedWikidataProfile {
    const claims = entity.claims;

    const getStringClaim = (prop: string): string | null => {
      const claim = claims[prop]?.[0];
      return claim?.mainsnak?.datavalue?.value ?? null;
    };

    const getTimeClaim = (prop: string): string | null => {
      const claim = claims[prop]?.[0];
      const time = claim?.mainsnak?.datavalue?.value?.time;
      return time ? time.replace(/^\+/, '').split('T')[0] : null;
    };

    const getQualifierTime = (claim: WikidataClaim, prop: string): string | null => {
      const qual = claim.qualifiers?.[prop]?.[0];
      const time = qual?.datavalue?.value?.time;
      return time ? time.replace(/^\+/, '').split('T')[0] : null;
    };

    // Education
    const education = (claims[PROPS.EDUCATED_AT] ?? []).map((claim) => {
      const inst = claim.mainsnak?.datavalue?.value?.id;
      const degree = claim.qualifiers?.[PROPS.ACADEMIC_DEGREE]?.[0]?.datavalue?.value?.id ?? null;
      const field = claim.qualifiers?.[PROPS.ACADEMIC_MAJOR]?.[0]?.datavalue?.value?.id ?? null;
      const endTime = getQualifierTime(claim, PROPS.END_TIME);
      return {
        institution: inst ?? 'Unknown',
        degree,
        field,
        year: endTime ? parseInt(endTime.split('-')[0], 10) : null,
      };
    });

    // Positions held
    const positions = (claims[PROPS.POSITION_HELD] ?? []).concat(claims[PROPS.EMPLOYER] ?? []).map((claim) => {
      const org = claim.mainsnak?.datavalue?.value?.id ?? 'Unknown';
      const start = getQualifierTime(claim, PROPS.START_TIME);
      const end = getQualifierTime(claim, PROPS.END_TIME);
      return {
        org,
        role: claim.mainsnak?.datavalue?.value?.id ?? '',
        start,
        end,
        isGovernment: false, // Will be resolved later by checking org entity type
      };
    });

    // Photo URL from Wikimedia Commons
    const imageFile = getStringClaim(PROPS.IMAGE);
    const photoUrl = imageFile
      ? `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(imageFile)}?width=400`
      : null;

    // External IDs
    const externalIds: ParsedWikidataProfile['externalIds'] = {};
    const bioguide = getStringClaim(PROPS.BIOGUIDE_ID);
    if (bioguide) externalIds.bioguideId = bioguide;
    const fec = getStringClaim(PROPS.FEC_ID);
    if (fec) externalIds.fecId = fec;
    const opensecrets = getStringClaim(PROPS.OPENSECRETS_ID);
    if (opensecrets) externalIds.opensecrets_id = opensecrets;
    const linkedin = getStringClaim(PROPS.LINKEDIN_ID);
    if (linkedin) externalIds.linkedin_url = `https://www.linkedin.com/in/${linkedin}`;
    const ballotpedia = getStringClaim(PROPS.BALLOTPEDIA_ID);
    if (ballotpedia) externalIds.ballotpedia_url = `https://ballotpedia.org/${encodeURIComponent(ballotpedia)}`;

    // Wikipedia URL from sitelinks
    const enwiki = entity.sitelinks?.['enwiki'];
    if (enwiki) {
      externalIds.wikipedia_url = `https://en.wikipedia.org/wiki/${encodeURIComponent(enwiki.title)}`;
    }

    return {
      wikidataId: entity.id,
      name: entity.labels?.en?.value ?? '',
      description: entity.descriptions?.en?.value ?? null,
      birthDate: getTimeClaim(PROPS.DATE_OF_BIRTH),
      birthPlace: claims[PROPS.PLACE_OF_BIRTH]?.[0]?.mainsnak?.datavalue?.value?.id ?? null,
      education,
      positions,
      spouseName: claims[PROPS.SPOUSE]?.[0]?.mainsnak?.datavalue?.value?.id ?? null,
      photoUrl,
      externalIds,
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pipeline/clients/wikidata.ts
git commit -m "feat: add Wikidata API client with SPARQL support and profile parsing"
```

### Task 5: OpenCorporates API Client

**Files:**
- Create: `scripts/pipeline/clients/opencorporates.ts`

- [ ] **Step 1: Write the OpenCorporates client**

```typescript
// scripts/pipeline/clients/opencorporates.ts

const OC_BASE_URL = 'https://api.opencorporates.com/v0.4';

export interface OCCompany {
  company_number: string;
  name: string;
  jurisdiction_code: string;
  incorporation_date: string | null;
  dissolution_date: string | null;
  company_type: string | null;
  registered_address_in_full: string | null;
  registry_url: string | null;
  industry_codes: { code: string; description: string; code_scheme_id: string }[];
  officers: OCOfficer[];
}

export interface OCOfficer {
  id: number;
  name: string;
  position: string;
  start_date: string | null;
  end_date: string | null;
  occupation: string | null;
  nationality: string | null;
}

export interface OCSearchResult {
  company: OCCompany;
}

export class OpenCorporatesClient {
  private apiToken: string | undefined;
  private delayMs: number;

  constructor(apiToken?: string, delayMs: number = 1000) {
    this.apiToken = apiToken ?? process.env.OPENCORPORATES_API_TOKEN;
    this.delayMs = delayMs; // Free tier: ~200/day, be conservative
  }

  private async delay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  private buildUrl(endpoint: string, params: Record<string, string> = {}): string {
    const url = new URL(`${OC_BASE_URL}${endpoint}`);
    if (this.apiToken) params['api_token'] = this.apiToken;
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private async fetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T | null> {
    await this.delay();
    const url = this.buildUrl(endpoint, params);
    const response = await fetch(url);
    if (response.status === 404) return null;
    if (response.status === 429) throw new Error('OpenCorporates rate limit exceeded');
    if (!response.ok) throw new Error(`OpenCorporates API error: ${response.status}`);
    const data = await response.json();
    return data.results as T;
  }

  async searchCompanies(query: string, jurisdictionCode?: string): Promise<OCSearchResult[]> {
    const params: Record<string, string> = { q: query, per_page: '10' };
    if (jurisdictionCode) params['jurisdiction_code'] = jurisdictionCode;
    const data = await this.fetch<{ companies: OCSearchResult[] }>('/companies/search', params);
    return data?.companies ?? [];
  }

  async getCompany(jurisdictionCode: string, companyNumber: string): Promise<OCCompany | null> {
    const data = await this.fetch<{ company: OCCompany }>(
      `/companies/${jurisdictionCode}/${companyNumber}`
    );
    return data?.company ?? null;
  }

  async getOfficers(jurisdictionCode: string, companyNumber: string): Promise<OCOfficer[]> {
    const data = await this.fetch<{ officers: { officer: OCOfficer }[] }>(
      `/companies/${jurisdictionCode}/${companyNumber}/officers`
    );
    return (data?.officers ?? []).map((o) => o.officer);
  }

  async searchOfficers(query: string): Promise<{ officer: OCOfficer; company: { name: string; company_number: string; jurisdiction_code: string } }[]> {
    const data = await this.fetch<{ officers: any[] }>('/officers/search', { q: query, per_page: '10' });
    return data?.officers ?? [];
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pipeline/clients/opencorporates.ts
git commit -m "feat: add OpenCorporates API client with company and officer search"
```

### Task 6: Crunchbase Basic API Client

**Files:**
- Create: `scripts/pipeline/clients/crunchbase.ts`

- [ ] **Step 1: Write the Crunchbase client**

```typescript
// scripts/pipeline/clients/crunchbase.ts

const CB_BASE_URL = 'https://api.crunchbase.com/api/v4';

export interface CrunchbaseOrg {
  uuid: string;
  properties: {
    identifier: { permalink: string; value: string };
    short_description: string | null;
    description: string | null;
    founded_on: string | null;
    num_employees_enum: string | null;
    categories: { value: string }[];
    location_identifiers: { value: string; location_type: string }[];
    revenue_range: string | null;
    funding_total: { value: number; currency: string } | null;
    num_funding_rounds: number | null;
    ipo_status: string | null;
    website_url: string | null;
  };
}

export interface CrunchbasePerson {
  uuid: string;
  properties: {
    identifier: { permalink: string; value: string };
    first_name: string;
    last_name: string;
    description: string | null;
    gender: string | null;
    linkedin: string | null;
  };
}

export class CrunchbaseClient {
  private apiKey: string;
  private callsThisMonth: number;
  private maxCallsPerMonth: number;

  constructor(apiKey?: string, maxCallsPerMonth: number = 200) {
    this.apiKey = apiKey ?? process.env.CRUNCHBASE_API_KEY ?? '';
    if (!this.apiKey) throw new Error('Missing CRUNCHBASE_API_KEY environment variable');
    this.callsThisMonth = 0;
    this.maxCallsPerMonth = maxCallsPerMonth;
  }

  private checkBudget(): void {
    if (this.callsThisMonth >= this.maxCallsPerMonth) {
      throw new Error(`Crunchbase monthly budget exhausted (${this.maxCallsPerMonth} calls)`);
    }
  }

  private async fetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T | null> {
    this.checkBudget();
    this.callsThisMonth++;
    const url = new URL(`${CB_BASE_URL}${endpoint}`);
    url.searchParams.set('user_key', this.apiKey);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url.toString());
    if (response.status === 404) return null;
    if (response.status === 401) throw new Error('Crunchbase API key invalid or expired');
    if (response.status === 429) throw new Error('Crunchbase rate limit exceeded');
    if (!response.ok) throw new Error(`Crunchbase API error: ${response.status}`);
    return response.json();
  }

  async getOrganization(permalink: string): Promise<CrunchbaseOrg | null> {
    return this.fetch<CrunchbaseOrg>(`/entities/organizations/${permalink}`, {
      field_ids: 'identifier,short_description,description,founded_on,num_employees_enum,categories,location_identifiers,revenue_range,funding_total,num_funding_rounds,ipo_status,website_url',
    });
  }

  async searchOrganizations(query: string, limit: number = 5): Promise<CrunchbaseOrg[]> {
    const data = await this.fetch<{ entities: CrunchbaseOrg[] }>('/searches/organizations', {
      query,
      limit: String(limit),
    });
    return data?.entities ?? [];
  }

  getRemainingBudget(): number {
    return this.maxCallsPerMonth - this.callsThisMonth;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pipeline/clients/crunchbase.ts
git commit -m "feat: add Crunchbase Basic API client with budget tracking"
```

### Task 7: ICIJ Offshore Leaks Client (Bulk Download)

**Files:**
- Create: `scripts/pipeline/clients/icij.ts`

- [ ] **Step 1: Write the ICIJ bulk import client**

```typescript
// scripts/pipeline/clients/icij.ts
// ICIJ Offshore Leaks Database - bulk CSV download + parsing
// Data: https://offshoreleaks.icij.org/pages/database

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';

const ICIJ_DOWNLOAD_URLS = {
  nodes: 'https://offshoreleaks-data.icij.org/offshoreleaks/csv/csv_full.zip',
};

export interface ICIJNode {
  node_id: string;
  name: string;
  jurisdiction: string;
  jurisdiction_description: string;
  country_codes: string;
  countries: string;
  sourceID: string; // 'Panama Papers', 'Paradise Papers', etc.
  valid_until: string;
  note: string;
  type: 'Entity' | 'Officer' | 'Intermediary' | 'Address';
}

export interface ICIJRelationship {
  node_id_start: string;
  node_id_end: string;
  rel_type: string; // 'officer of', 'registered address', 'intermediary of', etc.
  link: string;
  start_date: string;
  end_date: string;
  sourceID: string;
}

export class ICIJClient {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async *parseNodes(filename: string): AsyncGenerator<ICIJNode> {
    const filePath = join(this.dataDir, filename);
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let headers: string[] = [];
    let isFirst = true;

    for await (const line of rl) {
      if (isFirst) {
        headers = line.split(',').map((h) => h.trim().replace(/"/g, ''));
        isFirst = false;
        continue;
      }
      const values = parseCsvLine(line);
      const record: any = {};
      headers.forEach((h, i) => {
        record[h] = values[i] ?? '';
      });
      yield record as ICIJNode;
    }
  }

  async *parseRelationships(filename: string): AsyncGenerator<ICIJRelationship> {
    const filePath = join(this.dataDir, filename);
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let headers: string[] = [];
    let isFirst = true;

    for await (const line of rl) {
      if (isFirst) {
        headers = line.split(',').map((h) => h.trim().replace(/"/g, ''));
        isFirst = false;
        continue;
      }
      const values = parseCsvLine(line);
      const record: any = {};
      headers.forEach((h, i) => {
        record[h] = values[i] ?? '';
      });
      yield record as ICIJRelationship;
    }
  }
}

// Simple CSV line parser handling quoted fields
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pipeline/clients/icij.ts
git commit -m "feat: add ICIJ Offshore Leaks bulk CSV client with streaming parser"
```

### Task 8: OpenSanctions Client (Bulk Download)

**Files:**
- Create: `scripts/pipeline/clients/opensanctions.ts`

- [ ] **Step 1: Write the OpenSanctions client**

```typescript
// scripts/pipeline/clients/opensanctions.ts
// OpenSanctions - bulk JSONL download
// Data: https://www.opensanctions.org/datasets/

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';

const OS_DATASET_URL = 'https://data.opensanctions.org/datasets/latest/default/entities.ftm.json';

export interface OpenSanctionsEntity {
  id: string;
  schema: string; // 'Person', 'Company', 'LegalEntity', etc.
  properties: {
    name?: string[];
    alias?: string[];
    birthDate?: string[];
    nationality?: string[];
    country?: string[];
    topics?: string[]; // 'sanction', 'crime', 'poi', 'pep', etc.
    description?: string[];
    wikidataId?: string[];
    sourceUrl?: string[];
    notes?: string[];
    position?: string[];
  };
  datasets: string[]; // Which sanctions lists include this entity
  first_seen: string;
  last_seen: string;
  last_change: string;
}

export class OpenSanctionsClient {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async downloadDataset(): Promise<string> {
    const filePath = join(this.dataDir, 'opensanctions-latest.json');
    const response = await fetch(OS_DATASET_URL);
    if (!response.ok) throw new Error(`OpenSanctions download failed: ${response.status}`);
    const { writeFile } = await import('fs/promises');
    const text = await response.text();
    await writeFile(filePath, text);
    return filePath;
  }

  async *parseEntities(filename: string = 'opensanctions-latest.json'): AsyncGenerator<OpenSanctionsEntity> {
    const filePath = join(this.dataDir, filename);
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line) as OpenSanctionsEntity;
      } catch {
        // Skip malformed lines
      }
    }
  }

  isPerson(entity: OpenSanctionsEntity): boolean {
    return entity.schema === 'Person';
  }

  isCompany(entity: OpenSanctionsEntity): boolean {
    return ['Company', 'LegalEntity', 'Organization'].includes(entity.schema);
  }

  isSanctioned(entity: OpenSanctionsEntity): boolean {
    return entity.properties.topics?.includes('sanction') ?? false;
  }

  isPEP(entity: OpenSanctionsEntity): boolean {
    return entity.properties.topics?.includes('pep') ?? false;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pipeline/clients/opensanctions.ts
git commit -m "feat: add OpenSanctions bulk JSONL client with streaming parser"
```

### Task 9: Ballotpedia, OpenSecrets, and USAspending Clients

**Files:**
- Create: `scripts/pipeline/clients/ballotpedia.ts`
- Create: `scripts/pipeline/clients/opensecrets.ts`
- Create: `scripts/pipeline/clients/usaspending.ts`

- [ ] **Step 1: Write the Ballotpedia client**

```typescript
// scripts/pipeline/clients/ballotpedia.ts

const BP_BASE_URL = 'https://api4.ballotpedia.org/data';

export interface BallotpediaCandidate {
  id: number;
  name: string;
  first_name: string;
  last_name: string;
  party: string;
  url: string;
  photo_url: string | null;
  office: { name: string; level: string; branch: string };
  election_history: { year: number; office: string; result: string; votes: number; percentage: number }[];
}

export class BallotpediaClient {
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.BALLOTPEDIA_API_KEY ?? '';
  }

  private async fetch<T>(endpoint: string, params: Record<string, string> = {}): Promise<T | null> {
    const url = new URL(`${BP_BASE_URL}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url.toString(), {
      headers: this.apiKey ? { 'x-api-key': this.apiKey } : {},
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Ballotpedia API error: ${response.status}`);
    return response.json();
  }

  async searchCandidates(name: string): Promise<BallotpediaCandidate[]> {
    const data = await this.fetch<{ data: BallotpediaCandidate[] }>('/officeholder_search', {
      name,
    });
    return data?.data ?? [];
  }

  async getElectionsByZip(zip: string): Promise<any> {
    return this.fetch('/elections_by_zip', { zip });
  }
}
```

- [ ] **Step 2: Write the OpenSecrets bulk client**

```typescript
// scripts/pipeline/clients/opensecrets.ts
// OpenSecrets bulk data download + parsing
// Bulk data: https://www.opensecrets.org/open-data/bulk-data

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';

export interface OpenSecretsRevolvingDoor {
  member_name: string;
  congress_id: string;
  from_org: string;
  to_org: string;
  from_title: string;
  to_title: string;
  year: number;
  direction: 'to_k_street' | 'to_government';
}

export interface OpenSecretsPFD {
  member_name: string;
  congress_id: string;
  year: number;
  net_worth_low: number;
  net_worth_high: number;
  assets_low: number;
  assets_high: number;
}

export class OpenSecretsClient {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  async *parseRevolvingDoor(filename: string): AsyncGenerator<OpenSecretsRevolvingDoor> {
    const filePath = join(this.dataDir, filename);
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let headers: string[] = [];
    let isFirst = true;

    for await (const line of rl) {
      if (isFirst) {
        headers = line.split('\t').map((h) => h.trim());
        isFirst = false;
        continue;
      }
      const values = line.split('\t');
      const record: any = {};
      headers.forEach((h, i) => {
        record[h] = values[i]?.trim() ?? '';
      });
      yield record as OpenSecretsRevolvingDoor;
    }
  }

  async *parsePersonalFinances(filename: string): AsyncGenerator<OpenSecretsPFD> {
    const filePath = join(this.dataDir, filename);
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let headers: string[] = [];
    let isFirst = true;

    for await (const line of rl) {
      if (isFirst) {
        headers = line.split('\t').map((h) => h.trim());
        isFirst = false;
        continue;
      }
      const values = line.split('\t');
      const record: any = {};
      headers.forEach((h, i) => {
        record[h] = values[i]?.trim() ?? '';
      });
      yield record as OpenSecretsPFD;
    }
  }
}
```

- [ ] **Step 3: Write the USAspending sub-awards client**

```typescript
// scripts/pipeline/clients/usaspending.ts

const USA_BASE_URL = 'https://api.usaspending.gov/api/v2';

export interface USAspendingSubAward {
  subaward_number: string;
  subawardee_name: string;
  subaward_amount: number;
  subaward_action_date: string;
  prime_award_piid: string;
  prime_awardee_name: string;
  awarding_agency_name: string;
  awarding_sub_agency_name: string;
  naics_code: string;
  naics_description: string;
}

export interface USAspendingContract {
  Award_ID: string;
  recipient_name: string;
  total_obligation: number;
  awarding_agency_name: string;
  period_of_performance_start_date: string;
  period_of_performance_current_end_date: string;
  naics_code: string;
}

export class USAspendingClient {
  private delayMs: number;

  constructor(delayMs: number = 500) {
    this.delayMs = delayMs;
  }

  private async delay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  async searchSubAwards(keyword: string, page: number = 1): Promise<{
    results: USAspendingSubAward[];
    hasNext: boolean;
  }> {
    await this.delay();
    const response = await fetch(`${USA_BASE_URL}/subawards/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filters: { keywords: [keyword] },
        page,
        limit: 100,
        sort: 'subaward_amount',
        order: 'desc',
      }),
    });
    if (!response.ok) throw new Error(`USAspending API error: ${response.status}`);
    const data = await response.json();
    return {
      results: data.results ?? [],
      hasNext: data.page_metadata?.hasNext ?? false,
    };
  }

  async searchContracts(recipientName: string, page: number = 1): Promise<{
    results: USAspendingContract[];
    hasNext: boolean;
  }> {
    await this.delay();
    const response = await fetch(`${USA_BASE_URL}/search/spending_by_award/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filters: {
          recipient_search_text: [recipientName],
          award_type_codes: ['A', 'B', 'C', 'D'], // Contracts only
        },
        fields: [
          'Award_ID', 'recipient_name', 'total_obligation',
          'awarding_agency_name', 'period_of_performance_start_date',
          'period_of_performance_current_end_date', 'naics_code',
        ],
        page,
        limit: 100,
        sort: 'total_obligation',
        order: 'desc',
      }),
    });
    if (!response.ok) throw new Error(`USAspending API error: ${response.status}`);
    const data = await response.json();
    return {
      results: data.results ?? [],
      hasNext: data.page_metadata?.hasNext ?? false,
    };
  }
}
```

- [ ] **Step 4: Commit all three clients**

```bash
git add scripts/pipeline/clients/ballotpedia.ts scripts/pipeline/clients/opensecrets.ts scripts/pipeline/clients/usaspending.ts
git commit -m "feat: add Ballotpedia, OpenSecrets bulk, and USAspending API clients"
```

> **Note:** The USAspending client at `scripts/pipeline/clients/usaspending.ts` already exists. The new sub-award methods should be added to the existing client class rather than overwriting it. Add the `searchSubAwards()` and `searchContracts()` methods to the existing `USAspendingClient` class.

### Task 9b: FARA Client

**Files:**
- Create: `scripts/pipeline/clients/fara.ts`

- [ ] **Step 1: Write the FARA bulk data client**

```typescript
// scripts/pipeline/clients/fara.ts
// DOJ FARA e-filing data parser
// Data: https://efile.fara.gov/ords/fara/production/fara_efile.html

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';

export interface FARARegistrant {
  registration_number: string;
  registrant_name: string;
  address: string;
  state: string;
  registration_date: string;
  termination_date: string | null;
  status: string;
}

export interface FARAForeignPrincipal {
  registration_number: string;
  foreign_principal_name: string;
  country: string;
  principal_type: string; // 'foreign government', 'foreign political party', etc.
  date_from: string;
  date_to: string | null;
}

export interface FARAActivity {
  registration_number: string;
  registrant_name: string;
  foreign_principal_name: string;
  activity_description: string;
  political_activities: string;
  government_contacts: string[];
  total_compensation: number;
  reporting_period: string;
}

export class FARAClient {
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? process.env.FARA_DATA_DIR ?? './data/fara';
  }

  async *parseRegistrants(filename: string = 'FARA_All_Registrants.csv'): AsyncGenerator<FARARegistrant> {
    const filePath = join(this.dataDir, filename);
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let headers: string[] = [];
    let isFirst = true;

    for await (const line of rl) {
      if (isFirst) {
        headers = line.split(',').map((h) => h.trim().replace(/"/g, ''));
        isFirst = false;
        continue;
      }
      const values = parseCsvLine(line);
      const record: any = {};
      headers.forEach((h, i) => {
        record[h] = values[i] ?? '';
      });
      yield {
        registration_number: record['Registration_Number'] ?? record['registration_number'] ?? '',
        registrant_name: record['Registrant_Name'] ?? record['registrant_name'] ?? '',
        address: record['Address_1'] ?? '',
        state: record['State'] ?? '',
        registration_date: record['Registration_Date'] ?? '',
        termination_date: record['Termination_Date'] || null,
        status: record['Status'] ?? '',
      };
    }
  }

  async *parseForeignPrincipals(filename: string = 'FARA_All_ForeignPrincipals.csv'): AsyncGenerator<FARAForeignPrincipal> {
    const filePath = join(this.dataDir, filename);
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let headers: string[] = [];
    let isFirst = true;

    for await (const line of rl) {
      if (isFirst) {
        headers = line.split(',').map((h) => h.trim().replace(/"/g, ''));
        isFirst = false;
        continue;
      }
      const values = parseCsvLine(line);
      const record: any = {};
      headers.forEach((h, i) => {
        record[h] = values[i] ?? '';
      });
      yield {
        registration_number: record['Registration_Number'] ?? '',
        foreign_principal_name: record['Foreign_Principal'] ?? '',
        country: record['Country'] ?? '',
        principal_type: record['FP_Type'] ?? '',
        date_from: record['FP_Registration_Date'] ?? '',
        date_to: record['FP_Termination_Date'] || null,
      };
    }
  }
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pipeline/clients/fara.ts
git commit -m "feat: add FARA DOJ bulk data client with CSV parsing"
```

### Task 9c: FEC Bulk/EFILING Client

**Files:**
- Create: `scripts/pipeline/clients/fec-bulk.ts`

- [ ] **Step 1: Write the FEC bulk e-filing client**

```typescript
// scripts/pipeline/clients/fec-bulk.ts
// FEC bulk data for committee-to-committee transfers
// Data: https://www.fec.gov/data/browse-data/?tab=bulk-data

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { join } from 'path';

export interface FECCommitteeTransfer {
  cmte_id: string;
  cmte_name: string;
  other_id: string;
  other_name: string;
  transaction_type: string;
  transaction_amount: number;
  transaction_date: string;
  filing_id: string;
  sub_id: string;
}

export class FECBulkClient {
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? process.env.FEC_BULK_DATA_DIR ?? './data/fec-bulk';
  }

  /**
   * Parse committee-to-committee transfers from FEC bulk file (oth.txt)
   * Pipe-delimited format per FEC specification
   */
  async *parseTransfers(filename: string = 'itoth.txt'): AsyncGenerator<FECCommitteeTransfer> {
    const filePath = join(this.dataDir, filename);
    const stream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      const fields = line.split('|');
      if (fields.length < 20) continue;

      const amount = parseFloat(fields[14] ?? '0');
      if (isNaN(amount) || amount === 0) continue;

      yield {
        cmte_id: fields[0] ?? '',
        cmte_name: fields[7] ?? '',
        other_id: fields[15] ?? '',
        other_name: fields[9] ?? '',
        transaction_type: fields[5] ?? '',
        transaction_amount: amount,
        transaction_date: fields[13] ?? '',
        filing_id: fields[18] ?? '',
        sub_id: fields[20] ?? '',
      };
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pipeline/clients/fec-bulk.ts
git commit -m "feat: add FEC bulk e-filing client for committee-to-committee transfers"
```

---

## Chunk 3: Enrichment Pipelines (Phases 1-5)

### Task 10: Phase 1 — Wikidata Enrichment Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/wikidata-enrichment.ts`

- [ ] **Step 1: Write the Wikidata enrichment pipeline**

```typescript
// scripts/pipeline/pipelines/wikidata-enrichment.ts

import { BasePipeline } from '../base.js';
import { WikidataClient } from '../clients/wikidata.js';

export class WikidataEnrichmentPipeline extends BasePipeline {
  private client: WikidataClient;

  constructor() {
    super();
    this.client = new WikidataClient(200);
  }

  getName(): string {
    return 'wikidata-enrichment';
  }

  async run(): Promise<void> {
    // Fetch all entities that haven't been enriched recently (or ever)
    const { data: entities, error } = await this.supabase
      .from('entities')
      .select('id, name, entity_type, external_ids')
      .or('entity_type.eq.person,entity_type.eq.corporation,entity_type.eq.lobbying_firm')
      .order('created_at', { ascending: true });

    if (error) throw new Error(`Failed to fetch entities: ${error.message}`);
    if (!entities?.length) return;

    // Filter to those needing enrichment (no wikidata_id or stale)
    const needsEnrichment = entities.filter((e) => {
      const externalIds = (e.external_ids ?? {}) as Record<string, string>;
      return !externalIds.wikidata_id;
    });

    this.results.records_fetched = needsEnrichment.length;

    for (const entity of needsEnrichment) {
      try {
        await this.enrichEntity(entity);
      } catch (err) {
        this.results.errors.push(`${entity.name}: ${(err as Error).message}`);
      }
    }
  }

  private async enrichEntity(entity: {
    id: string;
    name: string;
    entity_type: string;
    external_ids: Record<string, string> | null;
  }): Promise<void> {
    const externalIds = entity.external_ids ?? {};

    // Step 1: Try to find by known external IDs first (deterministic)
    let wikidataId: string | null = null;

    if (externalIds.bioguide_id) {
      wikidataId = await this.client.findByExternalId('P1157', externalIds.bioguide_id);
    }
    if (!wikidataId && externalIds.fec_id) {
      wikidataId = await this.client.findByExternalId('P4887', externalIds.fec_id);
    }

    // Step 2: Fall back to name search
    if (!wikidataId) {
      const results = await this.client.searchEntities(entity.name, 'item', 3);
      if (results.length > 0) {
        // Take the first result — could be improved with disambiguation
        wikidataId = results[0].id;
      }
    }

    if (!wikidataId) {
      this.results.records_skipped++;
      return;
    }

    // Step 3: Fetch full entity data
    const wdEntity = await this.client.getEntity(wikidataId);
    if (!wdEntity) {
      this.results.records_skipped++;
      return;
    }

    const profile = this.client.parseProfile(wdEntity);

    // Step 4: Update external_ids on entities table
    const updatedExternalIds = {
      ...externalIds,
      wikidata_id: wikidataId,
      ...(profile.externalIds.wikipedia_url && { wikipedia_url: profile.externalIds.wikipedia_url }),
      ...(profile.externalIds.linkedin_url && { linkedin_url: profile.externalIds.linkedin_url }),
      ...(profile.externalIds.ballotpedia_url && { ballotpedia_url: profile.externalIds.ballotpedia_url }),
      ...(profile.externalIds.opensecrets_id && { opensecrets_id: profile.externalIds.opensecrets_id }),
    };

    await this.supabase
      .from('entities')
      .update({ external_ids: updatedExternalIds })
      .eq('id', entity.id);

    // Step 5: Update entity_persons if person
    if (entity.entity_type === 'person') {
      await this.supabase
        .from('entity_persons')
        .update({
          bio_summary: profile.description,
          birth_date: profile.birthDate,
          birth_place: profile.birthPlace,
          photo_url_fallback: profile.photoUrl,
          last_enriched_at: new Date().toISOString(),
        })
        .eq('entity_id', entity.id);
    }

    // Step 6: Create education relationships
    for (const edu of profile.education) {
      // Upsert the institution as an entity
      const instEntityId = await this.upsertEntity(
        { entity_type: 'corporation', name: edu.institution, external_ids: {} },
        'name',
        edu.institution
      );

      // Check for existing relationship
      const { data: existing } = await this.supabase
        .from('relationships')
        .select('id')
        .eq('source_entity_id', entity.id)
        .eq('target_entity_id', instEntityId)
        .eq('relationship_type', 'educated_at')
        .maybeSingle();

      if (!existing) {
        await this.supabase.from('relationships').insert({
          source_entity_id: entity.id,
          target_entity_id: instEntityId,
          relationship_type: 'educated_at',
          date_end: edu.year ? `${edu.year}-01-01` : null,
          metadata: { degree: edu.degree, field: edu.field },
          confidence_score: 0.9,
          source: `wikidata:${wikidataId}`,
        });
      }
    }

    // Step 7: Create employment/position relationships
    for (const pos of profile.positions) {
      const orgEntityId = await this.upsertEntity(
        { entity_type: 'corporation', name: pos.org, external_ids: {} },
        'name',
        pos.org
      );

      const { data: existing } = await this.supabase
        .from('relationships')
        .select('id')
        .eq('source_entity_id', entity.id)
        .eq('target_entity_id', orgEntityId)
        .eq('relationship_type', 'employed_by')
        .maybeSingle();

      if (!existing) {
        await this.supabase.from('relationships').insert({
          source_entity_id: entity.id,
          target_entity_id: orgEntityId,
          relationship_type: 'employed_by',
          date_start: pos.start,
          date_end: pos.end,
          metadata: { role: pos.role, is_government: pos.isGovernment },
          confidence_score: 0.9,
          source: `wikidata:${wikidataId}`,
        });
      }
    }

    this.results.records_updated++;
  }
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const pipeline = new WikidataEnrichmentPipeline();
  pipeline.execute().then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.errors.length > 0 ? 1 : 0);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pipeline/pipelines/wikidata-enrichment.ts
git commit -m "feat: add Wikidata enrichment pipeline - bio, education, career, external IDs"
```

### Task 11: Phase 2 — OpenCorporates Enrichment Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/opencorporates-enrichment.ts`

- [ ] **Step 1: Write the OpenCorporates pipeline**

```typescript
// scripts/pipeline/pipelines/opencorporates-enrichment.ts

import { BasePipeline } from '../base.js';
import { OpenCorporatesClient } from '../clients/opencorporates.js';

export class OpenCorporatesEnrichmentPipeline extends BasePipeline {
  private client: OpenCorporatesClient;

  constructor() {
    super();
    this.client = new OpenCorporatesClient();
  }

  getName(): string {
    return 'opencorporates-enrichment';
  }

  async run(): Promise<void> {
    // Fetch org entities needing enrichment
    const { data: entities, error } = await this.supabase
      .from('entities')
      .select('id, name, entity_type, external_ids')
      .in('entity_type', ['corporation', 'lobbying_firm', 'trade_association'])
      .order('created_at', { ascending: true });

    if (error) throw new Error(`Failed to fetch entities: ${error.message}`);
    if (!entities?.length) return;

    const needsEnrichment = entities.filter((e) => {
      const ids = (e.external_ids ?? {}) as Record<string, string>;
      return !ids.opencorporates_id;
    });

    this.results.records_fetched = needsEnrichment.length;

    for (const entity of needsEnrichment) {
      try {
        await this.enrichOrg(entity);
      } catch (err) {
        this.results.errors.push(`${entity.name}: ${(err as Error).message}`);
      }
    }
  }

  private async enrichOrg(entity: {
    id: string;
    name: string;
    entity_type: string;
    external_ids: Record<string, string> | null;
  }): Promise<void> {
    // Search OpenCorporates by name, prefer US jurisdictions
    const results = await this.client.searchCompanies(entity.name, 'us');
    if (results.length === 0) {
      this.results.records_skipped++;
      return;
    }

    // Take best match (first result from OC is relevance-ranked)
    const company = results[0].company;
    const ocId = `${company.jurisdiction_code}/${company.company_number}`;

    // Update external_ids
    const externalIds = { ...(entity.external_ids ?? {}), opencorporates_id: ocId };
    await this.supabase
      .from('entities')
      .update({ external_ids: externalIds })
      .eq('id', entity.id);

    // Update type-specific detail table
    if (entity.entity_type === 'corporation') {
      const industry = company.industry_codes?.[0];
      await this.supabase
        .from('entity_corporations')
        .update({
          description: null, // OC doesn't provide descriptions
          industry: industry?.description ?? null,
          founded_date: company.incorporation_date,
          headquarters: company.registered_address_in_full,
          last_enriched_at: new Date().toISOString(),
        })
        .eq('entity_id', entity.id);
    } else if (entity.entity_type === 'lobbying_firm') {
      await this.supabase
        .from('entity_lobbying_firms')
        .update({
          founded_date: company.incorporation_date,
          headquarters: company.registered_address_in_full,
          last_enriched_at: new Date().toISOString(),
        })
        .eq('entity_id', entity.id);
    }

    // Fetch and create officer relationships
    const officers = await this.client.getOfficers(company.jurisdiction_code, company.company_number);
    for (const officer of officers) {
      // Upsert officer as person entity
      const officerEntityId = await this.upsertEntity(
        { entity_type: 'person', name: officer.name, external_ids: {} },
        'name',
        officer.name
      );

      // Create board_member/employed_by relationship
      const relType = officer.position?.toLowerCase().includes('director') ? 'board_member' : 'employed_by';

      const { data: existing } = await this.supabase
        .from('relationships')
        .select('id')
        .eq('source_entity_id', officerEntityId)
        .eq('target_entity_id', entity.id)
        .eq('relationship_type', relType)
        .maybeSingle();

      if (!existing) {
        await this.supabase.from('relationships').insert({
          source_entity_id: officerEntityId,
          target_entity_id: entity.id,
          relationship_type: relType,
          date_start: officer.start_date,
          date_end: officer.end_date,
          metadata: {
            position: officer.position,
            nationality: officer.nationality,
            source_company: ocId,
          },
          confidence_score: 0.85,
          source: `opencorporates:${ocId}`,
        });
      }
    }

    // Create subsidiary relationships if parent exists
    // (OpenCorporates doesn't directly expose subsidiaries via basic API,
    // but the officer overlap detection in Phase 6 will catch shared directors)

    this.results.records_updated++;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pipeline = new OpenCorporatesEnrichmentPipeline();
  pipeline.execute().then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.errors.length > 0 ? 1 : 0);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pipeline/pipelines/opencorporates-enrichment.ts
git commit -m "feat: add OpenCorporates enrichment pipeline - org data and officer relationships"
```

### Task 12: Phase 2b — Crunchbase Enrichment Pipeline (Priority Queue)

**Files:**
- Create: `scripts/pipeline/pipelines/crunchbase-enrichment.ts`

- [ ] **Step 1: Write the Crunchbase priority queue pipeline**

```typescript
// scripts/pipeline/pipelines/crunchbase-enrichment.ts

import { BasePipeline } from '../base.js';
import { CrunchbaseClient } from '../clients/crunchbase.js';

export class CrunchbaseEnrichmentPipeline extends BasePipeline {
  private client: CrunchbaseClient;
  private dailyBudget: number;

  constructor() {
    super();
    this.client = new CrunchbaseClient();
    this.dailyBudget = 6; // ~200/month = 6/day
  }

  getName(): string {
    return 'crunchbase-enrichment';
  }

  async run(): Promise<void> {
    // Get top entities by priority score that haven't been Crunchbase-enriched
    const { data: candidates, error } = await this.supabase.rpc('exec_sql', {
      query: `
        SELECT
          e.id,
          e.name,
          e.entity_type,
          e.external_ids,
          (
            (SELECT COUNT(*) FROM relationships r WHERE r.source_entity_id = e.id OR r.target_entity_id = e.id) * 2 +
            (SELECT COUNT(*) FROM conflict_alerts ca WHERE ca.official_id::text = e.id::text) * 5
          ) AS priority_score
        FROM entities e
        WHERE e.entity_type IN ('corporation', 'lobbying_firm', 'trade_association')
          AND (e.external_ids->>'crunchbase_slug') IS NULL
        ORDER BY priority_score DESC
        LIMIT ${this.dailyBudget}
      `,
    });

    if (error) throw new Error(`Priority query failed: ${error.message}`);
    const rows = (candidates as any[]) ?? [];
    this.results.records_fetched = rows.length;

    for (const row of rows) {
      try {
        const org = await this.client.getOrganization(row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
        if (!org) {
          // Try search as fallback
          const results = await this.client.searchOrganizations(row.name, 1);
          if (results.length === 0) {
            this.results.records_skipped++;
            continue;
          }
          await this.applyOrgData(row, results[0]);
        } else {
          await this.applyOrgData(row, org);
        }
        this.results.records_updated++;
      } catch (err) {
        if ((err as Error).message.includes('budget exhausted')) {
          console.log('Crunchbase daily budget reached, stopping.');
          break;
        }
        this.results.errors.push(`${row.name}: ${(err as Error).message}`);
      }
    }

    console.log(`Crunchbase remaining budget: ${this.client.getRemainingBudget()} calls`);
  }

  private async applyOrgData(row: any, org: any): Promise<void> {
    const props = org.properties;
    const slug = props.identifier?.permalink;
    const externalIds = { ...(row.external_ids ?? {}), crunchbase_slug: slug };

    await this.supabase
      .from('entities')
      .update({ external_ids: externalIds })
      .eq('id', row.id);

    if (row.entity_type === 'corporation') {
      const hq = props.location_identifiers?.find((l: any) => l.location_type === 'city');
      await this.supabase
        .from('entity_corporations')
        .update({
          description: props.short_description ?? props.description,
          industry: props.categories?.[0]?.value ?? null,
          founded_date: props.founded_on,
          headquarters: hq?.value ?? null,
          last_enriched_at: new Date().toISOString(),
        })
        .eq('entity_id', row.id);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pipeline = new CrunchbaseEnrichmentPipeline();
  pipeline.execute().then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.errors.length > 0 ? 1 : 0);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pipeline/pipelines/crunchbase-enrichment.ts
git commit -m "feat: add Crunchbase enrichment pipeline with daily budget and priority queue"
```

### Task 13: Phase 3 — ICIJ Offshore Leaks Import Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/icij-import.ts`

- [ ] **Step 1: Write the ICIJ import pipeline**

```typescript
// scripts/pipeline/pipelines/icij-import.ts

import { BasePipeline } from '../base.js';
import { ICIJClient, ICIJNode } from '../clients/icij.js';
import { normalizeName, jaroWinkler } from '../../lib/entity-resolver.js';

const BATCH_SIZE = 1000;

export class ICIJImportPipeline extends BasePipeline {
  private client: ICIJClient;

  constructor() {
    super();
    const dataDir = process.env.ICIJ_DATA_DIR ?? './data/icij';
    this.client = new ICIJClient(dataDir);
  }

  getName(): string {
    return 'icij-offshore-leaks';
  }

  async run(): Promise<void> {
    // Step 1: Load all our entity names for matching
    const { data: ourEntities } = await this.supabase
      .from('entities')
      .select('id, name, entity_type, external_ids');

    if (!ourEntities?.length) return;

    const entityIndex = new Map<string, typeof ourEntities[0][]>();
    for (const entity of ourEntities) {
      const normalized = normalizeName(entity.name);
      const key = normalized.slice(0, 4); // First 4 chars as bucket key
      if (!entityIndex.has(key)) entityIndex.set(key, []);
      entityIndex.get(key)!.push(entity);
    }

    // Step 2: Stream through ICIJ nodes, match against our entities
    let processed = 0;
    let matched = 0;
    const batch: { entityId: string; icijNode: ICIJNode; confidence: number }[] = [];

    for await (const node of this.client.parseNodes('nodes-officers.csv')) {
      processed++;
      if (processed % 10000 === 0) {
        console.log(`ICIJ: processed ${processed} nodes, ${matched} matches`);
      }

      const normalizedName = normalizeName(node.name);
      const key = normalizedName.slice(0, 4);
      const candidates = entityIndex.get(key) ?? [];

      for (const candidate of candidates) {
        const similarity = jaroWinkler(normalizedName, normalizeName(candidate.name));
        if (similarity >= 0.88) {
          batch.push({ entityId: candidate.id, icijNode: node, confidence: similarity });
          matched++;
          break;
        }
      }

      // Flush batch
      if (batch.length >= BATCH_SIZE) {
        await this.flushBatch(batch);
        batch.length = 0;
      }
    }

    // Final flush
    if (batch.length > 0) {
      await this.flushBatch(batch);
    }

    this.results.records_fetched = processed;
    console.log(`ICIJ: ${processed} nodes processed, ${matched} matches found`);
  }

  private async flushBatch(
    batch: { entityId: string; icijNode: ICIJNode; confidence: number }[]
  ): Promise<void> {
    for (const item of batch) {
      try {
        if (item.confidence >= 0.95) {
          // High confidence — auto-create flag
          await this.createOffshoreFlag(item.entityId, item.icijNode);
          this.results.records_inserted++;
        } else {
          // Medium confidence — add to merge candidates for review
          await this.supabase.from('entity_merge_candidates').upsert(
            {
              source_entity_id: item.entityId,
              target_entity_id: item.entityId, // Self-reference for ICIJ flag candidates
              confidence_score: item.confidence,
              matching_signals: {
                icij_node_id: item.icijNode.node_id,
                icij_name: item.icijNode.name,
                icij_source: item.icijNode.sourceID,
                match_type: 'icij_offshore',
              },
            },
            { onConflict: 'source_entity_id,target_entity_id' }
          );
          this.results.records_skipped++;
        }
      } catch (err) {
        this.results.errors.push(`ICIJ node ${item.icijNode.node_id}: ${(err as Error).message}`);
      }
    }
  }

  private async createOffshoreFlag(entityId: string, node: ICIJNode): Promise<void> {
    await this.supabase.from('entity_flags').upsert(
      {
        entity_id: entityId,
        flag_type: 'offshore',
        source: 'icij',
        source_id: node.node_id,
        list_name: node.sourceID, // 'Panama Papers', 'Paradise Papers', etc.
        reason: `Linked to offshore entity in ${node.jurisdiction_description}`,
        jurisdiction: node.jurisdiction,
        metadata: {
          icij_name: node.name,
          icij_type: node.type,
          countries: node.countries,
          valid_until: node.valid_until,
        },
      },
      { onConflict: 'entity_id,flag_type,source,source_id' }
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pipeline = new ICIJImportPipeline();
  pipeline.execute().then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.errors.length > 0 ? 1 : 0);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pipeline/pipelines/icij-import.ts
git commit -m "feat: add ICIJ Offshore Leaks import pipeline with fuzzy matching"
```

### Task 14: Phase 3b — OpenSanctions Import Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/opensanctions-import.ts`

- [ ] **Step 1: Write the OpenSanctions pipeline**

```typescript
// scripts/pipeline/pipelines/opensanctions-import.ts

import { BasePipeline } from '../base.js';
import { OpenSanctionsClient, OpenSanctionsEntity } from '../clients/opensanctions.js';
import { normalizeName, jaroWinkler } from '../../lib/entity-resolver.js';

export class OpenSanctionsImportPipeline extends BasePipeline {
  private client: OpenSanctionsClient;

  constructor() {
    super();
    const dataDir = process.env.OPENSANCTIONS_DATA_DIR ?? './data/opensanctions';
    this.client = new OpenSanctionsClient(dataDir);
  }

  getName(): string {
    return 'opensanctions-import';
  }

  async run(): Promise<void> {
    // Load our entities for matching
    const { data: ourEntities } = await this.supabase
      .from('entities')
      .select('id, name, entity_type, external_ids');

    if (!ourEntities?.length) return;

    // Build lookup maps
    const byWikidataId = new Map<string, string>();
    const byName = new Map<string, { id: string; name: string }[]>();

    for (const entity of ourEntities) {
      const ids = (entity.external_ids ?? {}) as Record<string, string>;
      if (ids.wikidata_id) byWikidataId.set(ids.wikidata_id, entity.id);

      const normalized = normalizeName(entity.name);
      if (!byName.has(normalized)) byName.set(normalized, []);
      byName.get(normalized)!.push({ id: entity.id, name: entity.name });
    }

    let processed = 0;

    for await (const osEntity of this.client.parseEntities()) {
      processed++;
      if (processed % 50000 === 0) {
        console.log(`OpenSanctions: processed ${processed} entities`);
      }

      // Try Wikidata ID match first (deterministic)
      const wikidataIds = osEntity.properties.wikidataId ?? [];
      let matchedEntityId: string | null = null;

      for (const wdId of wikidataIds) {
        if (byWikidataId.has(wdId)) {
          matchedEntityId = byWikidataId.get(wdId)!;
          break;
        }
      }

      // Fall back to name match
      if (!matchedEntityId) {
        const names = [
          ...(osEntity.properties.name ?? []),
          ...(osEntity.properties.alias ?? []),
        ];
        for (const name of names) {
          const normalized = normalizeName(name);
          const candidates = byName.get(normalized);
          if (candidates?.length) {
            matchedEntityId = candidates[0].id;
            break;
          }
        }
      }

      if (!matchedEntityId) continue;

      // Create flags for matched entity
      try {
        await this.createFlags(matchedEntityId, osEntity);
        this.results.records_inserted++;
      } catch (err) {
        this.results.errors.push(`OS ${osEntity.id}: ${(err as Error).message}`);
      }
    }

    this.results.records_fetched = processed;
  }

  private async createFlags(entityId: string, osEntity: OpenSanctionsEntity): Promise<void> {
    const topics = osEntity.properties.topics ?? [];
    const datasets = osEntity.datasets;

    if (this.client.isSanctioned(osEntity)) {
      await this.supabase.from('entity_flags').upsert(
        {
          entity_id: entityId,
          flag_type: 'sanction',
          source: 'opensanctions',
          source_id: osEntity.id,
          list_name: datasets.join(', '),
          reason: osEntity.properties.description?.[0] ?? 'Sanctioned entity',
          jurisdiction: osEntity.properties.country?.[0] ?? null,
          date_added: osEntity.first_seen ? osEntity.first_seen.split('T')[0] : null,
          metadata: {
            topics,
            datasets,
            names: osEntity.properties.name,
            source_urls: osEntity.properties.sourceUrl,
          },
        },
        { onConflict: 'entity_id,flag_type,source,source_id' }
      );
    }

    if (this.client.isPEP(osEntity)) {
      await this.supabase.from('entity_flags').upsert(
        {
          entity_id: entityId,
          flag_type: 'pep',
          source: 'opensanctions',
          source_id: `${osEntity.id}-pep`,
          list_name: datasets.join(', '),
          reason: osEntity.properties.position?.[0] ?? 'Politically Exposed Person',
          jurisdiction: osEntity.properties.country?.[0] ?? null,
          date_added: osEntity.first_seen ? osEntity.first_seen.split('T')[0] : null,
          metadata: {
            topics,
            datasets,
            positions: osEntity.properties.position,
          },
        },
        { onConflict: 'entity_id,flag_type,source,source_id' }
      );
    }

    // Update external_ids
    const { data: current } = await this.supabase
      .from('entities')
      .select('external_ids')
      .eq('id', entityId)
      .single();

    if (current) {
      await this.supabase
        .from('entities')
        .update({
          external_ids: {
            ...(current.external_ids ?? {}),
            opensanctions_id: osEntity.id,
          },
        })
        .eq('id', entityId);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pipeline = new OpenSanctionsImportPipeline();
  pipeline.execute().then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.errors.length > 0 ? 1 : 0);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pipeline/pipelines/opensanctions-import.ts
git commit -m "feat: add OpenSanctions import pipeline - sanctions, PEP flags"
```

### Task 15: Phase 4 — OpenSecrets Revolving Door + Personal Finances Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/opensecrets-enrichment.ts`

- [ ] **Step 1: Write the OpenSecrets enrichment pipeline**

```typescript
// scripts/pipeline/pipelines/opensecrets-enrichment.ts

import { BasePipeline } from '../base.js';
import { OpenSecretsClient } from '../clients/opensecrets.js';
import { normalizeName, jaroWinkler } from '../../lib/entity-resolver.js';

export class OpenSecretsEnrichmentPipeline extends BasePipeline {
  private client: OpenSecretsClient;

  constructor() {
    super();
    const dataDir = process.env.OPENSECRETS_DATA_DIR ?? './data/opensecrets';
    this.client = new OpenSecretsClient(dataDir);
  }

  getName(): string {
    return 'opensecrets-enrichment';
  }

  async run(): Promise<void> {
    // Load officials for matching
    const { data: officials } = await this.supabase
      .from('officials')
      .select('id, full_name, entity_id, bioguide_id, metadata');

    if (!officials?.length) return;

    const byName = new Map<string, typeof officials[0]>();
    for (const official of officials) {
      byName.set(normalizeName(official.full_name), official);
    }

    // Process revolving door data
    console.log('Processing revolving door data...');
    let revolving_count = 0;
    for await (const record of this.client.parseRevolvingDoor('revolving-door.tsv')) {
      const normalized = normalizeName(record.member_name);
      const official = byName.get(normalized);
      if (!official?.entity_id) continue;

      try {
        // Create relationship: person employed_by from_org, then employed_by to_org
        const fromEntityId = await this.upsertEntity(
          { entity_type: 'corporation', name: record.from_org },
          'name',
          record.from_org
        );
        const toEntityId = await this.upsertEntity(
          { entity_type: 'corporation', name: record.to_org },
          'name',
          record.to_org
        );

        // The "from" relationship
        await this.supabase.from('relationships').upsert(
          {
            source_entity_id: official.entity_id,
            target_entity_id: fromEntityId,
            relationship_type: 'employed_by',
            date_end: `${record.year}-01-01`,
            metadata: {
              title: record.from_title,
              revolving_door: true,
              direction: record.direction,
            },
            confidence_score: 0.9,
            source: `opensecrets:revolving-door`,
          },
          { onConflict: 'source_entity_id,target_entity_id,relationship_type' }
        );

        // The "to" relationship
        await this.supabase.from('relationships').upsert(
          {
            source_entity_id: official.entity_id,
            target_entity_id: toEntityId,
            relationship_type: 'employed_by',
            date_start: `${record.year}-01-01`,
            metadata: {
              title: record.to_title,
              revolving_door: true,
              direction: record.direction,
            },
            confidence_score: 0.9,
            source: `opensecrets:revolving-door`,
          },
          { onConflict: 'source_entity_id,target_entity_id,relationship_type' }
        );

        revolving_count++;
      } catch (err) {
        this.results.errors.push(`Revolving door ${record.member_name}: ${(err as Error).message}`);
      }
    }
    console.log(`Revolving door: ${revolving_count} records processed`);

    // Process personal financial disclosures (net worth)
    console.log('Processing personal financial disclosures...');
    let pfd_count = 0;
    for await (const record of this.client.parsePersonalFinances('personal-finances.tsv')) {
      const normalized = normalizeName(record.member_name);
      const official = byName.get(normalized);
      if (!official?.entity_id) continue;

      try {
        await this.supabase
          .from('entity_persons')
          .update({
            net_worth_low: record.net_worth_low,
            net_worth_high: record.net_worth_high,
            last_enriched_at: new Date().toISOString(),
          })
          .eq('entity_id', official.entity_id);

        pfd_count++;
      } catch (err) {
        this.results.errors.push(`PFD ${record.member_name}: ${(err as Error).message}`);
      }
    }
    console.log(`Personal finances: ${pfd_count} records processed`);

    this.results.records_updated = revolving_count + pfd_count;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pipeline = new OpenSecretsEnrichmentPipeline();
  pipeline.execute().then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.errors.length > 0 ? 1 : 0);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pipeline/pipelines/opensecrets-enrichment.ts
git commit -m "feat: add OpenSecrets enrichment pipeline - revolving door and net worth"
```

### Task 16: Phase 5 — USAspending Sub-Awards Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/usaspending-enrichment.ts`

- [ ] **Step 1: Write the USAspending pipeline**

```typescript
// scripts/pipeline/pipelines/usaspending-enrichment.ts

import { BasePipeline } from '../base.js';
import { USAspendingClient } from '../clients/usaspending.js';
import { normalizeName } from '../../lib/entity-resolver.js';

export class USAspendingEnrichmentPipeline extends BasePipeline {
  private client: USAspendingClient;

  constructor() {
    super();
    this.client = new USAspendingClient(500);
  }

  getName(): string {
    return 'usaspending-subawards';
  }

  async run(): Promise<void> {
    // Fetch corporate entities to look up their government contracts
    const { data: entities, error } = await this.supabase
      .from('entities')
      .select('id, name, entity_type, external_ids')
      .in('entity_type', ['corporation', 'lobbying_firm', 'trade_association'])
      .is('external_ids->usaspending_checked', null); // Only unchecked entities

    if (error) throw new Error(`Failed to fetch entities: ${error.message}`);
    if (!entities?.length) return;

    this.results.records_fetched = entities.length;

    for (const entity of entities) {
      try {
        const result = await this.client.searchContracts(entity.name, 1);
        const totalObligation = result.results.reduce(
          (sum, c) => sum + (c.total_obligation ?? 0),
          0
        );

        // Update contract total
        if (entity.entity_type === 'corporation' && totalObligation > 0) {
          await this.supabase
            .from('entity_corporations')
            .update({
              govt_contract_total: Math.round(totalObligation),
              last_enriched_at: new Date().toISOString(),
            })
            .eq('entity_id', entity.id);

          // Create contracted_with relationships for top agencies
          const agencyMap = new Map<string, number>();
          for (const contract of result.results) {
            const agency = contract.awarding_agency_name;
            if (agency) {
              agencyMap.set(agency, (agencyMap.get(agency) ?? 0) + (contract.total_obligation ?? 0));
            }
          }

          for (const [agencyName, amount] of agencyMap) {
            const agencyEntityId = await this.upsertEntity(
              { entity_type: 'corporation', name: agencyName },
              'name',
              agencyName
            );

            await this.supabase.from('relationships').upsert(
              {
                source_entity_id: entity.id,
                target_entity_id: agencyEntityId,
                relationship_type: 'contracted_with',
                amount,
                metadata: { contract_count: result.results.filter((c) => c.awarding_agency_name === agencyName).length },
                confidence_score: 1.0,
                source: 'usaspending',
              },
              { onConflict: 'source_entity_id,target_entity_id,relationship_type' }
            );
          }

          this.results.records_updated++;
        } else {
          this.results.records_skipped++;
        }

        // Mark as checked
        await this.supabase
          .from('entities')
          .update({
            external_ids: {
              ...(entity.external_ids ?? {}),
              usaspending_checked: new Date().toISOString(),
            },
          })
          .eq('id', entity.id);
      } catch (err) {
        this.results.errors.push(`${entity.name}: ${(err as Error).message}`);
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pipeline = new USAspendingEnrichmentPipeline();
  pipeline.execute().then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.errors.length > 0 ? 1 : 0);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pipeline/pipelines/usaspending-enrichment.ts
git commit -m "feat: add USAspending sub-awards enrichment pipeline - government contracts"
```

### Task 16b: Phase 4b — Ballotpedia Enrichment Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/ballotpedia-enrichment.ts`

- [ ] **Step 1: Write the Ballotpedia pipeline**

```typescript
// scripts/pipeline/pipelines/ballotpedia-enrichment.ts

import { BasePipeline } from '../base.js';
import { BallotpediaClient } from '../clients/ballotpedia.js';
import { normalizeName } from '../../lib/entity-resolver.js';

export class BallotpediaEnrichmentPipeline extends BasePipeline {
  private client: BallotpediaClient;

  constructor() {
    super();
    this.client = new BallotpediaClient();
  }

  getName(): string {
    return 'ballotpedia-enrichment';
  }

  async run(): Promise<void> {
    // Fetch officials without ballotpedia_url
    const { data: officials, error } = await this.supabase
      .from('officials')
      .select('id, full_name, entity_id, metadata')
      .eq('is_current', true);

    if (error) throw new Error(`Failed to fetch officials: ${error.message}`);
    if (!officials?.length) return;

    this.results.records_fetched = officials.length;

    for (const official of officials) {
      // Check if already has ballotpedia_url
      const { data: entity } = await this.supabase
        .from('entities')
        .select('external_ids')
        .eq('id', official.entity_id)
        .single();

      const externalIds = (entity?.external_ids ?? {}) as Record<string, string>;
      if (externalIds.ballotpedia_url) {
        this.results.records_skipped++;
        continue;
      }

      try {
        const results = await this.client.searchCandidates(official.full_name);
        if (results.length === 0) {
          this.results.records_skipped++;
          continue;
        }

        const match = results[0];

        // Update external_ids with ballotpedia URL
        await this.supabase
          .from('entities')
          .update({
            external_ids: {
              ...externalIds,
              ballotpedia_url: match.url,
            },
          })
          .eq('id', official.entity_id);

        // Use photo as fallback if no existing photo
        if (match.photo_url && !externalIds.photo_url_fallback) {
          await this.supabase
            .from('entity_persons')
            .update({ photo_url_fallback: match.photo_url })
            .eq('entity_id', official.entity_id);
        }

        // Store election history as metadata
        if (match.election_history?.length) {
          await this.supabase
            .from('entities')
            .update({
              metadata: {
                ...((entity as any)?.metadata ?? {}),
                election_history: match.election_history,
              },
            })
            .eq('id', official.entity_id);
        }

        this.results.records_updated++;
      } catch (err) {
        this.results.errors.push(`${official.full_name}: ${(err as Error).message}`);
      }
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pipeline = new BallotpediaEnrichmentPipeline();
  pipeline.execute().then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.errors.length > 0 ? 1 : 0);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pipeline/pipelines/ballotpedia-enrichment.ts
git commit -m "feat: add Ballotpedia enrichment pipeline - election history and photo fallback"
```

### Task 16c: Phase 4c — FARA Enrichment Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/fara-enrichment.ts`

- [ ] **Step 1: Write the FARA pipeline**

```typescript
// scripts/pipeline/pipelines/fara-enrichment.ts

import { BasePipeline } from '../base.js';
import { FARAClient } from '../clients/fara.js';
import { normalizeName, jaroWinkler } from '../../lib/entity-resolver.js';

export class FARAEnrichmentPipeline extends BasePipeline {
  private client: FARAClient;

  constructor() {
    super();
    this.client = new FARAClient();
  }

  getName(): string {
    return 'fara-enrichment';
  }

  async run(): Promise<void> {
    // Load our lobbying_firm and lobbyist entities for matching
    const { data: entities } = await this.supabase
      .from('entities')
      .select('id, name, entity_type, external_ids')
      .in('entity_type', ['lobbying_firm', 'person', 'foreign_principal']);

    if (!entities?.length) return;

    const byName = new Map<string, typeof entities[0]>();
    for (const e of entities) {
      byName.set(normalizeName(e.name), e);
    }

    // Process registrants
    let processed = 0;
    for await (const registrant of this.client.parseRegistrants()) {
      processed++;
      const normalized = normalizeName(registrant.registrant_name);
      const match = byName.get(normalized);

      if (!match) continue;

      try {
        // Update external_ids
        await this.supabase
          .from('entities')
          .update({
            external_ids: {
              ...(match.external_ids ?? {}),
              fara_reg_id: registrant.registration_number,
            },
          })
          .eq('id', match.id);

        // Update entity_foreign_principals if it exists
        const { data: existing } = await this.supabase
          .from('entity_foreign_principals')
          .select('entity_id')
          .eq('entity_id', match.id)
          .maybeSingle();

        if (existing) {
          await this.supabase
            .from('entity_foreign_principals')
            .update({
              fara_registration_date: registrant.registration_date || null,
              fara_termination_date: registrant.termination_date,
              last_enriched_at: new Date().toISOString(),
            })
            .eq('entity_id', match.id);
        }

        // Create foreign_agent flag
        await this.supabase.from('entity_flags').upsert(
          {
            entity_id: match.id,
            flag_type: 'foreign_agent',
            source: 'fara',
            source_id: registrant.registration_number,
            reason: `Registered as foreign agent (FARA #${registrant.registration_number})`,
            date_added: registrant.registration_date || null,
            date_removed: registrant.termination_date ? registrant.termination_date : null,
            metadata: {
              status: registrant.status,
              address: registrant.address,
              state: registrant.state,
            },
          },
          { onConflict: 'entity_id,flag_type,source,source_id' }
        );

        this.results.records_updated++;
      } catch (err) {
        this.results.errors.push(`FARA ${registrant.registrant_name}: ${(err as Error).message}`);
      }
    }

    // Process foreign principals and create relationships
    for await (const fp of this.client.parseForeignPrincipals()) {
      // Find the registrant entity
      const { data: registrantEntities } = await this.supabase
        .from('entities')
        .select('id')
        .contains('external_ids', { fara_reg_id: fp.registration_number });

      if (!registrantEntities?.length) continue;

      // Upsert the foreign principal entity
      const fpEntityId = await this.upsertEntity(
        {
          entity_type: 'foreign_principal',
          name: fp.foreign_principal_name,
          external_ids: { fara_reg_id: fp.registration_number },
        },
        'name',
        fp.foreign_principal_name
      );

      // Create foreign_agent_for relationship
      const { data: existingRel } = await this.supabase
        .from('relationships')
        .select('id')
        .eq('source_entity_id', registrantEntities[0].id)
        .eq('target_entity_id', fpEntityId)
        .eq('relationship_type', 'foreign_agent_for')
        .maybeSingle();

      if (!existingRel) {
        await this.supabase.from('relationships').insert({
          source_entity_id: registrantEntities[0].id,
          target_entity_id: fpEntityId,
          relationship_type: 'foreign_agent_for',
          date_start: fp.date_from || null,
          date_end: fp.date_to,
          metadata: {
            country: fp.country,
            principal_type: fp.principal_type,
          },
          confidence_score: 1.0,
          source: `fara:${fp.registration_number}`,
        });
      }
    }

    this.results.records_fetched = processed;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pipeline = new FARAEnrichmentPipeline();
  pipeline.execute().then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.errors.length > 0 ? 1 : 0);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pipeline/pipelines/fara-enrichment.ts
git commit -m "feat: add FARA enrichment pipeline - foreign agent flags and relationships"
```

### Task 16d: Phase 5b — FEC Bulk Committee-to-Committee Transfers Pipeline

**Files:**
- Create: `scripts/pipeline/pipelines/fec-bulk-transfers.ts`

- [ ] **Step 1: Write the FEC bulk transfers pipeline**

```typescript
// scripts/pipeline/pipelines/fec-bulk-transfers.ts

import { BasePipeline } from '../base.js';
import { FECBulkClient } from '../clients/fec-bulk.js';

const BATCH_SIZE = 500;

export class FECBulkTransfersPipeline extends BasePipeline {
  private client: FECBulkClient;

  constructor() {
    super();
    this.client = new FECBulkClient();
  }

  getName(): string {
    return 'fec-bulk-transfers';
  }

  async run(): Promise<void> {
    let processed = 0;
    let inserted = 0;
    const batch: any[] = [];

    for await (const transfer of this.client.parseTransfers()) {
      processed++;
      if (processed % 10000 === 0) {
        console.log(`FEC bulk: processed ${processed} transfers, ${inserted} new relationships`);
      }

      // Look up source committee entity
      const { data: sourceEntity } = await this.supabase
        .from('entities')
        .select('id')
        .contains('external_ids', { fec_committee_id: transfer.cmte_id })
        .maybeSingle();

      if (!sourceEntity) continue;

      // Look up or create target committee entity
      let targetEntityId: string;
      const { data: targetEntity } = await this.supabase
        .from('entities')
        .select('id')
        .contains('external_ids', { fec_committee_id: transfer.other_id })
        .maybeSingle();

      if (targetEntity) {
        targetEntityId = targetEntity.id;
      } else {
        targetEntityId = await this.upsertEntity(
          {
            entity_type: 'pac',
            name: transfer.other_name || transfer.other_id,
            external_ids: { fec_committee_id: transfer.other_id },
          },
          'fec_committee_id',
          transfer.other_id
        );
      }

      // Create contribution relationship
      batch.push({
        source_entity_id: sourceEntity.id,
        target_entity_id: targetEntityId,
        relationship_type: 'contributed_to',
        amount: transfer.transaction_amount,
        date_start: transfer.transaction_date || null,
        metadata: {
          transaction_type: transfer.transaction_type,
          filing_id: transfer.filing_id,
          sub_id: transfer.sub_id,
        },
        confidence_score: 1.0,
        source: `fec-bulk:${transfer.sub_id}`,
      });

      if (batch.length >= BATCH_SIZE) {
        const { error } = await this.supabase.from('relationships').upsert(batch, {
          onConflict: 'source_entity_id,target_entity_id,relationship_type',
        });
        if (error) {
          this.results.errors.push(`Batch insert error: ${error.message}`);
        } else {
          inserted += batch.length;
        }
        batch.length = 0;
      }
    }

    // Final flush
    if (batch.length > 0) {
      const { error } = await this.supabase.from('relationships').upsert(batch, {
        onConflict: 'source_entity_id,target_entity_id,relationship_type',
      });
      if (!error) inserted += batch.length;
    }

    this.results.records_fetched = processed;
    this.results.records_inserted = inserted;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pipeline = new FECBulkTransfersPipeline();
  pipeline.execute().then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.errors.length > 0 ? 1 : 0);
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pipeline/pipelines/fec-bulk-transfers.ts
git commit -m "feat: add FEC bulk committee-to-committee transfers pipeline"
```

---

## Chunk 4: Enrichment Orchestrator & Phase 6-7

### Task 17: Enhanced Entity Resolver (Tier 1-3 Matching)

**Files:**
- Modify: `scripts/lib/entity-resolver.ts`

- [ ] **Step 1: Add new matching functions to entity-resolver.ts**

Add these exports to the existing file:

```typescript
export interface MergeCandidate {
  sourceEntityId: string;
  targetEntityId: string;
  confidence: number;
  signals: Record<string, any>;
}

/**
 * Cross-reference external IDs from different sources.
 * E.g., if Wikidata says bioguide_id=X and our entity has bioguide_id=X,
 * that's a deterministic match.
 */
export async function findCrossSourceMatches(
  supabase: SupabaseClient
): Promise<EntityMatch[]> {
  // Find entities that share external IDs across different source fields
  const { data: matches } = await supabase.rpc('exec_sql', {
    query: `
      WITH id_pairs AS (
        SELECT
          a.id AS source_id,
          b.id AS target_id,
          'wikidata_bioguide' AS match_type
        FROM entities a, entities b
        WHERE a.id != b.id
          AND a.external_ids->>'wikidata_id' IS NOT NULL
          AND a.external_ids->>'bioguide_id' = b.external_ids->>'bioguide_id'
          AND a.external_ids->>'bioguide_id' IS NOT NULL

        UNION

        SELECT
          a.id AS source_id,
          b.id AS target_id,
          'wikidata_fec' AS match_type
        FROM entities a, entities b
        WHERE a.id != b.id
          AND a.external_ids->>'wikidata_id' IS NOT NULL
          AND a.external_ids->>'fec_id' = b.external_ids->>'fec_id'
          AND a.external_ids->>'fec_id' IS NOT NULL
      )
      SELECT DISTINCT source_id, target_id, match_type FROM id_pairs
    `,
  });

  return (matches ?? []).map((m: any) => ({
    sourceId: m.source_id,
    targetId: m.target_id,
    confidence: 1.0,
    matchType: 'deterministic' as const,
    evidence: { match_type: m.match_type },
  }));
}

/**
 * Find fuzzy matches with contextual confidence boosting.
 * Uses name similarity + birth year + state + organization for scoring.
 */
export async function findContextualFuzzyMatches(
  supabase: SupabaseClient,
  autoMergeThreshold: number = 0.85,
  reviewThreshold: number = 0.5
): Promise<{ autoMerge: EntityMatch[]; review: MergeCandidate[] }> {
  // Get entity pairs with similar names via trigram
  const { data: candidates } = await supabase.rpc('exec_sql', {
    query: `
      SELECT
        a.id AS source_id,
        b.id AS target_id,
        a.name AS source_name,
        b.name AS target_name,
        similarity(a.name, b.name) AS name_sim,
        a.entity_type AS source_type,
        b.entity_type AS target_type
      FROM entities a, entities b
      WHERE a.id < b.id
        AND a.entity_type = b.entity_type
        AND similarity(a.name, b.name) > 0.6
      LIMIT 10000
    `,
  });

  const autoMerge: EntityMatch[] = [];
  const review: MergeCandidate[] = [];

  for (const c of candidates ?? []) {
    let confidence = c.name_sim as number;

    // Boost confidence with contextual signals
    // (In production, add birth_year, state, org affiliation checks here)

    if (confidence >= autoMergeThreshold) {
      autoMerge.push({
        sourceId: c.source_id,
        targetId: c.target_id,
        confidence,
        matchType: 'fuzzy',
        evidence: {
          source_name: c.source_name,
          target_name: c.target_name,
          name_similarity: c.name_sim,
        },
      });
    } else if (confidence >= reviewThreshold) {
      review.push({
        sourceEntityId: c.source_id,
        targetEntityId: c.target_id,
        confidence,
        signals: {
          source_name: c.source_name,
          target_name: c.target_name,
          name_similarity: c.name_sim,
        },
      });
    }
  }

  return { autoMerge, review };
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/lib/entity-resolver.ts
git commit -m "feat: add cross-source and contextual fuzzy entity resolution"
```

### Task 18: Enrichment Orchestrator Script

**Files:**
- Create: `scripts/pipeline/enrich-all.ts`

- [ ] **Step 1: Write the orchestrator**

```typescript
// scripts/pipeline/enrich-all.ts
// Runs all enrichment phases in dependency order

import { createClient } from '@supabase/supabase-js';

// Phase 1
import { WikidataEnrichmentPipeline } from './pipelines/wikidata-enrichment.js';
// Phase 2
import { OpenCorporatesEnrichmentPipeline } from './pipelines/opencorporates-enrichment.js';
import { CrunchbaseEnrichmentPipeline } from './pipelines/crunchbase-enrichment.js';
// Phase 3
import { ICIJImportPipeline } from './pipelines/icij-import.js';
import { OpenSanctionsImportPipeline } from './pipelines/opensanctions-import.js';
// Phase 4
import { OpenSecretsEnrichmentPipeline } from './pipelines/opensecrets-enrichment.js';
import { BallotpediaEnrichmentPipeline } from './pipelines/ballotpedia-enrichment.js';
import { FARAEnrichmentPipeline } from './pipelines/fara-enrichment.js';
// Phase 5
import { USAspendingEnrichmentPipeline } from './pipelines/usaspending-enrichment.js';
import { FECBulkTransfersPipeline } from './pipelines/fec-bulk-transfers.js';
// Phase 6
import { findCrossSourceMatches, findContextualFuzzyMatches, mergeEntities } from '../lib/entity-resolver.js';

import type { PipelineResult } from '../../src/lib/types/api-clients.js';

interface PhaseResult {
  phase: string;
  pipelines: PipelineResult[];
  durationMs: number;
}

async function runPhase(name: string, pipelines: { execute: () => Promise<PipelineResult> }[]): Promise<PhaseResult> {
  const start = Date.now();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Phase: ${name}`);
  console.log(`${'='.repeat(60)}`);

  const results: PipelineResult[] = [];
  for (const pipeline of pipelines) {
    try {
      const result = await pipeline.execute();
      results.push(result);
      console.log(`  ${result.source}: ${result.records_updated} enriched, ${result.errors.length} errors`);
    } catch (err) {
      console.error(`  FAILED: ${(err as Error).message}`);
      results.push({
        source: name,
        records_fetched: 0,
        records_inserted: 0,
        records_updated: 0,
        records_skipped: 0,
        errors: [(err as Error).message],
        duration_ms: 0,
      });
    }
  }

  return { phase: name, pipelines: results, durationMs: Date.now() - start };
}

async function runPhase6EntityResolution(): Promise<PhaseResult> {
  const start = Date.now();
  console.log(`\n${'='.repeat(60)}`);
  console.log('Phase 6: Entity Resolution');
  console.log(`${'='.repeat(60)}`);

  const supabase = createClient(
    process.env.PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const dryRun = process.argv.includes('--dry-run');

  // Tier 1: Cross-source deterministic matches
  const deterministicMatches = await findCrossSourceMatches(supabase);
  console.log(`  Deterministic matches: ${deterministicMatches.length}`);

  if (!dryRun) {
    for (const match of deterministicMatches) {
      await mergeEntities(match.sourceId, match.targetId);
    }
  }

  // Tier 2 + 3: Fuzzy matches
  const { autoMerge, review } = await findContextualFuzzyMatches(supabase);
  console.log(`  Auto-merge (≥0.85): ${autoMerge.length}`);
  console.log(`  Manual review (0.5-0.84): ${review.length}`);

  if (!dryRun) {
    for (const match of autoMerge) {
      await mergeEntities(match.sourceId, match.targetId);
    }

    // Insert review candidates
    for (const candidate of review) {
      await supabase.from('entity_merge_candidates').upsert(
        {
          source_entity_id: candidate.sourceEntityId,
          target_entity_id: candidate.targetEntityId,
          confidence_score: candidate.confidence,
          matching_signals: candidate.signals,
        },
        { onConflict: 'source_entity_id,target_entity_id' }
      );
    }
  }

  return {
    phase: 'entity-resolution',
    pipelines: [{
      source: 'entity-resolution',
      records_fetched: deterministicMatches.length + autoMerge.length + review.length,
      records_inserted: review.length,
      records_updated: deterministicMatches.length + autoMerge.length,
      records_skipped: 0,
      errors: [],
      duration_ms: Date.now() - start,
    }],
    durationMs: Date.now() - start,
  };
}

async function runPhase7Compute(): Promise<PhaseResult> {
  const start = Date.now();
  console.log(`\n${'='.repeat(60)}`);
  console.log('Phase 7: Compute (Materialized Views + Anomaly Scores)');
  console.log(`${'='.repeat(60)}`);

  const supabase = createClient(
    process.env.PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const { error } = await supabase.rpc('refresh_all_materialized_views');
  if (error) {
    console.error(`  View refresh failed: ${error.message}`);
    return {
      phase: 'compute',
      pipelines: [{
        source: 'compute',
        records_fetched: 0,
        records_inserted: 0,
        records_updated: 0,
        records_skipped: 0,
        errors: [error.message],
        duration_ms: Date.now() - start,
      }],
      durationMs: Date.now() - start,
    };
  }

  console.log('  Materialized views refreshed.');

  return {
    phase: 'compute',
    pipelines: [{
      source: 'compute',
      records_fetched: 0,
      records_inserted: 0,
      records_updated: 0,
      records_skipped: 0,
      errors: [],
      duration_ms: Date.now() - start,
    }],
    durationMs: Date.now() - start,
  };
}

async function main() {
  const startPhase = parseInt(process.argv.find((a) => a.startsWith('--from-phase='))?.split('=')[1] ?? '1', 10);
  const results: PhaseResult[] = [];

  if (startPhase <= 1) {
    results.push(await runPhase('Phase 1: Identity (Wikidata)', [new WikidataEnrichmentPipeline()]));
  }

  if (startPhase <= 2) {
    results.push(await runPhase('Phase 2: Corporate (OpenCorporates + Crunchbase)', [
      new OpenCorporatesEnrichmentPipeline(),
      new CrunchbaseEnrichmentPipeline(),
    ]));
  }

  if (startPhase <= 3) {
    results.push(await runPhase('Phase 3: Risk (ICIJ + OpenSanctions)', [
      new ICIJImportPipeline(),
      new OpenSanctionsImportPipeline(),
    ]));
  }

  if (startPhase <= 4) {
    results.push(await runPhase('Phase 4: Political (OpenSecrets + Ballotpedia + FARA)', [
      new OpenSecretsEnrichmentPipeline(),
      new BallotpediaEnrichmentPipeline(),
      new FARAEnrichmentPipeline(),
    ]));
  }

  if (startPhase <= 5) {
    results.push(await runPhase('Phase 5: Financial (USAspending + FEC Bulk)', [
      new USAspendingEnrichmentPipeline(),
      new FECBulkTransfersPipeline(),
    ]));
  }

  if (startPhase <= 6) {
    results.push(await runPhase6EntityResolution());
  }

  if (startPhase <= 7) {
    results.push(await runPhase7Compute());
  }

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('ENRICHMENT COMPLETE');
  console.log(`${'='.repeat(60)}`);
  const totalDuration = results.reduce((sum, r) => sum + r.durationMs, 0);
  const totalErrors = results.flatMap((r) => r.pipelines.flatMap((p) => p.errors));
  console.log(`Total duration: ${(totalDuration / 1000 / 60).toFixed(1)} minutes`);
  console.log(`Total errors: ${totalErrors.length}`);
  if (totalErrors.length > 0) {
    console.log('Errors:');
    totalErrors.slice(0, 20).forEach((e) => console.log(`  - ${e}`));
    if (totalErrors.length > 20) console.log(`  ... and ${totalErrors.length - 20} more`);
  }

  // Log run to enrichment_runs
  const supabase = createClient(
    process.env.PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  await supabase.from('enrichment_runs').insert({
    source: 'enrich-all',
    completed_at: new Date().toISOString(),
    entities_processed: results.flatMap((r) => r.pipelines).reduce((sum, p) => sum + p.records_fetched, 0),
    entities_enriched: results.flatMap((r) => r.pipelines).reduce((sum, p) => sum + p.records_updated, 0),
    errors: totalErrors.length,
    error_details: totalErrors.slice(0, 100),
    duration_ms: totalDuration,
  });

  process.exit(totalErrors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add scripts/pipeline/enrich-all.ts
git commit -m "feat: add enrichment orchestrator - runs all 7 phases in dependency order"
```

### Task 19: Cron Configuration for Enrichment

**Files:**
- Modify: `scripts/cron-fec-imports.sh` → rename/extend to `scripts/cron-enrichment.sh`
- Create: `scripts/cron-enrichment.sh`

- [ ] **Step 1: Write the cron script**

```bash
#!/bin/bash
# scripts/cron-enrichment.sh
# Enrichment pipeline cron runner
# Schedule: Weekly full run, daily for fast sources
#
# Crontab entries:
#   Weekly full enrichment (Sunday 2am):
#     0 2 * * 0 /path/to/scripts/cron-enrichment.sh full
#   Daily fast enrichment (OpenSanctions, FEC, Crunchbase queue):
#     0 3 * * * /path/to/scripts/cron-enrichment.sh daily

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

MODE="${1:-daily}"

case "$MODE" in
  full)
    echo "Running full enrichment pipeline..."
    npx tsx scripts/pipeline/enrich-all.ts
    ;;
  daily)
    echo "Running daily enrichment (fast sources only)..."
    npx tsx scripts/pipeline/enrich-all.ts --from-phase=2
    ;;
  phase)
    PHASE="${2:-1}"
    echo "Running single phase: $PHASE"
    npx tsx scripts/pipeline/enrich-all.ts --from-phase="$PHASE"
    ;;
  *)
    echo "Usage: $0 {full|daily|phase <N>}"
    exit 1
    ;;
esac
```

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x scripts/cron-enrichment.sh
git add scripts/cron-enrichment.sh
git commit -m "feat: add enrichment cron script with full/daily/phase modes"
```

### Task 20: Update .env.example with new API keys

**Files:**
- Modify: `.env.example` (or create if doesn't exist)

- [ ] **Step 1: Add new environment variables**

Add these lines to `.env.example`:

```
# Enrichment API Keys
OPENCORPORATES_API_TOKEN=     # Optional: increases rate limit from 200/day
CRUNCHBASE_API_KEY=           # Required for Crunchbase enrichment (Basic tier)
BALLOTPEDIA_API_KEY=          # Optional: for Ballotpedia candidate data

# Bulk Data Directories
ICIJ_DATA_DIR=./data/icij                   # Path to downloaded ICIJ CSV files
OPENSANCTIONS_DATA_DIR=./data/opensanctions # Path to downloaded OpenSanctions JSONL
OPENSECRETS_DATA_DIR=./data/opensecrets     # Path to downloaded OpenSecrets bulk data
FARA_DATA_DIR=./data/fara                   # Path to downloaded DOJ FARA CSV files
FEC_BULK_DATA_DIR=./data/fec-bulk           # Path to downloaded FEC bulk data files
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "feat: add enrichment environment variables to .env.example"
```
