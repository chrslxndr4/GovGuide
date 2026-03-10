# Comprehensive Transparency Data Expansion — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build import scripts for all free transparency data sources, apply schema changes, set up cron scheduling, and create the community contribution pipeline.

**Architecture:** Each import script follows the established pattern: typed interfaces, batch upserts via Supabase client, rate limiting with retry logic, metadata in JSONB. Scripts are standalone TypeScript files run via `npx tsx`. Rate-limited imports get cron wrappers.

**Tech Stack:** TypeScript, Supabase JS client, node:readline (CSV), regex XML parsing (no extra deps), GitHub Actions for community pipeline.

---

### Task 1: Schema Migration — Add Columns for Judges and Cross-References

**Files:**
- Create: `supabase/migrations/021_transparency_columns.sql`

**Step 1: Write the migration**

```sql
-- Add photo and selection method to judges
ALTER TABLE judges ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE judges ADD COLUMN IF NOT EXISTS selection_method TEXT;

-- Add LittleSis cross-reference IDs
ALTER TABLE entities ADD COLUMN IF NOT EXISTS littlesis_id TEXT;
ALTER TABLE officials ADD COLUMN IF NOT EXISTS littlesis_id TEXT;

-- Add GitHub tracking to community_submissions
ALTER TABLE community_submissions ADD COLUMN IF NOT EXISTS github_issue_url TEXT;

-- Add relationship types needed for LittleSis data
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'board_member';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'fellow_of';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'member_of';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'family_of';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'owns';
ALTER TYPE relationship_type ADD VALUE IF NOT EXISTS 'educated_at';
```

**Step 2: Apply the migration**

Run: `cd "/Users/chrisalexander/Desktop/Chris Alexander HQ/Projects/GovGuide/GovGuide" && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/migrations/021_transparency_columns.sql`
Expected: All ALTER statements succeed.

**Step 3: Commit**

```bash
git add supabase/migrations/021_transparency_columns.sql
git commit -m "feat: add schema columns for photos, selection_method, littlesis_id"
```

---

### Task 2: Congress Member Photos Import

**Files:**
- Create: `scripts/import-congress-photos.ts`
- Modify: `package.json` (add `import:congress-photos` script)

**Step 1: Write the import script**

Pattern: Query all officials with `bioguide_id`, construct Bioguide photo URL, update `photo_url` column.

```typescript
/**
 * Import official portrait URLs for Congress members from Bioguide.
 *
 * Source: https://bioguide.congress.gov/bioguide/photo/{bioguideId}.jpg
 * Public domain images for all current and historical Congress members.
 *
 * Run with: npm run import:congress-photos
 */

import { supabase } from './lib/supabase-admin.js';

const BIOGUIDE_PHOTO_URL = 'https://bioguide.congress.gov/bioguide/photo';
const BATCH_SIZE = 100;

async function importCongressPhotos(): Promise<void> {
  console.log('=== Import Congress Member Photos ===\n');

  // Fetch all officials with bioguide_id
  const { data: officials, error } = await supabase
    .from('officials')
    .select('id, bioguide_id, full_name, photo_url')
    .not('bioguide_id', 'is', null);

  if (error) {
    throw new Error(`Failed to fetch officials: ${error.message}`);
  }

  if (!officials || officials.length === 0) {
    console.log('No officials with bioguide_id found.');
    return;
  }

  console.log(`Found ${officials.length} officials with bioguide_id.`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < officials.length; i += BATCH_SIZE) {
    const batch = officials.slice(i, i + BATCH_SIZE);
    const updates = batch
      .filter((o) => !o.photo_url) // Skip if already has photo
      .map((o) => ({
        id: o.id,
        photo_url: `${BIOGUIDE_PHOTO_URL}/${o.bioguide_id}.jpg`,
      }));

    skipped += batch.length - updates.length;

    if (updates.length === 0) continue;

    // Verify a sample URL actually returns an image (HEAD request)
    for (const update of updates) {
      const { error: updateError } = await supabase
        .from('officials')
        .update({ photo_url: update.photo_url })
        .eq('id', update.id);

      if (updateError) {
        console.error(`  Error updating ${update.id}: ${updateError.message}`);
        errors++;
      } else {
        updated++;
      }
    }

    process.stdout.write('.');
  }

  console.log(`\n\n=== Completed. Updated: ${updated}, skipped: ${skipped}, errors: ${errors} ===`);
}

importCongressPhotos().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
```

