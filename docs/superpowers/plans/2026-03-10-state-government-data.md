# State Government Data Collection — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate GovGuide with statewide executives, state courts/judges, and other public offices for all 50 states + DC.

**Architecture:** Two static JSON data files (`data/statewide-executives.json` and `data/state-courts.json`) compiled from public sources, plus two import scripts that read the JSON and upsert into existing Supabase tables (`offices`/`officials` and `courts`/`judges`). One small DB migration adds a missing unique constraint.

**Tech Stack:** TypeScript, Supabase (PostgreSQL), tsx runner, existing `scripts/lib/supabase-admin.ts` client.

**Spec:** `docs/superpowers/specs/2026-03-10-state-government-data-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `supabase/migrations/023_officials_unique_constraint.sql` | Create | Add unique index on `officials(slug, office_id)` |
| `data/statewide-executives.json` | Create | All statewide executive officers + other public offices for 50 states + DC |
| `data/state-courts.json` | Create | Court structures + supreme/appellate judges for 50 states + DC |
| `scripts/import-statewide-executives.ts` | Create | Import script: reads JSON, upserts offices + officials |
| `scripts/import-state-courts.ts` | Create | Import script: reads JSON, upserts courts + entities + judges |
| `package.json` | Modify | Add npm scripts for the two new importers |

---

## Chunk 1: Database Migration + Import Scripts

### Task 1: Add officials unique constraint migration

**Files:**
- Create: `supabase/migrations/023_officials_unique_constraint.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- Required for upsert deduplication in import-statewide-executives.ts
-- Also fixes existing import-state-officials.ts which already uses this conflict key
CREATE UNIQUE INDEX IF NOT EXISTS idx_officials_slug_office
  ON officials(slug, office_id);
```

- [ ] **Step 2: Apply migration to Supabase**

Run: `npx supabase db push` or apply via Supabase dashboard SQL editor.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/023_officials_unique_constraint.sql
git commit -m "feat: add unique constraint on officials(slug, office_id)"
```

---

### Task 2: Create import-statewide-executives.ts

This script reads `data/statewide-executives.json` and upserts into `offices` + `officials`.

**Files:**
- Create: `scripts/import-statewide-executives.ts`

**Reference files:**
- `scripts/import-state-officials.ts` — follow the same patterns (slugify, parseName, batch upserts, caching, STATES env var)
- `scripts/lib/supabase-admin.ts` — Supabase client

- [ ] **Step 1: Create the import script**

