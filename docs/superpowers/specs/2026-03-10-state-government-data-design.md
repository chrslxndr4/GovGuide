# State Government Data Collection — Design Spec

**Date:** 2026-03-10
**Status:** Approved

## Goal

Populate GovGuide with comprehensive state government data for all 50 states + DC: statewide executives, state courts and judges, and other public offices.

## What Already Exists

| Data | Script | Source |
|---|---|---|
| State legislators (senate + house) | `import-state-officials.ts` | OpenStates API |
| Governors | `import-state-officials.ts` | OpenStates API |
| Federal judges | `import-judges.ts` | FJC CSV |

No changes needed to existing scripts.

## What's New

| Data | Script | Source |
|---|---|---|
| Statewide executives (AG, SoS, Treasurer, Lt Gov, etc.) | `import-statewide-executives.ts` | Static JSON |
| State courts + judges (supreme + appellate) | `import-state-courts.ts` | Static JSON |
| Other public offices (commissioners, regulators, etc.) | `import-statewide-executives.ts` | Static JSON |

## Schema

**Canonical migration:** `012_judicial.sql` (enum-based, with `slug`, `website`, `first_name`/`last_name` on judges).

**One migration required:** Add a unique constraint on `officials(slug, office_id)` to support upsert deduplication. The existing `import-state-officials.ts` already uses `onConflict: 'slug,office_id'` but no unique index backs it.

```sql
-- New migration: 0XX_officials_unique_constraint.sql
CREATE UNIQUE INDEX idx_officials_slug_office ON officials(slug, office_id);
```

**Existing tables used (no other changes):**

- **`offices`** — statewide executive positions and other public offices (`branch: 'executive'`, `chamber: null`, linked to state `jurisdiction_id`)
- **`officials`** — officeholders with name, party, contact info, term dates
- **`courts`** — state court structures (uses `court_type` enum values: `state_supreme`, `state_appellate`, `state_trial`, `special`)
- **`judges`** — state court justices and judges (has `first_name`, `last_name`, `full_name`, `appointing_president` text, `slug`)

## Deliverables

### 1. Data Files

#### `data/statewide-executives.json`

All 50 states + DC. Contains Tier A (statewide executives) and Tier C (other public offices).

```json
{
  "AL": {
    "offices": [
      {
        "title": "Lieutenant Governor",
        "branch": "executive",
        "is_elected": true,
        "official": {
          "first_name": "Will",
          "last_name": "Ainsworth",
          "party": "republican",
          "email": null,
          "phone": "(334) 242-7900",
          "website": "https://ltgov.alabama.gov/",
          "photo_url": null,
          "term_start": "2023-01-16",
          "term_end": "2027-01-18"
        }
      }
    ]
  }
}
```

**Import script derives:** `full_name` from `first_name + last_name`, `slug` from `slugify(first-last-stateAbbr)` (matching existing pattern in `import-state-officials.ts`).

**Offices covered per state (varies, ~8-12 typical):**
- Lieutenant Governor
- Attorney General
- Secretary of State
- State Treasurer / Comptroller
- State Auditor
- Superintendent of Public Instruction
- Commissioner of Agriculture
- Commissioner of Insurance
- Commissioner of Labor
- Land Commissioner (where applicable)
- Public Utility / Public Service Commissioners
- Railroad / Corporation Commissioners
- Other statewide elected officials

**Tier C long-tail scope:**
- Offices that appear on statewide ballots
- Major regulatory commissioners (PUC, insurance, corporation commissions)
- Skip appointed advisory boards and minor administrative positions

#### `data/state-courts.json`

Court structures for all 50 states + DC with current justices for supreme + appellate courts.

```json
{
  "AL": {
    "courts": [
      {
        "name": "Supreme Court of Alabama",
        "court_type": "state_supreme",
        "website": "https://judicial.alabama.gov/",
        "selection_method": "partisan_election",
        "num_seats": 9,
        "judges": [
          {
            "first_name": "Tom",
            "last_name": "Parker",
            "full_name": "Tom Parker",
            "appointing_president": null,
            "term_start": "2019-01-15",
            "term_end": "2025-01-15"
          }
        ]
      },
      {
        "name": "Alabama Court of Civil Appeals",
        "court_type": "state_appellate",
        "website": "https://judicial.alabama.gov/",
        "selection_method": "partisan_election",
        "num_seats": 5,
        "judges": []
      },
      {
        "name": "Alabama Circuit Courts",
        "court_type": "state_trial",
        "website": "https://judicial.alabama.gov/",
        "selection_method": "partisan_election",
        "num_seats": null,
        "judges": []
      }
    ]
  }
}
```