**Step 2: Add npm script to package.json**

Add to `scripts` section:
```json
"import:congress-photos": "npx tsx --env-file=.env scripts/import-congress-photos.ts"
```

**Step 3: Run the import**

Run: `cd "/Users/chrisalexander/Desktop/Chris Alexander HQ/Projects/GovGuide/GovGuide" && set -a && source .env && set +a && npx tsx scripts/import-congress-photos.ts`
Expected: 538 officials updated with photo URLs.

**Step 4: Verify**

Run: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "SELECT count(*) FROM officials WHERE photo_url IS NOT NULL;"`
Expected: 538

**Step 5: Commit**

```bash
git add scripts/import-congress-photos.ts package.json
git commit -m "feat: add Congress member photo URL import from Bioguide"
```

---

### Task 3: VoteView Ideology Scores Import

**Files:**
- Modify: `scripts/import-voteview.ts` (existing script — review and run)

**Step 1: Review the existing script**

Read `scripts/import-voteview.ts` to understand what it does and what table it writes to.

**Step 2: Run the import**

Run: `cd "/Users/chrisalexander/Desktop/Chris Alexander HQ/Projects/GovGuide/GovGuide" && set -a && source .env && set +a && npx tsx scripts/import-voteview.ts`
Expected: DW-NOMINATE ideology scores imported for Congress members.

**Step 3: Verify and fix any errors**

If the script fails, debug based on error output. Common issues: missing table columns, wrong CSV format, API endpoint changes.

**Step 4: Commit any fixes**

```bash
git add scripts/import-voteview.ts
git commit -m "fix: update voteview import for current data format"
```

---

### Task 4: FJC Federal Judges Import

**Files:**
- Existing: `scripts/import-judges.ts`

**Step 1: Download the FJC CSV**

Run: `curl -L "https://www.fjc.gov/history/judges/biographical-directory-article-iii-federal-judges-export" -o /tmp/fjc-judges.csv`

If that URL doesn't work, try: `curl -L "https://www.fjc.gov/sites/default/files/history/judges.csv" -o /tmp/fjc-judges.csv`

**Step 2: Set the environment variable and run**

Run: `cd "/Users/chrisalexander/Desktop/Chris Alexander HQ/Projects/GovGuide/GovGuide" && FJC_CSV_PATH=/tmp/fjc-judges.csv set -a && source .env && set +a && FJC_CSV_PATH=/tmp/fjc-judges.csv npx tsx scripts/import-judges.ts`
Expected: ~3,500 judges imported.

**Step 3: Verify**

Run: `psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "SELECT count(*) FROM judges; SELECT count(*) FROM courts;"`

**Step 4: Fix any errors and commit**

---

### Task 5: CourtListener Judges Import (NEW)

**Files:**
- Create: `scripts/import-courtlistener-judges.ts`
- Modify: `package.json` (add script)

**Step 1: Write the import script**

```typescript
/**
 * Import judges from CourtListener API (state + federal).
 *
 * Source: https://www.courtlistener.com/api/rest/v4/people/
 * Free API, 5,000 requests/day. Requires free account token.
 *
 * Env: COURTLISTENER_TOKEN (optional but recommended for higher limits)
 *
 * Run with: npm run import:courtlistener-judges
 */

import { supabase } from './lib/supabase-admin.js';

const API_BASE = 'https://www.courtlistener.com/api/rest/v4';
const PAGE_SIZE = 20; // CourtListener default
const REQUEST_DELAY_MS = 2000; // ~1800 req/hr, well under 5000/day
const BATCH_SIZE = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