```typescript
/**
 * Import statewide executive officers and other public office holders
 * from the static data/statewide-executives.json file.
 *
 * Supports filtering via:  STATES=AL,AK,AZ  (comma-separated)
 *
 * Run with:  npm run import:statewide-executives
 */

import fs from 'node:fs';
import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Party =
  | 'democratic'
  | 'republican'
  | 'independent'
  | 'libertarian'
  | 'green'
  | 'other';

type Branch = 'executive' | 'legislative' | 'judicial';

interface OfficialData {
  first_name: string;
  last_name: string;
  party: Party;
  email: string | null;
  phone: string | null;
  website: string | null;
  photo_url: string | null;
  term_start: string | null;
  term_end: string | null;
}

interface OfficeEntry {
  title: string;
  branch: Branch;
  is_elected: boolean;
  official: OfficialData;
}

interface StateData {
  offices: OfficeEntry[];
}

type StatewideExecutives = Record<string, StateData>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100;

const STATE_ABBR_TO_SLUG: Record<string, string> = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas',
  CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware',
  FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho',
  IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas',
  KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
  MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi',
  MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada',
  NH: 'new-hampshire', NJ: 'new-jersey', NM: 'new-mexico', NY: 'new-york',
  NC: 'north-carolina', ND: 'north-dakota', OH: 'ohio', OK: 'oklahoma',
  OR: 'oregon', PA: 'pennsylvania', RI: 'rhode-island', SC: 'south-carolina',
  SD: 'south-dakota', TN: 'tennessee', TX: 'texas', UT: 'utah',
  VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west-virginia',
  WI: 'wisconsin', WY: 'wyoming', DC: 'district-of-columbia',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getTargetStates(allStates: string[]): string[] {
  const raw = process.env.STATES?.trim();
  if (!raw) return allStates;
  const requested = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const valid = requested.filter((s) => STATE_ABBR_TO_SLUG[s]);
  const invalid = requested.filter((s) => !STATE_ABBR_TO_SLUG[s]);
  if (invalid.length > 0) {
    console.warn(`  WARN: Unknown state codes ignored: ${invalid.join(', ')}`);
  }
  return valid;
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

const jurisdictionCache = new Map<string, string>();
const officeCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function getJurisdictionId(stateAbbr: string): Promise<string | null> {
  const slug = STATE_ABBR_TO_SLUG[stateAbbr];
  if (!slug) return null;
  if (jurisdictionCache.has(slug)) return jurisdictionCache.get(slug)!;

  const { data, error } = await supabase
    .from('jurisdictions')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();

  if (error || !data) {
    console.error(`  ERROR looking up jurisdiction "${slug}": ${error?.message ?? 'not found'}`);
    return null;
  }

  jurisdictionCache.set(slug, (data as { id: string }).id);
  return (data as { id: string }).id;
}

async function getOrCreateOffice(insert: {
  title: string;
  slug: string;
  branch: Branch;
  chamber: null;
  jurisdiction_id: string;
  district: null;
  is_elected: boolean;
}): Promise<string | null> {
  const cacheKey = insert.slug;
  if (officeCache.has(cacheKey)) return officeCache.get(cacheKey)!;

  const { data: existing } = await supabase
    .from('offices')
    .select('id')
    .eq('slug', insert.slug)
    .eq('jurisdiction_id', insert.jurisdiction_id)
    .maybeSingle();

  if (existing) {
    officeCache.set(cacheKey, (existing as { id: string }).id);
    return (existing as { id: string }).id;
  }

  const { data: created, error } = await supabase
    .from('offices')
    .insert(insert)
    .select('id')
    .single();

  if (error || !created) {
    console.error(`  ERROR creating office "${insert.slug}": ${error?.message}`);
    return null;
  }

  const id = (created as { id: string }).id;
  officeCache.set(cacheKey, id);
  return id;
}

interface OfficialInsert {
  first_name: string;
  last_name: string;
  full_name: string;
  slug: string;
  office_id: string;
  party: Party;
  photo_url: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  term_start: string | null;
  term_end: string | null;
  is_current: boolean;
  bioguide_id: string | null;
  fec_id: string | null;
  social_media: Record<string, string>;
}

async function flushOfficials(batch: OfficialInsert[]): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('officials')
    .upsert(batch, { onConflict: 'slug,office_id' });

  if (error) {
    console.error(`  BATCH ERROR (${batch.length} records): ${error.message}`);
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importStatewideExecutives(): Promise<void> {
  console.log('=== Import Statewide Executives ===\n');

  const jsonPath = new URL('../data/statewide-executives.json', import.meta.url);
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Data file not found: ${jsonPath}`);
  }

  const data: StatewideExecutives = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const allStates = Object.keys(data);
  const targetStates = getTargetStates(allStates);

  console.log(`  Processing ${targetStates.length} states\n`);

  let totalInserted = 0;
  let totalSkipped = 0;

  for (const stateAbbr of targetStates) {
    const stateData = data[stateAbbr];
    if (!stateData || !stateData.offices.length) {
      console.log(`  ${stateAbbr}: no offices — skipping`);
      continue;
    }

    console.log(`\n--- ${stateAbbr} (${stateData.offices.length} offices) ---`);

    const jurisdictionId = await getJurisdictionId(stateAbbr);
    if (!jurisdictionId) {
      totalSkipped += stateData.offices.length;
      continue;
    }

    const officialsBatch: OfficialInsert[] = [];

    for (const entry of stateData.offices) {
      const officeSlug = `${stateAbbr.toLowerCase()}-${slugify(entry.title)}`;

      const officeId = await getOrCreateOffice({
        title: entry.title,
        slug: officeSlug,
        branch: entry.branch,
        chamber: null,
        jurisdiction_id: jurisdictionId,
        district: null,
        is_elected: entry.is_elected,
      });

      if (!officeId) {
        totalSkipped++;
        continue;
      }

      const { first_name, last_name } = entry.official;
      const fullName = `${first_name} ${last_name}`.trim();
      const officialSlug = slugify(`${first_name}-${last_name}-${stateAbbr}`);

      officialsBatch.push({
        first_name,
        last_name,
        full_name: fullName,
        slug: officialSlug,
        office_id: officeId,
        party: entry.official.party,
        photo_url: entry.official.photo_url,
        email: entry.official.email,
        phone: entry.official.phone,
        website: entry.official.website,
        term_start: entry.official.term_start,
        term_end: entry.official.term_end,
        is_current: true,
        bioguide_id: null,
        fec_id: null,
        social_media: {},
      });

      if (officialsBatch.length >= BATCH_SIZE) {
        const { ok, err } = await flushOfficials(officialsBatch.splice(0, BATCH_SIZE));
        totalInserted += ok;
        totalSkipped += err;
        process.stdout.write(`  Flushed batch (ok=${ok}, err=${err})\n`);
      }
    }

    if (officialsBatch.length > 0) {
      const { ok, err } = await flushOfficials(officialsBatch);
      totalInserted += ok;
      totalSkipped += err;
      process.stdout.write(`  Flushed final batch (ok=${ok}, err=${err})\n`);
    }
  }

  console.log(
    `\n=== Completed. Inserted/updated: ${totalInserted}, skipped: ${totalSkipped} ===`,
  );
}