**Court type mapping (uses existing `court_type` enum from `012_judicial.sql`):**
- Court of last resort (Supreme Court, Court of Appeals in NY/MD, Supreme Judicial Court in MA/ME) -> `state_supreme`
- Intermediate appellate courts -> `state_appellate`
- General trial courts (Superior, Circuit, District) -> `state_trial`
- Limited jurisdiction courts (probate, family, municipal) -> `special`

**Metadata stored in `courts.metadata` JSONB:**
- `selection_method` — one of: `partisan_election`, `nonpartisan_election`, `gubernatorial_appointment`, `legislative_appointment`, `merit_selection`, `assisted_appointment`
- `num_seats` — integer or null
- `role` — for judges (e.g., "Chief Justice"), stored in `judges.metadata.role`

**Judge field mapping to `judges` table columns:**
- `first_name` -> `first_name`
- `last_name` -> `last_name`
- `full_name` -> `full_name`
- `appointing_president` -> `appointing_president` (text column, null for elected judges)
- `term_start` -> `commission_date` (closest column — date they took the bench)
- `term_end` -> stored in `metadata.term_end` (no direct column; `termination_date` is for when they leave)
- Active status derived from `termination_date IS NULL` (matching existing pattern)

**Slug generation for judges:** `slugify(fullName-stateAbbr-courtType)` since there is no external NID. If collisions occur, append a numeric suffix.

**Entity records:** State judges get `entities` rows (entity_type: 'judge') for consistency with federal judges and to support the graph/conflict-detection system. The import script creates the entity first, then links via `judges.entity_id`.

**Judge scope:** Supreme court justices (~350) + appellate judges (~1,000). Trial court judges (~30,000+) deferred to later phase — court structures are created but judges array left empty.

### 2. Import Scripts

#### `scripts/import-statewide-executives.ts`

- Reads `data/statewide-executives.json`
- Supports `STATES=AL,AK` env var for partial imports (matching existing pattern)
- For each state: resolves `jurisdiction_id` from `jurisdictions` table
- Creates/upserts `offices` rows (slug: `{state_abbr}-{slugified-title}`)
- Derives `full_name` from `first_name + last_name`
- Derives `slug` from `slugify(first-last-stateAbbr)`
- Creates/upserts `officials` rows linked to offices
- Batch upserts (100 records), conflict resolution on `slug,office_id` (requires new unique index)
- Follows same patterns as existing `import-state-officials.ts`

#### `scripts/import-state-courts.ts`

- Reads `data/state-courts.json`
- Supports `STATES=AL,AK` env var for partial imports
- For each state: resolves `jurisdiction_id`
- Creates/upserts `courts` rows with state jurisdiction IDs, `selection_method` and `num_seats` in `metadata`
- Creates `entities` rows (entity_type: 'judge') for each judge
- Creates/upserts `judges` rows linked to courts and entities
- Stores `role` and `term_end` in `judges.metadata`
- Generates judge slugs: `slugify(fullName-stateAbbr-courtType)`
- Batch upserts on `courts` by name+jurisdiction_id, on `judges` by `slug`

### 3. Migration

```sql
-- supabase/migrations/0XX_officials_unique_constraint.sql
CREATE UNIQUE INDEX idx_officials_slug_office ON officials(slug, office_id);
```

### 4. npm Scripts

Add to `package.json`:
- `import:statewide-executives` -> `npx tsx --env-file=.env scripts/import-statewide-executives.ts`
- `import:state-courts` -> `npx tsx --env-file=.env scripts/import-state-courts.ts`

## Estimated Data Volume

- ~400-500 statewide executive officials
- ~250 court structures (~5 per state average)
- ~1,400 supreme + appellate court judges
- ~200-300 other public office holders

## Refresh Strategy

- **OpenStates data** (legislators + governors): automated cron via existing `cron-state-officials.sh`
- **Static JSON data** (executives, courts, other offices): manually updated when officeholders change (elections, appointments, retirements). Could eventually be supplemented by scraping state election results or court websites.

## Priority Order

1. **Tier A** — Statewide executives (AG, SoS, Treasurer, Lt Gov, etc.)
2. **Tier B** — State courts and judges
3. **Tier C** — Other public offices (commissioners, regulators)