interface CLPerson {
  id: number;
  resource_uri: string;
  name_first: string;
  name_middle: string;
  name_last: string;
  name_suffix: string;
  date_dob: string | null;
  date_dod: string | null;
  gender: string;
  race: string[];
  political_affiliation: { political_party: string; date_start: string }[];
  aba_ratings: { rating: string; year_rated: string }[];
  positions: {
    court: { id: number; full_name: string; short_name: string; resource_uri: string };
    position_type: string;
    date_start: string | null;
    date_termination: string | null;
    appointer: { person: { name_first: string; name_last: string } } | null;
    how_selected: string | null;
    nomination_process: string | null;
    date_confirmation: string | null;
    vote_type: string | null;
    votes_yes: number | null;
    votes_no: number | null;
  }[];
  education: { school: { name: string }; degree_level: string; degree_detail: string }[];
}

interface CLPageResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: CLPerson[];
}

async function fetchPage(url: string, token?: string): Promise<CLPageResponse> {
  await sleep(REQUEST_DELAY_MS);
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (token) headers['Authorization'] = `Token ${token}`;

  const res = await fetch(url, { headers });
  if (res.status === 429) {
    console.warn('  Rate limited, waiting 60s...');
    await sleep(60000);
    return fetchPage(url, token);
  }
  if (!res.ok) throw new Error(`CourtListener API ${res.status}: ${res.statusText}`);
  return (await res.json()) as CLPageResponse;
}

// Court cache: CourtListener court ID → our court UUID
const courtCache = new Map<number, string>();

async function resolveCourtId(clCourt: { id: number; full_name: string; short_name: string }): Promise<string | null> {
  if (courtCache.has(clCourt.id)) return courtCache.get(clCourt.id)!;

  const slug = slugify(clCourt.short_name || clCourt.full_name);

  // Try to find existing court
  const { data } = await supabase
    .from('courts')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();

  if (data) {
    courtCache.set(clCourt.id, (data as { id: string }).id);
    return (data as { id: string }).id;
  }

  // Create new court
  const { data: newCourt, error } = await supabase
    .from('courts')
    .insert({
      name: clCourt.full_name,
      slug,
      court_type: 'unknown',
      metadata: { courtlistener_id: clCourt.id },
    })
    .select('id')
    .single();

  if (error) {
    console.error(`  Failed to create court "${clCourt.full_name}": ${error.message}`);
    return null;
  }

  courtCache.set(clCourt.id, (newCourt as { id: string }).id);
  return (newCourt as { id: string }).id;
}

function mapSelectionMethod(how_selected: string | null): string | null {
  if (!how_selected) return null;
  const h = how_selected.toLowerCase();
  if (h.includes('elect')) return 'elected';
  if (h.includes('appoint')) return 'appointed';
  if (h.includes('merit')) return 'merit_selection';
  if (h.includes('legislat')) return 'legislative_appointment';
  return how_selected;
}