importStatewideExecutives().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add scripts/import-statewide-executives.ts
git commit -m "feat: add import script for statewide executives"
```

---

### Task 3: Create import-state-courts.ts

This script reads `data/state-courts.json` and upserts into `courts` + `entities` + `judges`.

**Files:**
- Create: `scripts/import-state-courts.ts`

**Reference files:**
- `scripts/import-judges.ts` — follow entity creation + judge linking patterns
- `supabase/migrations/012_judicial.sql` — canonical schema (enum-based, has `first_name`/`last_name`)
- `supabase/migrations/008_graph_entities.sql` — entities table with `entity_type: 'judge'`

- [ ] **Step 1: Create the import script**

```typescript
/**
 * Import state court structures and judges from data/state-courts.json.
 *
 * For each state this script:
 *   1. Resolves the state jurisdiction_id.
 *   2. Upserts court rows with court_type enum values (state_supreme, state_appellate, state_trial, special).
 *   3. Creates entity rows (entity_type: 'judge') for each judge.
 *   4. Upserts judge rows linked to courts and entities.
 *
 * Supports filtering via:  STATES=AL,AK,AZ  (comma-separated)
 *
 * Run with:  npm run import:state-courts
 */

import fs from 'node:fs';
import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CourtType = 'state_supreme' | 'state_appellate' | 'state_trial' | 'special';

interface JudgeData {
  first_name: string;
  last_name: string;
  full_name: string;
  appointing_president: string | null;
  term_start: string | null;
  term_end: string | null;
  role?: string;
}

interface CourtEntry {
  name: string;
  court_type: CourtType;
  website: string | null;
  selection_method: string;
  num_seats: number | null;
  judges: JudgeData[];
}

interface StateCourtData {
  courts: CourtEntry[];
}

type StateCourts = Record<string, StateCourtData>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BATCH_SIZE = 100;