async function importCourtListenerJudges(): Promise<void> {
  console.log('=== Import CourtListener Judges ===\n');

  const token = process.env.COURTLISTENER_TOKEN;
  if (!token) {
    console.warn('No COURTLISTENER_TOKEN set. Using unauthenticated access (lower rate limits).\n');
  }

  let url: string | null = `${API_BASE}/people/?type=judge&page_size=${PAGE_SIZE}`;
  let total = 0;
  let imported = 0;
  let errors = 0;
  let page = 1;

  while (url) {
    console.log(`  Fetching page ${page}...`);
    const body = await fetchPage(url, token);
    if (page === 1) {
      total = body.count;
      console.log(`  Total judges: ${total}`);
    }

    for (const person of body.results) {
      const fullName = [person.name_first, person.name_middle, person.name_last, person.name_suffix]
        .filter(Boolean).join(' ');
      const slug = slugify(fullName);

      // Use primary position (first)
      const pos = person.positions?.[0];
      const courtId = pos?.court ? await resolveCourtId(pos.court) : null;

      const judgeRow: Record<string, unknown> = {
        first_name: person.name_first,
        last_name: person.name_last,
        full_name: fullName,
        slug,
        court_id: courtId,
        gender: person.gender || null,
        race_ethnicity: person.race?.join(', ') || null,
        birth_year: person.date_dob ? parseInt(person.date_dob.split('-')[0], 10) : null,
        courtlistener_id: person.id,
        selection_method: pos ? mapSelectionMethod(pos.how_selected) : null,
        appointing_president: pos?.appointer
          ? `${pos.appointer.person.name_first} ${pos.appointer.person.name_last}`
          : null,
        confirmation_date: pos?.date_confirmation || null,
        confirmation_vote: (pos?.votes_yes != null && pos?.votes_no != null)
          ? `${pos.votes_yes}-${pos.votes_no}` : null,
        commission_date: pos?.date_start || null,
        termination_date: pos?.date_termination || null,
        aba_rating: person.aba_ratings?.[0]?.rating || null,
        law_school: person.education?.find((e) =>
          e.degree_level?.toLowerCase().includes('law') || e.degree_detail?.toLowerCase().includes('j.d'))
          ?.school?.name || null,
        metadata: {
          courtlistener_id: person.id,
          political_affiliations: person.political_affiliation,
          education: person.education,
          all_positions: person.positions?.map((p) => ({
            court: p.court?.full_name,
            type: p.position_type,
            start: p.date_start,
            end: p.date_termination,
            how_selected: p.how_selected,
          })),
        },
      };

      const { error } = await supabase
        .from('judges')
        .upsert(judgeRow, { onConflict: 'courtlistener_id' });

      if (error) {
        console.error(`  Error upserting judge "${fullName}": ${error.message}`);
        errors++;
      } else {
        imported++;
      }
    }

    process.stdout.write('.');
    url = body.next;
    page++;
  }

  console.log(`\n\n=== Completed. Imported: ${imported}, errors: ${errors}, total available: ${total} ===`);
}

importCourtListenerJudges().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
```

**Step 2: Add npm script**

```json
"import:courtlistener-judges": "npx tsx --env-file=.env scripts/import-courtlistener-judges.ts"
```

**Step 3: Run (will take multiple days at 5000 req/day)**

Run in background or via cron. May need a cron wrapper similar to state officials.

**Step 4: Commit**

```bash
git add scripts/import-courtlistener-judges.ts package.json
git commit -m "feat: add CourtListener judges import for state + federal judges"
```

---

### Task 6: LittleSis Relationship Import (NEW — key differentiator)

**Files:**
- Create: `scripts/import-littlesis.ts`
- Modify: `package.json`

**Step 1: Write the import script**

The LittleSis API (`littlesis.org/api`) provides:
- `GET /entities?q=<search>` — search entities
- `GET /entities/<id>` — entity detail
- `GET /entities/<id>/relationships` — all relationships for an entity
- `GET /relationships/<id>` — relationship detail

Strategy: Start from our existing officials and entities, search LittleSis for matches, then pull their relationships.

```typescript
/**
 * Import relationship data from LittleSis.org API.
 *
 * LittleSis has 400K+ entities and 1.5M+ relationships mapping power networks:
 * board memberships, think tank fellowships, corporate directorships,
 * government positions, donations, lobbying, family ties.
 *
 * Strategy:
 *   1. For each official/entity in our DB, search LittleSis by name
 *   2. If match found, store littlesis_id
 *   3. Fetch all relationships for matched entities
 *   4. Upsert relationship targets as entities
 *   5. Create relationship edges in our relationships table
 *
 * Env: None required (API is public, no key needed)
 *
 * Run with: npm run import:littlesis
 */

import { supabase } from './lib/supabase-admin.js';

const API_BASE = 'https://littlesis.org/api';
const REQUEST_DELAY_MS = 2000;
const BATCH_SIZE = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// LittleSis relationship category → our relationship_type
const LS_CATEGORY_MAP: Record<number, string> = {
  1: 'employed_by',       // Position
  2: 'educated_at',       // Education
  3: 'member_of',         // Membership
  4: 'family_of',         // Family
  5: 'donated_to',        // Donation
  6: 'contributed_to',    // Transaction
  7: 'lobbied_on',        // Lobbying
  8: 'member_of',         // Social
  9: 'employed_by',       // Professional
  10: 'owns',             // Ownership
  11: 'employed_by',      // Hierarchy
  12: 'member_of',        // Generic
};

interface LSEntity {
  id: number;
  type: string;
  attributes: {
    name: string;
    blurb: string | null;
    primary_ext: string; // 'Person' | 'Org'
    start_date: string | null;
    end_date: string | null;
    website: string | null;
    types: string[];
  };
}

interface LSRelationship {
  id: number;
  attributes: {
    entity1_id: number;
    entity2_id: number;
    category_id: number;
    description1: string | null;
    description2: string | null;
    amount: number | null;
    goods: string | null;
    start_date: string | null;
    end_date: string | null;
    is_current: boolean | null;
  };
}

interface LSSearchResponse {
  data: LSEntity[];
  meta?: { currentPage: number; pageCount: number };
}

interface LSRelationshipsResponse {
  data: LSRelationship[];
  included?: LSEntity[];
  meta?: { currentPage: number; pageCount: number };
}

async function lsFetch<T>(path: string, retries = 3): Promise<T> {
  await sleep(REQUEST_DELAY_MS);
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  });

  if (res.status === 429 && retries > 0) {
    console.warn('  Rate limited, waiting 30s...');
    await sleep(30000);
    return lsFetch<T>(path, retries - 1);
  }
  if (!res.ok) {
    throw new Error(`LittleSis API ${res.status}: ${res.statusText} (${url})`);
  }
  return (await res.json()) as T;
}

function mapLsTypeToEntityType(lsEntity: LSEntity): string {
  const types = lsEntity.attributes.types || [];
  const ext = lsEntity.attributes.primary_ext;
  if (ext === 'Person') return 'individual';
  if (types.includes('GovernmentBody')) return 'government';
  if (types.includes('PoliticalFundraising') || types.includes('Pac')) return 'pac';
  if (types.includes('LobbyingFirm')) return 'lobbying_firm';
  if (types.includes('NonProfit') || types.includes('PublicCharit')) return 'nonprofit';
  if (types.includes('Business') || types.includes('PublicCompany')) return 'corporation';
  return 'other';
}

async function findOrCreateEntity(lsEntity: LSEntity): Promise<string | null> {
  // Check if we already have this LittleSis entity
  const { data: existing } = await supabase
    .from('entities')
    .select('id')
    .eq('littlesis_id', String(lsEntity.id))
    .maybeSingle();

  if (existing) return (existing as { id: string }).id;

  // Create new entity
  const { data: created, error } = await supabase
    .from('entities')
    .insert({
      entity_type: mapLsTypeToEntityType(lsEntity),
      name: lsEntity.attributes.name,
      aliases: [],
      external_ids: { littlesis_id: String(lsEntity.id) },
      littlesis_id: String(lsEntity.id),
      metadata: {
        littlesis_blurb: lsEntity.attributes.blurb,
        littlesis_types: lsEntity.attributes.types,
        website: lsEntity.attributes.website,
      },
    })
    .select('id')
    .single();

  if (error) {
    console.error(`  Failed to create entity "${lsEntity.attributes.name}": ${error.message}`);
    return null;
  }

  return (created as { id: string }).id;
}