const STATE_ABBR_TO_SLUG: Record<string, string> = {
  AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas',
  CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware',
  FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho',
  IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas',
  KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland',
  MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi',
  MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada',
  NH: 'new-hampshire', NJ: 'new-jersey', NM: 'new-mexico', NY: 'new-york',
  NC: 'north-carolina', ND: 'north-dakota', OH: 'ohio', OK: 'oklahoma',
  OR: 'oregon', PA: 'pennsylvania', RI: 'rhode-island', SC: 'south-carolina',
  SD: 'south-dakota', TN: 'tennessee', TX: 'texas', UT: 'utah',
  VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west-virginia',
  WI: 'wisconsin', WY: 'wyoming', DC: 'district-of-columbia',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getTargetStates(allStates: string[]): string[] {
  const raw = process.env.STATES?.trim();
  if (!raw) return allStates;
  const requested = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const valid = requested.filter((s) => STATE_ABBR_TO_SLUG[s]);
  const invalid = requested.filter((s) => !STATE_ABBR_TO_SLUG[s]);
  if (invalid.length > 0) {
    console.warn(`  WARN: Unknown state codes ignored: ${invalid.join(', ')}`);
  }
  return valid;
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

const jurisdictionCache = new Map<string, string>();
const courtCache = new Map<string, string>();

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function getJurisdictionId(stateAbbr: string): Promise<string | null> {
  const slug = STATE_ABBR_TO_SLUG[stateAbbr];
  if (!slug) return null;
  if (jurisdictionCache.has(slug)) return jurisdictionCache.get(slug)!;

  const { data, error } = await supabase
    .from('jurisdictions')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();

  if (error || !data) {
    console.error(`  ERROR looking up jurisdiction "${slug}": ${error?.message ?? 'not found'}`);
    return null;
  }

  jurisdictionCache.set(slug, (data as { id: string }).id);
  return (data as { id: string }).id;
}

async function getOrCreateCourt(insert: {
  name: string;
  slug: string;
  court_type: CourtType;
  jurisdiction_id: string;
  website: string | null;
  metadata: Record<string, unknown>;
}): Promise<string | null> {
  const cacheKey = insert.slug;
  if (courtCache.has(cacheKey)) return courtCache.get(cacheKey)!;

  const { data: existing } = await supabase
    .from('courts')
    .select('id')
    .eq('slug', insert.slug)
    .maybeSingle();

  if (existing) {
    courtCache.set(cacheKey, (existing as { id: string }).id);
    return (existing as { id: string }).id;
  }

  const { data: created, error } = await supabase
    .from('courts')
    .insert(insert)
    .select('id')
    .single();

  if (error || !created) {
    console.error(`  ERROR creating court "${insert.name}": ${error?.message}`);
    return null;
  }

  const id = (created as { id: string }).id;
  courtCache.set(cacheKey, id);
  return id;
}

const entityCache = new Map<string, string>();

async function getOrCreateEntity(
  name: string,
  stateAbbr: string,
  judgeSlug: string,
): Promise<string | null> {
  if (entityCache.has(judgeSlug)) return entityCache.get(judgeSlug)!;

  // Check for existing entity by external_ids to support re-runs
  const { data: existing } = await supabase
    .from('entities')
    .select('id')
    .contains('external_ids', { state_judge_slug: judgeSlug })
    .maybeSingle();

  if (existing) {
    entityCache.set(judgeSlug, (existing as { id: string }).id);
    return (existing as { id: string }).id;
  }

  const { data, error } = await supabase
    .from('entities')
    .insert({
      entity_type: 'judge',
      name,
      aliases: [],
      external_ids: { state_judge_slug: judgeSlug },
      metadata: { state: stateAbbr },
    })
    .select('id')
    .single();

  if (error || !data) {
    console.error(`  ERROR creating entity for "${name}": ${error?.message}`);
    return null;
  }

  const id = (data as { id: string }).id;
  entityCache.set(judgeSlug, id);
  return id;
}

interface JudgeInsert {
  entity_id: string;
  court_id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  slug: string;
  appointing_president: string | null;
  commission_date: string | null;
  metadata: Record<string, unknown>;
}

async function flushJudges(batch: JudgeInsert[]): Promise<{ ok: number; err: number }> {
  if (batch.length === 0) return { ok: 0, err: 0 };

  const { error } = await supabase
    .from('judges')
    .upsert(batch, { onConflict: 'slug' });

  if (error) {
    console.error(`  JUDGE BATCH ERROR (${batch.length} records): ${error.message}`);
    return { ok: 0, err: batch.length };
  }

  return { ok: batch.length, err: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function importStateCourts(): Promise<void> {
  console.log('=== Import State Courts ===\n');

  const jsonPath = new URL('../data/state-courts.json', import.meta.url);
  if (!fs.existsSync(jsonPath)) {
    throw new Error(`Data file not found: ${jsonPath}`);
  }

  const data: StateCourts = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const allStates = Object.keys(data);
  const targetStates = getTargetStates(allStates);

  console.log(`  Processing ${targetStates.length} states\n`);

  let totalCourts = 0;
  let totalJudges = 0;
  let totalSkipped = 0;

  for (const stateAbbr of targetStates) {
    const stateData = data[stateAbbr];
    if (!stateData || !stateData.courts.length) {
      console.log(`  ${stateAbbr}: no courts — skipping`);
      continue;
    }

    console.log(`\n--- ${stateAbbr} (${stateData.courts.length} courts) ---`);

    const jurisdictionId = await getJurisdictionId(stateAbbr);
    if (!jurisdictionId) {
      totalSkipped++;
      continue;
    }

    for (const court of stateData.courts) {
      const courtSlug = slugify(`${stateAbbr}-${court.name}`);

      const courtId = await getOrCreateCourt({
        name: court.name,
        slug: courtSlug,
        court_type: court.court_type,
        jurisdiction_id: jurisdictionId,
        website: court.website,
        metadata: {
          selection_method: court.selection_method,
          num_seats: court.num_seats,
        },
      });

      if (!courtId) {
        totalSkipped++;
        continue;
      }

      totalCourts++;

      if (court.judges.length === 0) continue;

      const judgeBatch: JudgeInsert[] = [];

      for (const judge of court.judges) {
        const judgeSlug = slugify(
          `${judge.full_name}-${stateAbbr}-${court.court_type}`,
        );

        // Create or find entity for graph system (idempotent via external_ids)
        const entityId = await getOrCreateEntity(judge.full_name, stateAbbr, judgeSlug);
        if (!entityId) {
          totalSkipped++;
          continue;
        }

        judgeBatch.push({
          entity_id: entityId,
          court_id: courtId,
          first_name: judge.first_name,
          last_name: judge.last_name,
          full_name: judge.full_name,
          slug: judgeSlug,
          appointing_president: judge.appointing_president,
          commission_date: judge.term_start,
          metadata: {
            term_end: judge.term_end,
            role: judge.role ?? null,
            state: stateAbbr,
          },
        });

        if (judgeBatch.length >= BATCH_SIZE) {
          const { ok, err } = await flushJudges(judgeBatch.splice(0, BATCH_SIZE));
          totalJudges += ok;
          totalSkipped += err;
          process.stdout.write(`  Flushed judge batch (ok=${ok}, err=${err})\n`);
        }
      }

      if (judgeBatch.length > 0) {
        const { ok, err } = await flushJudges(judgeBatch);
        totalJudges += ok;
        totalSkipped += err;
        process.stdout.write(`  Flushed judge batch (ok=${ok}, err=${err})\n`);
      }
    }
  }

  console.log(
    `\n=== Completed. Courts: ${totalCourts}, Judges: ${totalJudges}, Skipped: ${totalSkipped} ===`,
  );
}

importStateCourts().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add scripts/import-state-courts.ts
git commit -m "feat: add import script for state courts and judges"
```

---

### Task 4: Add npm scripts to package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the two new import scripts**

Add these entries to `"scripts"` in `package.json`:

```json
"import:statewide-executives": "npx tsx --env-file=.env scripts/import-statewide-executives.ts",
"import:state-courts": "npx tsx --env-file=.env scripts/import-state-courts.ts"
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "feat: add npm scripts for statewide executives and state courts imports"
```

---

## Chunk 2: Statewide Executives Data (Tier A + C)

### Task 5: Create statewide-executives.json — States AL through FL

**Files:**
- Create: `data/statewide-executives.json` (initial file with first 10 states)

Compile data for: **AL, AK, AZ, AR, CA, CO, CT, DE, FL, GA**

For each state, include all statewide executive officers currently in office. Each entry needs:
- `title` — office title (e.g., "Lieutenant Governor", "Attorney General")
- `branch` — always `"executive"`
- `is_elected` — `true` for elected offices, `false` for appointed
- `official.first_name`, `official.last_name` — current officeholder
- `official.party` — one of: `democratic`, `republican`, `independent`, `libertarian`, `green`, `other`
- `official.email`, `official.phone`, `official.website` — contact info (null if unknown)
- `official.photo_url` — null (can be populated later)
- `official.term_start`, `official.term_end` — ISO dates (null if unknown)

**Offices to include per state (where they exist):**
1. Lieutenant Governor
2. Attorney General
3. Secretary of State
4. State Treasurer / Comptroller
5. State Auditor
6. Superintendent of Public Instruction / Education
7. Commissioner of Agriculture
8. Commissioner of Insurance
9. Commissioner of Labor
10. Land Commissioner
11. Public Utility / Public Service Commissioners (one entry per commissioner for multi-member boards)
12. Railroad / Corporation Commissioners
13. Any other statewide elected officials unique to that state

**Source:** Official state government websites, compile current officeholder data.

- [ ] **Step 1: Create data file with AL through GA**

Create `data/statewide-executives.json` with accurate, current data for the first 10 states. Structure:

```json
{
  "AL": {
    "offices": [
      {
        "title": "Lieutenant Governor",
        "branch": "executive",
        "is_elected": true,
        "official": { ... }
      }
    ]
  },
  "AK": { ... },
  ...
}
```

- [ ] **Step 2: Validate JSON is well-formed**

Run: `node -e "JSON.parse(require('fs').readFileSync('data/statewide-executives.json','utf-8')); console.log('Valid JSON')"`

- [ ] **Step 3: Commit**

```bash
git add data/statewide-executives.json
git commit -m "feat: add statewide executives data for AL through GA"
```

---

### Task 6: Statewide executives — States HI through MA

**Files:**
- Modify: `data/statewide-executives.json`

Add data for: **HI, ID, IL, IN, IA, KS, KY, LA, ME, MD, MA**

Same format and offices as Task 5.

- [ ] **Step 1: Add HI through MA entries to the JSON**
- [ ] **Step 2: Validate JSON**

Run: `node -e "const d=JSON.parse(require('fs').readFileSync('data/statewide-executives.json','utf-8')); console.log(Object.keys(d).length + ' states')"`

Expected: `21 states`

- [ ] **Step 3: Commit**

```bash
git add data/statewide-executives.json
git commit -m "feat: add statewide executives data for HI through MA"
```

---

### Task 7: Statewide executives — States MI through NJ

**Files:**
- Modify: `data/statewide-executives.json`

Add data for: **MI, MN, MS, MO, MT, NE, NV, NH, NJ**

- [ ] **Step 1: Add MI through NJ entries**
- [ ] **Step 2: Validate JSON** — Expected: `30 states`
- [ ] **Step 3: Commit**

```bash
git add data/statewide-executives.json
git commit -m "feat: add statewide executives data for MI through NJ"
```

---

### Task 8: Statewide executives — States NM through SC

**Files:**
- Modify: `data/statewide-executives.json`

Add data for: **NM, NY, NC, ND, OH, OK, OR, PA, RI, SC**

- [ ] **Step 1: Add NM through SC entries**
- [ ] **Step 2: Validate JSON** — Expected: `40 states`
- [ ] **Step 3: Commit**

```bash
git add data/statewide-executives.json
git commit -m "feat: add statewide executives data for NM through SC"
```

---

### Task 9: Statewide executives — States SD through WY + DC

**Files:**
- Modify: `data/statewide-executives.json`

Add data for: **SD, TN, TX, UT, VT, VA, WA, WV, WI, WY, DC**

- [ ] **Step 1: Add SD through WY + DC entries**
- [ ] **Step 2: Validate JSON** — Expected: `51 states` (50 + DC)
- [ ] **Step 3: Final validation — check all state abbreviations present**

Run: `node -e "const d=JSON.parse(require('fs').readFileSync('data/statewide-executives.json','utf-8')); const expected='AL,AK,AZ,AR,CA,CO,CT,DE,FL,GA,HI,ID,IL,IN,IA,KS,KY,LA,ME,MD,MA,MI,MN,MS,MO,MT,NE,NV,NH,NJ,NM,NY,NC,ND,OH,OK,OR,PA,RI,SC,SD,TN,TX,UT,VT,VA,WA,WV,WI,WY,DC'.split(','); const missing=expected.filter(s=>!d[s]); console.log(missing.length?'MISSING: '+missing.join(','):'All 51 present'); console.log('Total offices: '+Object.values(d).reduce((n,s)=>n+s.offices.length,0))"`

- [ ] **Step 4: Commit**

```bash
git add data/statewide-executives.json
git commit -m "feat: complete statewide executives data for all 50 states + DC"
```

---

## Chunk 3: State Courts Data (Tier B)

### Task 10: Create state-courts.json — States AL through FL

**Files:**
- Create: `data/state-courts.json` (initial file with first 10 states)

Compile court structure data for: **AL, AK, AZ, AR, CA, CO, CT, DE, FL, GA**

For each state, include:
- **All court levels** — supreme, appellate, trial (and specialized if notable)
- **Judges** — populate for `state_supreme` and `state_appellate` courts only; leave `judges: []` for `state_trial` and `special` courts

Each court entry needs:
- `name` — official court name (e.g., "Supreme Court of Alabama")
- `court_type` — one of: `state_supreme`, `state_appellate`, `state_trial`, `special`
- `website` — official court website URL (null if unknown)
- `selection_method` — one of: `partisan_election`, `nonpartisan_election`, `gubernatorial_appointment`, `legislative_appointment`, `merit_selection`, `assisted_appointment`
- `num_seats` — number of judge seats (null for trial courts with many divisions)
- `judges` — array of current justices/judges

Each judge entry needs:
- `first_name`, `last_name`, `full_name`
- `appointing_president` — null for elected judges; appointing governor's name for appointed judges
- `term_start` — ISO date when they took the bench (null if unknown)
- `term_end` — ISO date when current term expires (null if unknown)
- `role` — "Chief Justice", "Associate Justice", "Presiding Judge", "Judge" etc.

**Key state court name variations to handle correctly:**
- NY: Court of Appeals is the highest court (not Supreme Court, which is the trial court)
- MD: Court of Appeals is the highest court (renamed Supreme Court of Maryland in 2023)
- MA/ME: Supreme Judicial Court
- TX/OK: Separate supreme courts for civil and criminal
- NE: Unicameral has unique judicial appointment process
- States with no intermediate appellate court: DE, ME, MT, NV, NH, ND, RI, SD, VT, WV, WY

**Source:** Official state judiciary websites, NCSC data.

- [ ] **Step 1: Create data file with AL through GA**
- [ ] **Step 2: Validate JSON is well-formed**
- [ ] **Step 3: Commit**

```bash
git add data/state-courts.json
git commit -m "feat: add state courts data for AL through GA"
```

---

### Task 11: State courts — States HI through MA

**Files:**
- Modify: `data/state-courts.json`

Add data for: **HI, ID, IL, IN, IA, KS, KY, LA, ME, MD, MA**

- [ ] **Step 1: Add HI through MA entries**
- [ ] **Step 2: Validate JSON** — Expected: `21 states`
- [ ] **Step 3: Commit**

```bash
git add data/state-courts.json
git commit -m "feat: add state courts data for HI through MA"
```

---

### Task 12: State courts — States MI through NJ

**Files:**
- Modify: `data/state-courts.json`

Add data for: **MI, MN, MS, MO, MT, NE, NV, NH, NJ**

- [ ] **Step 1: Add MI through NJ entries**
- [ ] **Step 2: Validate JSON** — Expected: `30 states`
- [ ] **Step 3: Commit**

```bash
git add data/state-courts.json
git commit -m "feat: add state courts data for MI through NJ"
```

---

### Task 13: State courts — States NM through SC

**Files:**
- Modify: `data/state-courts.json`

Add data for: **NM, NY, NC, ND, OH, OK, OR, PA, RI, SC**

**Watch out for:**
- NY: Court of Appeals = highest (state_supreme), Supreme Court = trial (state_trial)
- OK: Supreme Court (civil) + Court of Criminal Appeals (both state_supreme)

- [ ] **Step 1: Add NM through SC entries**
- [ ] **Step 2: Validate JSON** — Expected: `40 states`
- [ ] **Step 3: Commit**

```bash
git add data/state-courts.json
git commit -m "feat: add state courts data for NM through SC"
```

---

### Task 14: State courts — States SD through WY + DC

**Files:**
- Modify: `data/state-courts.json`

Add data for: **SD, TN, TX, UT, VT, VA, WA, WV, WI, WY, DC**

**Watch out for:**
- TX: Supreme Court (civil) + Court of Criminal Appeals (both state_supreme)
- DC: Court of Appeals = highest; Superior Court = trial
- Several states (SD, VT, WV, WY) have no intermediate appellate court

- [ ] **Step 1: Add SD through WY + DC entries**
- [ ] **Step 2: Final validation — all states present + totals**

Run: `node -e "const d=JSON.parse(require('fs').readFileSync('data/state-courts.json','utf-8')); const expected='AL,AK,AZ,AR,CA,CO,CT,DE,FL,GA,HI,ID,IL,IN,IA,KS,KY,LA,ME,MD,MA,MI,MN,MS,MO,MT,NE,NV,NH,NJ,NM,NY,NC,ND,OH,OK,OR,PA,RI,SC,SD,TN,TX,UT,VT,VA,WA,WV,WI,WY,DC'.split(','); const missing=expected.filter(s=>!d[s]); console.log(missing.length?'MISSING: '+missing.join(','):'All 51 present'); let courts=0,judges=0; Object.values(d).forEach(s=>{s.courts.forEach(c=>{courts++;judges+=c.judges.length})}); console.log('Courts:',courts,'Judges:',judges)"`

- [ ] **Step 3: Commit**

```bash
git add data/state-courts.json
git commit -m "feat: complete state courts data for all 50 states + DC"
```

---

## Chunk 4: Integration Testing

### Task 15: Test imports end-to-end

- [ ] **Step 1: Test statewide executives import (single state)**

Run: `STATES=AL npm run import:statewide-executives`

Expected: Offices created for Alabama statewide executives, officials linked. No errors.

- [ ] **Step 2: Test state courts import (single state)**

Run: `STATES=AL npm run import:state-courts`

Expected: Courts created for Alabama, supreme court judges inserted. No errors.

- [ ] **Step 3: Test full import (all states)**

Run: `npm run import:statewide-executives && npm run import:state-courts`

Expected: All 50 states + DC processed. Check final counts match expected volumes (~400-500 executives, ~250 courts, ~1,400 judges).

- [ ] **Step 4: Verify data in Supabase**

Spot-check via SQL:
```sql
-- Statewide executives count
SELECT j.state_abbr, COUNT(*) as officials
FROM officials o
JOIN offices off ON o.office_id = off.id
JOIN jurisdictions j ON off.jurisdiction_id = j.id
WHERE off.branch = 'executive' AND j.level = 'state' AND o.is_current = true
GROUP BY j.state_abbr ORDER BY j.state_abbr;

-- State courts count
SELECT j.state_abbr, COUNT(*) as courts
FROM courts c
JOIN jurisdictions j ON c.jurisdiction_id = j.id
WHERE j.level = 'state'
GROUP BY j.state_abbr ORDER BY j.state_abbr;

-- State judges count
SELECT COUNT(*) FROM judges jg
JOIN courts c ON jg.court_id = c.id
JOIN jurisdictions j ON c.jurisdiction_id = j.id
WHERE j.level = 'state';
```

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: resolve issues found during state government data integration testing"
```