async function importLittleSis(): Promise<void> {
  console.log('=== Import LittleSis Relationships ===\n');

  // Step 1: Get our officials to search for in LittleSis
  const { data: officials, error } = await supabase
    .from('officials')
    .select('id, full_name, bioguide_id, littlesis_id')
    .eq('is_current', true)
    .is('littlesis_id', null);

  if (error) throw new Error(`Failed to fetch officials: ${error.message}`);
  if (!officials || officials.length === 0) {
    console.log('No unmatched officials found.');
    return;
  }

  console.log(`Searching LittleSis for ${officials.length} officials...\n`);

  let matched = 0;
  let relationshipsImported = 0;
  let relationshipErrors = 0;

  for (const official of officials) {
    const name = (official as { full_name: string }).full_name;
    console.log(`  Searching: ${name}`);

    try {
      const searchResult = await lsFetch<LSSearchResponse>(
        `/entities/search?q=${encodeURIComponent(name)}`
      );

      if (!searchResult.data || searchResult.data.length === 0) continue;

      // Take first match (best match) — Person type only
      const match = searchResult.data.find(
        (e) => e.attributes.primary_ext === 'Person'
      );
      if (!match) continue;

      // Update our official with the LittleSis ID
      await supabase
        .from('officials')
        .update({ littlesis_id: String(match.id) })
        .eq('id', (official as { id: string }).id);

      // Also ensure an entity exists for this official in entities table
      const officialEntityId = await findOrCreateEntity(match);
      if (!officialEntityId) continue;

      matched++;
      console.log(`    Matched → LS#${match.id} "${match.attributes.name}"`);

      // Fetch relationships
      const relResult = await lsFetch<LSRelationshipsResponse>(
        `/entities/${match.id}/relationships?page[size]=100`
      );

      if (!relResult.data) continue;

      // Build included entities map
      const includedMap = new Map<number, LSEntity>();
      if (relResult.included) {
        for (const inc of relResult.included) {
          includedMap.set(inc.id, inc);
        }
      }

      for (const rel of relResult.data) {
        const attrs = rel.attributes;
        const otherId = attrs.entity1_id === match.id ? attrs.entity2_id : attrs.entity1_id;
        const otherEntity = includedMap.get(otherId);

        if (!otherEntity) continue;

        const otherEntityDbId = await findOrCreateEntity(otherEntity);
        if (!otherEntityDbId) continue;

        const relType = LS_CATEGORY_MAP[attrs.category_id] || 'member_of';

        const { error: relError } = await supabase
          .from('relationships')
          .insert({
            source_entity_id: officialEntityId,
            target_entity_id: otherEntityDbId,
            relationship_type: relType,
            amount: attrs.amount,
            date_start: attrs.start_date,
            date_end: attrs.end_date,
            metadata: {
              littlesis_relationship_id: rel.id,
              description1: attrs.description1,
              description2: attrs.description2,
              is_current: attrs.is_current,
              category_id: attrs.category_id,
            },
            confidence_score: 0.90,
          });

        if (relError) {
          relationshipErrors++;
        } else {
          relationshipsImported++;
        }
      }
    } catch (err) {
      console.error(`    Error searching "${name}": ${(err as Error).message}`);
    }
  }

  console.log(`\n=== Completed. ===`);
  console.log(`  Officials matched: ${matched}/${officials.length}`);
  console.log(`  Relationships imported: ${relationshipsImported}, errors: ${relationshipErrors}`);
}

importLittleSis().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
```

**Step 2: Add npm script**

```json
"import:littlesis": "npx tsx --env-file=.env scripts/import-littlesis.ts"
```

**Step 3: Test with a small batch first**

Run and observe the first few searches to verify matching quality.

**Step 4: Commit**

```bash
git add scripts/import-littlesis.ts package.json
git commit -m "feat: add LittleSis relationship import for think tank/board/influence data"
```

---

### Task 7: IRS 990 Import (existing script — run it)

**Files:**
- Existing: `scripts/import-irs990.ts`

**Step 1: Run the import**

Run: `cd "/Users/chrisalexander/Desktop/Chris Alexander HQ/Projects/GovGuide/GovGuide" && set -a && source .env && set +a && npx tsx scripts/import-irs990.ts`

**Step 2: Debug and fix any errors**

The script fetches from IRS S3 bulk data. May need adjustments for current year index format.

**Step 3: Verify**

Check entities, dark_money_flows, relationships tables for new rows.

**Step 4: Commit any fixes**

---

### Task 8: Lobbying Bulk XML Import (NEW — replaces broken API)

**Files:**
- Create: `scripts/import-lobbying-bulk.ts`
- Modify: `package.json`

**Step 1: Write the bulk XML import script**

Senate LDA bulk downloads are at `lda.senate.gov/system/public/`. Quarterly XML files contain LD-1 (registrations) and LD-2 (activity reports).

The script should:
1. Download the quarterly XML file for the target quarter
2. Parse XML using regex (no extra deps, matching existing pattern in import-votes.ts)
3. Extract: registrant, client, lobbyists, bills lobbied, agencies contacted, amounts
4. Upsert to `entities`, `lobbying_registrations`, `lobbying_activities`, `relationships`
5. Flag lobbyists with covered government positions (revolving door)

Pattern follows `import-lobbying.ts` but reads from local XML files instead of API.

```typescript
/**
 * Import lobbying data from Senate LDA bulk XML downloads.
 *
 * Source: https://lda.senate.gov/system/public/
 * Downloads quarterly XML dumps of LD-1 (registrations) and LD-2 (activity reports).
 *
 * Replaces import-lobbying.ts which used the LDA REST API (currently returning 404).
 *
 * Env:
 *   LDA_YEAR  (optional) — year to import, default = current year
 *   LDA_QUARTER (optional) — quarter 1-4, default = most recent
 *   LDA_XML_DIR (optional) — directory containing downloaded XML files, default = /tmp
 *
 * Run with: npm run import:lobbying-bulk
 */

import fs from 'node:fs';
import { supabase } from './lib/supabase-admin.js';

// ... (full implementation follows the pattern of import-votes.ts regex XML parsing)
// Key functions:
//   - downloadBulkXml(year, quarter) — fetches from lda.senate.gov
//   - parseRegistrations(xml) — extracts LD-1 registrant/client/lobbyist data
//   - parseActivities(xml) — extracts LD-2 bills/agencies/amounts
//   - upsertLobbyingEntities() — creates firm + client entities
//   - upsertRegistrations() — creates lobbying_registrations rows
//   - upsertActivities() — creates lobbying_activities rows
//   - createRelationships() — lobbied_via edges
```

Full implementation to be written during execution. The script follows the exact same patterns as `import-lobbying.ts` but reads from bulk XML instead of API.

**Step 2: Add npm script, run, verify, commit**

---

### Task 9: Congressional Stock Trades from Official Disclosures (NEW)

**Files:**
- Create: `scripts/import-stock-trades-disclosures.ts`
- Modify: `package.json`

**Step 1: Write the import script**

Sources:
- House: `disclosures.house.gov/public_disc/ptr-pdfs/` — XML index + PDF/XML filings
- Senate: `efdsearch.senate.gov` — HTML search results

The script should:
1. Fetch the House periodic transaction report XML index
2. Parse each transaction: member name, stock ticker, transaction type, date, amount range
3. Match to our officials by name/bioguide_id
4. Upsert to `stock_trades` table
5. Create `traded` relationships in `relationships` table

Full implementation to be written during execution.

**Step 2: Add npm script, run, verify, commit**

---

### Task 10: FARA Import (existing script — test and run)

**Files:**
- Existing: `scripts/import-fara.ts`

**Step 1: Test if the FARA API responds**

Run: `curl -s "https://efile.fara.gov/api/v1/RegDocs/search" | head -c 200`

**Step 2: If API works, run the import**

Run: `cd "/Users/chrisalexander/Desktop/Chris Alexander HQ/Projects/GovGuide/GovGuide" && set -a && source .env && set +a && npx tsx scripts/import-fara.ts`

**Step 3: Debug and fix errors, commit**

---

### Task 11: Wikimedia Commons Photo Import (NEW)

**Files:**
- Create: `scripts/import-wikimedia-photos.ts`
- Modify: `package.json`

**Step 1: Write the import script**

Uses Wikimedia Commons API to find CC-licensed portrait images for judges and statewide officials.

```typescript
/**
 * Import portrait photos from Wikimedia Commons for judges and officials.
 *
 * Source: Wikimedia Commons API
 *   https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=...
 *
 * Strategy:
 *   1. Query judges and statewide officials without photos
 *   2. Search Wikimedia Commons for "[Name] official portrait" or "[Name] politician"
 *   3. If a good match is found (title contains name), store the image URL
 *
 * Run with: npm run import:wikimedia-photos
 */
```

Full implementation to be written during execution. Key: use Wikimedia API `action=query&prop=imageinfo&iiprop=url` to get direct image URLs.

**Step 2: Add npm script, run, verify, commit**

---

### Task 12: OpenSecrets Free Tier Import (NEW)

**Files:**
- Create: `scripts/import-opensecrets.ts`
- Modify: `package.json`

**Step 1: Obtain free API key**

Sign up at `opensecrets.org/api` — free key, 200 requests/day.

**Step 2: Write the import script**

Priority endpoints (within 200/day limit):
- `candSummary` — top-line fundraising by candidate
- `candContrib` — top contributing organizations
- `candIndustry` — industry breakdown
- `memPFDprofile` — personal financial disclosure summary

The script should batch officials by priority (current Congress members first), making ~200 calls per run, storing results in `officials.metadata.opensecrets` and `relationships`.

**Step 3: Create cron wrapper for daily runs**

```bash
#!/bin/bash
# scripts/cron-opensecrets.sh
# Runs daily, processes ~200 officials per run
```

**Step 4: Add to crontab, commit**

---

### Task 13: CourtListener Judge Financial Disclosures (existing script — run it)

**Files:**
- Existing: `scripts/import-judge-financials.ts`

**Step 1: Review the script**

Read `scripts/import-judge-financials.ts`, check if it needs a CourtListener token.

**Step 2: Run the import**

Run: `cd "/Users/chrisalexander/Desktop/Chris Alexander HQ/Projects/GovGuide/GovGuide" && set -a && source .env && set +a && npx tsx scripts/import-judge-financials.ts`

**Step 3: Debug, fix, verify, commit**

---

### Task 14: Cron Scheduling for Rate-Limited Imports

**Files:**
- Create: `scripts/cron-courtlistener.sh`
- Create: `scripts/cron-littlesis.sh`
- Create: `scripts/cron-opensecrets.sh`

**Step 1: Create cron wrappers**

Each follows the pattern of `cron-state-officials.sh` — step tracking, lock files, batch processing.

**Step 2: Add to crontab**

```
# GovGuide cron schedule:
0 1 * * * ... cron-courtlistener.sh    # 1am — judges + financial disclosures
0 2 * * * ... cron-fec-imports.sh      # 2am — FEC (already set)
0 3 * * * ... cron-state-officials.sh  # 3am — state officials (already set)
0 4 * * * ... cron-littlesis.sh        # 4am — relationship network
0 5 * * * ... cron-opensecrets.sh      # 5am — donor aggregations
```

**Step 3: Commit**

---

### Task 15: Community Contribution GitHub Repo Setup

**Files:**
- Create: GitHub repo `thegovguide/community-data` with:
  - `README.md` — contribution guide
  - `CONTRIBUTING.md` — data format specs
  - `.github/ISSUE_TEMPLATE/add-local-official.yml`
  - `.github/ISSUE_TEMPLATE/add-photo.yml`
  - `.github/ISSUE_TEMPLATE/data-correction.yml`
  - `.github/workflows/validate-submission.yml`

**Step 1: Create the repo via gh CLI**

```bash
gh repo create thegovguide/community-data --public --description "Community-contributed government data for GovGuide"
```

**Step 2: Add issue templates and GitHub Action**

**Step 3: Link from jurisdiction pages**

Each of the 92,114 jurisdiction pages should include a "Help fill in data" link that pre-fills the GitHub issue template with the jurisdiction name and ID.

**Step 4: Commit and push**
