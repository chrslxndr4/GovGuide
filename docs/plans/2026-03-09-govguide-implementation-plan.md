# GovGuide Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a comprehensive, free, public civic dashboard mapping every level of US government with interactive maps, election tools, and drill-down navigation.

**Architecture:** Astro hybrid site (static pages + SSR endpoints), MapLibre GL JS with PMTiles for interactive maps, Supabase (PostgreSQL + PostGIS) for data storage. React islands for interactive components. No user accounts.

**Tech Stack:** Astro 5+, React 19, MapLibre GL JS, PMTiles, Supabase, TypeScript, Tailwind CSS

---

## Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `astro.config.mjs`
- Create: `tsconfig.json`
- Create: `tailwind.config.mjs`
- Create: `src/layouts/BaseLayout.astro`
- Create: `src/pages/index.astro`
- Create: `src/styles/global.css`
- Create: `.gitignore`
- Create: `.env.example`

**Step 1: Initialize Astro project**

```bash
npm create astro@latest . -- --template minimal --no-install --no-git --typescript strict
```

**Step 2: Install dependencies**

```bash
npm install @astrojs/react @astrojs/tailwind @astrojs/node react react-dom maplibre-gl pmtiles @supabase/supabase-js
npm install -D @types/react @types/react-dom tailwindcss typescript
```

**Step 3: Configure Astro**

`astro.config.mjs`:
```javascript
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';
import node from '@astrojs/node';

export default defineConfig({
  integrations: [react(), tailwind()],
  adapter: node({ mode: 'standalone' }),
  output: 'static',
});
```

**Step 4: Create Tailwind config**

`tailwind.config.mjs`:
```javascript
export default {
  content: ['./src/**/*.{astro,html,js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        civic: {
          navy: '#1B2A4A',
          blue: '#2563EB',
          red: '#DC2626',
          gold: '#D97706',
          slate: '#475569',
          light: '#F8FAFC',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Plus Jakarta Sans', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
    },
  },
  plugins: [],
};
```

**Step 5: Create global styles**

`src/styles/global.css`:
```css
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  html {
    @apply antialiased text-slate-800 bg-civic-light;
  }
  h1, h2, h3, h4 {
    @apply font-display font-bold tracking-tight;
  }
}
```

**Step 6: Create base layout**

`src/layouts/BaseLayout.astro`:
```astro
---
interface Props {
  title: string;
  description?: string;
}
const { title, description = 'Your complete guide to American government at every level.' } = Astro.props;
---
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content={description} />
    <title>{title} | GovGuide</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@600;700;800&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet" />
  </head>
  <body class="min-h-screen flex flex-col">
    <slot />
  </body>
</html>
```

**Step 7: Create placeholder homepage**

`src/pages/index.astro`:
```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
---
<BaseLayout title="Home">
  <main class="flex-1 flex items-center justify-center">
    <div class="text-center">
      <h1 class="text-5xl font-display text-civic-navy mb-4">GovGuide</h1>
      <p class="text-xl text-civic-slate">Your complete guide to American government.</p>
    </div>
  </main>
</BaseLayout>
```

**Step 8: Create .env.example**

`.env.example`:
```
PUBLIC_SUPABASE_URL=
PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
GOOGLE_CIVIC_API_KEY=
FEC_API_KEY=
CONGRESS_API_KEY=
OPENSTATES_API_KEY=
PROPUBLICA_API_KEY=
CENSUS_API_KEY=
```

**Step 9: Create .gitignore**

`.gitignore`:
```
node_modules/
dist/
.astro/
.env
.DS_Store
```

**Step 10: Verify build**

```bash
npm run build
```

Expected: Build succeeds, `dist/` directory created.

**Step 11: Commit**

```bash
git add package.json astro.config.mjs tsconfig.json tailwind.config.mjs src/ .gitignore .env.example
git commit -m "feat: scaffold Astro project with React, Tailwind, MapLibre, Supabase"
```

---

## Task 2: Design System & Shared Components

**Files:**
- Create: `src/components/Header.astro`
- Create: `src/components/Footer.astro`
- Create: `src/components/Breadcrumb.astro`
- Create: `src/components/CategoryCard.astro`
- Create: `src/components/InfoBlock.astro`
- Create: `src/components/ScopeSwitcher.tsx`

**Step 1: Create Header**

`src/components/Header.astro`:
```astro
---
const navItems = [
  { label: 'Federal', href: '/federal' },
  { label: 'States', href: '/states' },
  { label: 'Elections', href: '/elections' },
  { label: 'Laws', href: '/laws' },
  { label: 'Officials', href: '/officials' },
];
---
<header class="bg-civic-navy text-white">
  <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
    <a href="/" class="font-display text-2xl font-bold tracking-tight">GovGuide</a>
    <nav class="hidden md:flex gap-6">
      {navItems.map(item => (
        <a href={item.href} class="text-sm font-medium text-slate-300 hover:text-white transition-colors">
          {item.label}
        </a>
      ))}
    </nav>
  </div>
</header>
```

**Step 2: Create Footer**

`src/components/Footer.astro`:
```astro
<footer class="bg-civic-navy text-slate-400 mt-auto">
  <div class="max-w-7xl mx-auto px-4 py-8">
    <div class="flex flex-col md:flex-row justify-between items-center gap-4">
      <p class="text-sm">GovGuide — Free, public, open-source civic data.</p>
      <p class="text-xs">Data sourced from official government APIs and public records.</p>
    </div>
  </div>
</footer>
```

**Step 3: Create Breadcrumb**

`src/components/Breadcrumb.astro`:
```astro
---
interface BreadcrumbItem {
  label: string;
  href?: string;
}
interface Props {
  items: BreadcrumbItem[];
}
const { items } = Astro.props;
---
<nav aria-label="Breadcrumb" class="text-sm text-civic-slate mb-6">
  <ol class="flex flex-wrap gap-1">
    <li><a href="/" class="hover:text-civic-blue">Home</a></li>
    {items.map((item, i) => (
      <li class="flex items-center gap-1">
        <span aria-hidden="true">/</span>
        {item.href ? (
          <a href={item.href} class="hover:text-civic-blue">{item.label}</a>
        ) : (
          <span class="text-slate-800 font-medium">{item.label}</span>
        )}
      </li>
    ))}
  </ol>
</nav>
```

**Step 4: Create CategoryCard**

`src/components/CategoryCard.astro`:
```astro
---
interface Props {
  title: string;
  description: string;
  href: string;
  count?: number;
}
const { title, description, href, count } = Astro.props;
---
<a href={href} class="block p-5 bg-white rounded-lg border border-slate-200 hover:border-civic-blue hover:shadow-md transition-all group">
  <div class="flex items-start justify-between">
    <h3 class="font-display text-lg text-civic-navy group-hover:text-civic-blue transition-colors">{title}</h3>
    {count !== undefined && (
      <span class="text-xs font-mono bg-slate-100 text-civic-slate px-2 py-0.5 rounded">{count}</span>
    )}
  </div>
  <p class="text-sm text-civic-slate mt-1">{description}</p>
</a>
```

**Step 5: Create InfoBlock**

`src/components/InfoBlock.astro`:
```astro
---
interface Props {
  label: string;
  value: string;
  href?: string;
}
const { label, value, href } = Astro.props;
---
<div class="py-2 border-b border-slate-100">
  <dt class="text-xs font-medium text-civic-slate uppercase tracking-wider">{label}</dt>
  <dd class="mt-0.5 text-sm text-slate-800">
    {href ? <a href={href} class="text-civic-blue hover:underline">{value}</a> : value}
  </dd>
</div>
```

**Step 6: Create ScopeSwitcher (React island)**

`src/components/ScopeSwitcher.tsx`:
```tsx
import { useState } from 'react';

export type Scope = 'federal' | 'states' | 'counties' | 'districts';

interface ScopeSwitcherProps {
  onScopeChange: (scope: Scope) => void;
  initialScope?: Scope;
}

const scopes: { id: Scope; label: string }[] = [
  { id: 'federal', label: 'Federal' },
  { id: 'states', label: 'States' },
  { id: 'counties', label: 'Counties' },
  { id: 'districts', label: 'Districts' },
];

export default function ScopeSwitcher({ onScopeChange, initialScope = 'states' }: ScopeSwitcherProps) {
  const [active, setActive] = useState<Scope>(initialScope);

  const handleClick = (scope: Scope) => {
    setActive(scope);
    onScopeChange(scope);
  };

  return (
    <div className="flex gap-1 bg-white/90 backdrop-blur rounded-lg p-1 shadow-lg" role="tablist">
      {scopes.map((scope) => (
        <button
          key={scope.id}
          role="tab"
          aria-selected={active === scope.id}
          onClick={() => handleClick(scope.id)}
          className={`px-4 py-2 text-sm font-medium rounded-md transition-all ${
            active === scope.id
              ? 'bg-civic-navy text-white shadow-sm'
              : 'text-civic-slate hover:text-civic-navy hover:bg-slate-100'
          }`}
        >
          {scope.label}
        </button>
      ))}
    </div>
  );
}
```

**Step 7: Update BaseLayout to include Header/Footer**

Update `src/layouts/BaseLayout.astro` to import and render Header and Footer.

**Step 8: Commit**

```bash
git add src/components/ src/layouts/
git commit -m "feat: add design system components — header, footer, breadcrumb, cards, scope switcher"
```

---

## Task 3: Database Schema (Supabase)

**Files:**
- Create: `supabase/migrations/001_jurisdictions.sql`
- Create: `supabase/migrations/002_agencies.sql`
- Create: `supabase/migrations/003_officials.sql`
- Create: `supabase/migrations/004_elections.sql`
- Create: `supabase/migrations/005_laws.sql`
- Create: `supabase/migrations/006_zip_lookup.sql`
- Create: `src/lib/supabase.ts`

**Step 1: Create Supabase client**

`src/lib/supabase.ts`:
```typescript
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.PUBLIC_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Server-side client with service role key (for data imports)
export function createServiceClient() {
  return createClient(
    import.meta.env.PUBLIC_SUPABASE_URL,
    import.meta.env.SUPABASE_SERVICE_ROLE_KEY
  );
}
```

**Step 2: Jurisdictions migration**

`supabase/migrations/001_jurisdictions.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TYPE jurisdiction_level AS ENUM ('federal', 'state', 'county', 'city');

CREATE TABLE jurisdictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  level jurisdiction_level NOT NULL,
  fips_code TEXT,
  state_abbr CHAR(2),
  parent_id UUID REFERENCES jurisdictions(id),
  population INTEGER,
  website TEXT,
  geometry GEOMETRY(MultiPolygon, 4326),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_jurisdictions_level ON jurisdictions(level);
CREATE INDEX idx_jurisdictions_parent ON jurisdictions(parent_id);
CREATE INDEX idx_jurisdictions_slug ON jurisdictions(slug);
CREATE INDEX idx_jurisdictions_fips ON jurisdictions(fips_code);
CREATE INDEX idx_jurisdictions_state ON jurisdictions(state_abbr);
CREATE INDEX idx_jurisdictions_geometry ON jurisdictions USING GIST(geometry);

-- The single federal jurisdiction
INSERT INTO jurisdictions (name, slug, level, fips_code)
VALUES ('United States of America', 'usa', 'federal', 'US');
```

**Step 3: Agencies migration**

`supabase/migrations/002_agencies.sql`:
```sql
CREATE TYPE agency_type AS ENUM (
  'cabinet_department', 'independent_agency', 'executive_office',
  'regulatory_commission', 'government_corporation', 'quasi_official',
  'state_agency', 'county_agency', 'city_agency'
);

CREATE TABLE agencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  abbreviation TEXT,
  agency_type agency_type NOT NULL,
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id),
  parent_agency_id UUID REFERENCES agencies(id),
  description TEXT,
  website TEXT,
  established_year INTEGER,
  logo_url TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_agencies_jurisdiction ON agencies(jurisdiction_id);
CREATE INDEX idx_agencies_parent ON agencies(parent_agency_id);
CREATE INDEX idx_agencies_slug ON agencies(slug);
CREATE INDEX idx_agencies_type ON agencies(agency_type);
```

**Step 4: Officials migration**

`supabase/migrations/003_officials.sql`:
```sql
CREATE TYPE branch AS ENUM ('executive', 'legislative', 'judicial');
CREATE TYPE chamber AS ENUM ('senate', 'house', 'upper', 'lower', 'unicameral');
CREATE TYPE party AS ENUM ('democratic', 'republican', 'independent', 'libertarian', 'green', 'other');

CREATE TABLE offices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  branch branch NOT NULL,
  chamber chamber,
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id),
  district TEXT,
  is_elected BOOLEAN DEFAULT true,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE officials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  slug TEXT NOT NULL,
  office_id UUID NOT NULL REFERENCES offices(id),
  party party,
  photo_url TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  social_media JSONB DEFAULT '{}',
  term_start DATE,
  term_end DATE,
  is_current BOOLEAN DEFAULT true,
  bioguide_id TEXT,
  fec_id TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_offices_jurisdiction ON offices(jurisdiction_id);
CREATE INDEX idx_offices_branch ON offices(branch);
CREATE INDEX idx_officials_office ON officials(office_id);
CREATE INDEX idx_officials_current ON officials(is_current);
CREATE INDEX idx_officials_slug ON officials(slug);
CREATE INDEX idx_officials_party ON officials(party);
```

**Step 5: Elections migration**

`supabase/migrations/004_elections.sql`:
```sql
CREATE TYPE election_type AS ENUM ('general', 'primary', 'runoff', 'special', 'recall', 'referendum');

CREATE TABLE elections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  election_type election_type NOT NULL,
  election_date DATE NOT NULL,
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id),
  registration_deadline DATE,
  early_voting_start DATE,
  early_voting_end DATE,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id UUID NOT NULL REFERENCES elections(id),
  office_id UUID NOT NULL REFERENCES offices(id),
  official_id UUID REFERENCES officials(id),
  name TEXT NOT NULL,
  party party,
  is_incumbent BOOLEAN DEFAULT false,
  website TEXT,
  fec_id TEXT,
  votes_received INTEGER,
  vote_percentage NUMERIC(5,2),
  won BOOLEAN,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE ballot_measures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  election_id UUID NOT NULL REFERENCES elections(id),
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id),
  title TEXT NOT NULL,
  description TEXT,
  measure_type TEXT,
  result TEXT,
  yes_votes INTEGER,
  no_votes INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE election_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id),
  registration_url TEXT,
  registration_status_url TEXT,
  ballot_tracking_url TEXT,
  election_office_name TEXT,
  election_office_phone TEXT,
  election_office_email TEXT,
  election_office_address TEXT,
  has_online_registration BOOLEAN DEFAULT false,
  has_ballot_tracking BOOLEAN DEFAULT false,
  requirements TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(jurisdiction_id)
);

CREATE INDEX idx_elections_jurisdiction ON elections(jurisdiction_id);
CREATE INDEX idx_elections_date ON elections(election_date);
CREATE INDEX idx_candidates_election ON candidates(election_id);
CREATE INDEX idx_ballot_measures_election ON ballot_measures(election_id);
CREATE INDEX idx_election_services_jurisdiction ON election_services(jurisdiction_id);
```

**Step 6: Laws migration**

`supabase/migrations/005_laws.sql`:
```sql
CREATE TYPE law_type AS ENUM (
  'constitution', 'statute', 'regulation', 'executive_order',
  'ordinance', 'administrative_code', 'municipal_code'
);

CREATE TABLE law_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  jurisdiction_id UUID NOT NULL REFERENCES jurisdictions(id),
  law_type law_type NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  source_url TEXT,
  api_url TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_law_sources_jurisdiction ON law_sources(jurisdiction_id);
CREATE INDEX idx_law_sources_type ON law_sources(law_type);
```

**Step 7: ZIP lookup migration**

`supabase/migrations/006_zip_lookup.sql`:
```sql
CREATE TABLE zip_jurisdictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  zip_code CHAR(5) NOT NULL,
  state_id UUID REFERENCES jurisdictions(id),
  county_id UUID REFERENCES jurisdictions(id),
  city_id UUID REFERENCES jurisdictions(id),
  congressional_district TEXT,
  state_legislative_upper TEXT,
  state_legislative_lower TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_zip_jurisdictions_zip ON zip_jurisdictions(zip_code);
CREATE INDEX idx_zip_jurisdictions_state ON zip_jurisdictions(state_id);
CREATE INDEX idx_zip_jurisdictions_county ON zip_jurisdictions(county_id);
```

**Step 8: Apply migrations via Supabase MCP**

Run each migration through the Supabase MCP `apply_migration` tool.

**Step 9: Commit**

```bash
git add supabase/ src/lib/supabase.ts
git commit -m "feat: add database schema — jurisdictions, agencies, officials, elections, laws, ZIP lookup"
```

---

## Task 4: Data Import Scripts — Geographic Spine

**Files:**
- Create: `scripts/import-states.ts`
- Create: `scripts/import-counties.ts`
- Create: `scripts/import-cities.ts`
- Create: `scripts/import-zip-crosswalk.ts`
- Create: `scripts/lib/supabase-admin.ts`

**Step 1: Create admin Supabase client for scripts**

`scripts/lib/supabase-admin.ts`:
```typescript
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

export const supabase = createClient(
  process.env.PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);
```

**Step 2: Create state import script**

`scripts/import-states.ts`:
```typescript
import { supabase } from './lib/supabase-admin';

// All 50 states + DC + territories with FIPS codes
const states = [
  { name: 'Alabama', abbr: 'AL', fips: '01' },
  { name: 'Alaska', abbr: 'AK', fips: '02' },
  { name: 'Arizona', abbr: 'AZ', fips: '04' },
  { name: 'Arkansas', abbr: 'AR', fips: '05' },
  { name: 'California', abbr: 'CA', fips: '06' },
  { name: 'Colorado', abbr: 'CO', fips: '08' },
  { name: 'Connecticut', abbr: 'CT', fips: '09' },
  { name: 'Delaware', abbr: 'DE', fips: '10' },
  { name: 'Florida', abbr: 'FL', fips: '12' },
  { name: 'Georgia', abbr: 'GA', fips: '13' },
  { name: 'Hawaii', abbr: 'HI', fips: '15' },
  { name: 'Idaho', abbr: 'ID', fips: '16' },
  { name: 'Illinois', abbr: 'IL', fips: '17' },
  { name: 'Indiana', abbr: 'IN', fips: '18' },
  { name: 'Iowa', abbr: 'IA', fips: '19' },
  { name: 'Kansas', abbr: 'KS', fips: '20' },
  { name: 'Kentucky', abbr: 'KY', fips: '21' },
  { name: 'Louisiana', abbr: 'LA', fips: '22' },
  { name: 'Maine', abbr: 'ME', fips: '23' },
  { name: 'Maryland', abbr: 'MD', fips: '24' },
  { name: 'Massachusetts', abbr: 'MA', fips: '25' },
  { name: 'Michigan', abbr: 'MI', fips: '26' },
  { name: 'Minnesota', abbr: 'MN', fips: '27' },
  { name: 'Mississippi', abbr: 'MS', fips: '28' },
  { name: 'Missouri', abbr: 'MO', fips: '29' },
  { name: 'Montana', abbr: 'MT', fips: '30' },
  { name: 'Nebraska', abbr: 'NE', fips: '31' },
  { name: 'Nevada', abbr: 'NV', fips: '32' },
  { name: 'New Hampshire', abbr: 'NH', fips: '33' },
  { name: 'New Jersey', abbr: 'NJ', fips: '34' },
  { name: 'New Mexico', abbr: 'NM', fips: '35' },
  { name: 'New York', abbr: 'NY', fips: '36' },
  { name: 'North Carolina', abbr: 'NC', fips: '37' },
  { name: 'North Dakota', abbr: 'ND', fips: '38' },
  { name: 'Ohio', abbr: 'OH', fips: '39' },
  { name: 'Oklahoma', abbr: 'OK', fips: '40' },
  { name: 'Oregon', abbr: 'OR', fips: '41' },
  { name: 'Pennsylvania', abbr: 'PA', fips: '42' },
  { name: 'Rhode Island', abbr: 'RI', fips: '44' },
  { name: 'South Carolina', abbr: 'SC', fips: '45' },
  { name: 'South Dakota', abbr: 'SD', fips: '46' },
  { name: 'Tennessee', abbr: 'TN', fips: '47' },
  { name: 'Texas', abbr: 'TX', fips: '48' },
  { name: 'Utah', abbr: 'UT', fips: '49' },
  { name: 'Vermont', abbr: 'VT', fips: '50' },
  { name: 'Virginia', abbr: 'VA', fips: '51' },
  { name: 'Washington', abbr: 'WA', fips: '53' },
  { name: 'West Virginia', abbr: 'WV', fips: '54' },
  { name: 'Wisconsin', abbr: 'WI', fips: '55' },
  { name: 'Wyoming', abbr: 'WY', fips: '56' },
  { name: 'District of Columbia', abbr: 'DC', fips: '11' },
];

async function importStates() {
  // Get federal jurisdiction as parent
  const { data: federal } = await supabase
    .from('jurisdictions')
    .select('id')
    .eq('slug', 'usa')
    .single();

  if (!federal) throw new Error('Federal jurisdiction not found');

  const rows = states.map(s => ({
    name: s.name,
    slug: s.name.toLowerCase().replace(/\s+/g, '-'),
    level: 'state' as const,
    fips_code: s.fips,
    state_abbr: s.abbr,
    parent_id: federal.id,
    website: `https://${s.abbr.toLowerCase()}.gov`,
  }));

  const { data, error } = await supabase
    .from('jurisdictions')
    .upsert(rows, { onConflict: 'fips_code' })
    .select();

  if (error) throw error;
  console.log(`Imported ${data.length} states`);
}

importStates().catch(console.error);
```

**Step 3: Create county import script**

`scripts/import-counties.ts` — fetches county FIPS data from Census Bureau API, inserts as county-level jurisdictions with parent_id pointing to the state.

```typescript
import { supabase } from './lib/supabase-admin';

async function importCounties() {
  // Fetch county data from Census Bureau
  const apiKey = process.env.CENSUS_API_KEY;
  const url = `https://api.census.gov/data/2020/dec/pl?get=NAME,P1_001N&for=county:*&key=${apiKey}`;

  const response = await fetch(url);
  const data: string[][] = await response.json();

  // First row is headers: ["NAME", "P1_001N", "state", "county"]
  const headers = data[0];
  const rows = data.slice(1);

  // Get all state jurisdictions for parent mapping
  const { data: states } = await supabase
    .from('jurisdictions')
    .select('id, fips_code')
    .eq('level', 'state');

  const stateMap = new Map(states?.map(s => [s.fips_code, s.id]) ?? []);

  const countyRows = rows.map(row => {
    const name = row[0].replace(/ County| Parish| Borough| Census Area| Municipality| City and Borough/g, '').trim();
    const population = parseInt(row[1], 10);
    const stateFips = row[2];
    const countyFips = row[3];
    const fullFips = `${stateFips}${countyFips}`;

    return {
      name: row[0], // Keep full name with "County" etc.
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      level: 'county' as const,
      fips_code: fullFips,
      state_abbr: null, // Will be set from parent
      parent_id: stateMap.get(stateFips) ?? null,
      population,
    };
  });

  // Insert in batches of 500
  for (let i = 0; i < countyRows.length; i += 500) {
    const batch = countyRows.slice(i, i + 500);
    const { error } = await supabase.from('jurisdictions').upsert(batch, { onConflict: 'fips_code' });
    if (error) throw error;
    console.log(`Imported counties ${i + 1} to ${i + batch.length}`);
  }

  console.log(`Total counties imported: ${countyRows.length}`);
}

importCounties().catch(console.error);
```

**Step 4: Create city import script**

`scripts/import-cities.ts` — similar pattern, uses Census incorporated places API.

**Step 5: Create ZIP crosswalk import**

`scripts/import-zip-crosswalk.ts` — downloads HUD USPS crosswalk file, parses CSV, inserts into `zip_jurisdictions`.

**Step 6: Add script runner to package.json**

```json
{
  "scripts": {
    "import:states": "npx tsx scripts/import-states.ts",
    "import:counties": "npx tsx scripts/import-counties.ts",
    "import:cities": "npx tsx scripts/import-cities.ts",
    "import:zips": "npx tsx scripts/import-zip-crosswalk.ts",
    "import:geo": "npm run import:states && npm run import:counties && npm run import:cities && npm run import:zips"
  }
}
```

**Step 7: Commit**

```bash
git add scripts/ package.json
git commit -m "feat: add geographic data import scripts — states, counties, cities, ZIP crosswalk"
```

---

## Task 5: Data Import Scripts — Federal Government

**Files:**
- Create: `scripts/import-agencies.ts`
- Create: `scripts/import-congress-members.ts`
- Create: `scripts/import-executive-orders.ts`
- Create: `scripts/import-federal-law-sources.ts`

**Step 1: Agency import** — pulls from Federal Register API `/agencies` endpoint (no auth required) and dotgov-data GitHub CSV. Creates entries in `agencies` table with proper hierarchy (cabinet department → sub-agencies).

**Step 2: Congress members import** — uses Congress.gov API (`/member` endpoint, requires API key). Creates offices for each seat and officials for each current member with bioguide IDs, party, state, district.

**Step 3: Executive orders import** — uses Federal Register API `/documents?presidential_document_type=executive_order&president=...`. Stores as law_sources entries.

**Step 4: Federal law sources** — creates static entries for U.S. Code, CFR, Federal Register with their URLs.

**Step 5: Commit**

```bash
git add scripts/
git commit -m "feat: add federal data import scripts — agencies, Congress members, executive orders, law sources"
```

---

## Task 6: Data Import Scripts — State & Local

**Files:**
- Create: `scripts/import-state-officials.ts`
- Create: `scripts/import-election-services.ts`
- Create: `scripts/import-state-law-sources.ts`

**Step 1: State officials** — uses OpenStates API (`/people` endpoint) to import governors, state legislators. Uses Google Civic Information API as supplementary source.

**Step 2: Election services** — populates `election_services` table with per-state voter registration URLs, ballot tracking URLs (from Vote.gov data and state secretary of state sites), requirements.

**Step 3: State law sources** — creates entries pointing to each state's statutes, administrative codes, and court systems.

**Step 4: Commit**

```bash
git add scripts/
git commit -m "feat: add state/local data import scripts — officials, election services, law sources"
```

---

## Task 7: Map Component (MapLibre + PMTiles)

**Files:**
- Create: `src/components/map/GovMap.tsx`
- Create: `src/components/map/MapPopup.tsx`
- Create: `src/components/map/useMapLayers.ts`
- Create: `scripts/generate-pmtiles.sh`
- Create: `public/data/` (directory for PMTiles files)

**Step 1: Create PMTiles generation script**

`scripts/generate-pmtiles.sh`:
```bash
#!/bin/bash
set -e

DATA_DIR="public/data"
mkdir -p "$DATA_DIR"

# Download Census TIGER/Line boundary files
echo "Downloading state boundaries..."
curl -o /tmp/states.zip "https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_state_500k.zip"
unzip -o /tmp/states.zip -d /tmp/states/

echo "Downloading county boundaries..."
curl -o /tmp/counties.zip "https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_county_500k.zip"
unzip -o /tmp/counties.zip -d /tmp/counties/

echo "Downloading congressional district boundaries..."
curl -o /tmp/districts.zip "https://www2.census.gov/geo/tiger/GENZ2020/shp/cb_2020_us_cd118_500k.zip"
unzip -o /tmp/districts.zip -d /tmp/districts/

# Convert shapefiles to GeoJSON
echo "Converting to GeoJSON..."
ogr2ogr -f GeoJSON /tmp/states.geojson /tmp/states/cb_2020_us_state_500k.shp
ogr2ogr -f GeoJSON /tmp/counties.geojson /tmp/counties/cb_2020_us_county_500k.shp
ogr2ogr -f GeoJSON /tmp/districts.geojson /tmp/districts/cb_2020_us_cd118_500k.shp

# Generate PMTiles with Tippecanoe
echo "Generating PMTiles..."
tippecanoe -o "$DATA_DIR/us-boundaries.pmtiles" \
  --force \
  --no-feature-limit \
  --no-tile-size-limit \
  -z 12 \
  --coalesce-densest-as-needed \
  --named-layer=states:/tmp/states.geojson \
  --named-layer=counties:/tmp/counties.geojson \
  --named-layer=districts:/tmp/districts.geojson

echo "PMTiles generated at $DATA_DIR/us-boundaries.pmtiles"
```

**Step 2: Create the main map component**

`src/components/map/GovMap.tsx`:
```tsx
import { useEffect, useRef, useState, useCallback } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import ScopeSwitcher, { type Scope } from '../ScopeSwitcher';
import 'maplibre-gl/dist/maplibre-gl.css';

const LAYER_CONFIG: Record<Scope, { sourceLayer: string; color: string; hoverColor: string }> = {
  federal: { sourceLayer: 'states', color: '#1B2A4A', hoverColor: '#2563EB' },
  states: { sourceLayer: 'states', color: '#2563EB', hoverColor: '#1d4ed8' },
  counties: { sourceLayer: 'counties', color: '#4A90E2', hoverColor: '#2563EB' },
  districts: { sourceLayer: 'districts', color: '#D97706', hoverColor: '#b45309' },
};

export default function GovMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [scope, setScope] = useState<Scope>('states');
  const [hoveredId, setHoveredId] = useState<number | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const protocol = new Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {},
        layers: [{
          id: 'background',
          type: 'background',
          paint: { 'background-color': '#F8FAFC' },
        }],
      },
      center: [-98.5, 39.8],
      zoom: 3.5,
      maxBounds: [[-180, 10], [-50, 75]],
    });

    map.on('load', () => {
      map.addSource('boundaries', {
        type: 'vector',
        url: 'pmtiles:///data/us-boundaries.pmtiles',
      });

      // Add layers for each scope
      Object.entries(LAYER_CONFIG).forEach(([scopeId, config]) => {
        const visible = scopeId === 'states';

        map.addLayer({
          id: `${scopeId}-fill`,
          type: 'fill',
          source: 'boundaries',
          'source-layer': config.sourceLayer,
          layout: { visibility: visible ? 'visible' : 'none' },
          paint: {
            'fill-color': [
              'case',
              ['boolean', ['feature-state', 'hover'], false],
              config.hoverColor,
              config.color,
            ],
            'fill-opacity': [
              'case',
              ['boolean', ['feature-state', 'hover'], false],
              0.8,
              0.6,
            ],
          },
        });

        map.addLayer({
          id: `${scopeId}-line`,
          type: 'line',
          source: 'boundaries',
          'source-layer': config.sourceLayer,
          layout: { visibility: visible ? 'visible' : 'none' },
          paint: {
            'line-color': '#ffffff',
            'line-width': scopeId === 'states' ? 2 : 1,
          },
        });
      });

      // Click handler
      map.on('click', 'states-fill', (e) => {
        if (!e.features?.length) return;
        const props = e.features[0].properties;
        const slug = props.NAME?.toLowerCase().replace(/\s+/g, '-');
        if (slug) window.location.href = `/states/${slug}`;
      });

      map.on('click', 'counties-fill', (e) => {
        if (!e.features?.length) return;
        const props = e.features[0].properties;
        const stateSlug = props.STATE_NAME?.toLowerCase().replace(/\s+/g, '-');
        const countySlug = props.NAME?.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        if (stateSlug && countySlug) window.location.href = `/states/${stateSlug}/counties/${countySlug}`;
      });

      // Hover handlers for active layer
      ['states', 'counties', 'districts'].forEach(layerScope => {
        map.on('mousemove', `${layerScope}-fill`, (e) => {
          map.getCanvas().style.cursor = 'pointer';
          if (!e.features?.length) return;
          const id = e.features[0].id as number;
          if (hoveredId !== null) {
            map.setFeatureState(
              { source: 'boundaries', sourceLayer: LAYER_CONFIG[layerScope as Scope].sourceLayer, id: hoveredId },
              { hover: false }
            );
          }
          map.setFeatureState(
            { source: 'boundaries', sourceLayer: LAYER_CONFIG[layerScope as Scope].sourceLayer, id },
            { hover: true }
          );
          setHoveredId(id);
        });

        map.on('mouseleave', `${layerScope}-fill`, () => {
          map.getCanvas().style.cursor = '';
          if (hoveredId !== null) {
            map.setFeatureState(
              { source: 'boundaries', sourceLayer: LAYER_CONFIG[layerScope as Scope].sourceLayer, id: hoveredId },
              { hover: false }
            );
          }
          setHoveredId(null);
        });
      });
    });

    mapRef.current = map;
    return () => map.remove();
  }, []);

  const handleScopeChange = useCallback((newScope: Scope) => {
    const map = mapRef.current;
    if (!map) return;

    // Toggle layer visibility
    Object.keys(LAYER_CONFIG).forEach(s => {
      const visible = s === newScope || (newScope === 'federal' && s === 'states');
      map.setLayoutProperty(`${s}-fill`, 'visibility', visible ? 'visible' : 'none');
      map.setLayoutProperty(`${s}-line`, 'visibility', visible ? 'visible' : 'none');
    });

    setScope(newScope);
  }, []);

  return (
    <div className="relative w-full h-[70vh] min-h-[500px]">
      <div ref={containerRef} className="w-full h-full rounded-xl overflow-hidden" />
      <div className="absolute top-4 left-4 z-10">
        <ScopeSwitcher onScopeChange={handleScopeChange} initialScope="states" />
      </div>
    </div>
  );
}
```

**Step 3: Commit**

```bash
git add src/components/map/ scripts/generate-pmtiles.sh
git commit -m "feat: add MapLibre map component with PMTiles, scope switcher, hover/click interaction"
```

---

## Task 8: Homepage with Map & ZIP Search

**Files:**
- Modify: `src/pages/index.astro`
- Create: `src/components/ZipSearch.tsx`

**Step 1: Create ZIP search component**

`src/components/ZipSearch.tsx`:
```tsx
import { useState } from 'react';

export default function ZipSearch() {
  const [zip, setZip] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{5}$/.test(zip)) {
      setError('Please enter a valid 5-digit ZIP code.');
      return;
    }
    setLoading(true);
    setError('');
    window.location.href = `/elections/lookup?zip=${zip}`;
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 max-w-md mx-auto">
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]{5}"
        maxLength={5}
        value={zip}
        onChange={(e) => {
          setZip(e.target.value.replace(/\D/g, ''));
          setError('');
        }}
        placeholder="Enter your ZIP code"
        className="flex-1 px-4 py-3 rounded-lg border border-slate-300 text-lg font-mono focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent"
        aria-label="ZIP code"
      />
      <button
        type="submit"
        disabled={loading}
        className="px-6 py-3 bg-civic-blue text-white font-medium rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
      >
        {loading ? 'Looking up...' : 'Go'}
      </button>
      {error && <p className="text-red-600 text-sm mt-1 absolute">{error}</p>}
    </form>
  );
}
```

**Step 2: Update homepage**

`src/pages/index.astro`:
```astro
---
import BaseLayout from '../layouts/BaseLayout.astro';
import Header from '../components/Header.astro';
import Footer from '../components/Footer.astro';
import GovMap from '../components/map/GovMap';
import ZipSearch from '../components/ZipSearch';
import CategoryCard from '../components/CategoryCard.astro';
---
<BaseLayout title="Home">
  <Header />
  <main class="flex-1">
    <!-- Hero Section -->
    <section class="bg-civic-navy text-white py-8 px-4">
      <div class="max-w-7xl mx-auto text-center mb-6">
        <h1 class="text-4xl md:text-5xl font-display font-bold mb-3">Know Your Government</h1>
        <p class="text-lg text-slate-300 max-w-2xl mx-auto mb-6">
          Every official, every agency, every law — from the White House to your city hall.
        </p>
        <ZipSearch client:load />
      </div>
    </section>

    <!-- Map Section -->
    <section class="max-w-7xl mx-auto px-4 -mt-4">
      <GovMap client:load />
    </section>

    <!-- Category Grid -->
    <section class="max-w-7xl mx-auto px-4 py-12">
      <h2 class="text-2xl font-display text-civic-navy mb-6">Explore</h2>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <CategoryCard
          title="Federal Government"
          description="Three branches, cabinet departments, agencies, and officials"
          href="/federal"
        />
        <CategoryCard
          title="State Governments"
          description="All 50 states — governors, legislators, agencies, and courts"
          href="/states"
          count={50}
        />
        <CategoryCard
          title="Elections & Voting"
          description="Register to vote, track your ballot, find your candidates"
          href="/elections"
        />
        <CategoryCard
          title="Laws & Regulations"
          description="Federal code, state statutes, executive orders, local ordinances"
          href="/laws"
        />
        <CategoryCard
          title="Officials Directory"
          description="Find your elected officials at every level of government"
          href="/officials"
        />
        <CategoryCard
          title="Agency Directory"
          description="A-Z listing of every federal agency and department"
          href="/federal/agencies"
          count={400}
        />
      </div>
    </section>
  </main>
  <Footer />
</BaseLayout>
```

**Step 3: Commit**

```bash
git add src/pages/index.astro src/components/ZipSearch.tsx
git commit -m "feat: build homepage with interactive map, ZIP search, and category navigation"
```

---

## Task 9: Page Templates — Federal

**Files:**
- Create: `src/pages/federal/index.astro`
- Create: `src/pages/federal/agencies/index.astro`
- Create: `src/pages/federal/agencies/[slug].astro`
- Create: `src/pages/federal/executive.astro`
- Create: `src/pages/federal/legislative.astro`
- Create: `src/pages/federal/judicial.astro`

These pages query Supabase at build time for agency data, official data, and render the federal government structure. Each page uses Breadcrumb, InfoBlock, and CategoryCard components.

**Commit after completion.**

---

## Task 10: Page Templates — States

**Files:**
- Create: `src/pages/states/index.astro`
- Create: `src/pages/states/[slug]/index.astro`
- Create: `src/pages/states/[slug]/counties/index.astro`
- Create: `src/pages/states/[slug]/counties/[county].astro`
- Create: `src/pages/states/[slug]/cities/[city].astro`
- Create: `src/pages/states/[slug]/officials.astro`
- Create: `src/pages/states/[slug]/elections.astro`
- Create: `src/pages/states/[slug]/laws.astro`

State index lists all 50 states + DC. Each state page shows branches of government, key officials, counties, election info, and links to law sources. County and city pages show local officials and services.

Uses `getStaticPaths()` querying Supabase for all jurisdictions at build time.

**Commit after completion.**

---

## Task 11: Server API Endpoints

**Files:**
- Create: `src/pages/api/zip-lookup.ts`
- Create: `src/pages/api/elections.ts`
- Create: `src/pages/api/officials.ts`
- Create: `src/pages/api/search.ts`

Each file exports `prerender = false` to enable SSR.

**Step 1: ZIP lookup endpoint**

`src/pages/api/zip-lookup.ts`:
```typescript
import type { APIRoute } from 'astro';
import { supabase } from '../../lib/supabase';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  const zip = url.searchParams.get('zip');

  if (!zip || !/^\d{5}$/.test(zip)) {
    return new Response(JSON.stringify({ error: 'Invalid ZIP code' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { data, error } = await supabase
    .from('zip_jurisdictions')
    .select(`
      zip_code,
      congressional_district,
      state:state_id(id, name, slug),
      county:county_id(id, name, slug),
      city:city_id(id, name, slug)
    `)
    .eq('zip_code', zip);

  if (error) {
    return new Response(JSON.stringify({ error: 'Lookup failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Get election services for the state
  const stateId = data?.[0]?.state?.id;
  let electionServices = null;
  if (stateId) {
    const { data: services } = await supabase
      .from('election_services')
      .select('*')
      .eq('jurisdiction_id', stateId)
      .single();
    electionServices = services;
  }

  return new Response(JSON.stringify({
    zip_code: zip,
    jurisdictions: data,
    election_services: electionServices,
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
```

**Step 2:** Similar patterns for `/api/elections`, `/api/officials`, `/api/search`.

**Step 3: Commit**

```bash
git add src/pages/api/
git commit -m "feat: add server API endpoints — ZIP lookup, elections, officials, search"
```

---

## Task 12: Voter Toolbox / Election Pages

**Files:**
- Create: `src/pages/elections/index.astro`
- Create: `src/pages/elections/lookup.astro`
- Create: `src/components/ElectionLookupResults.tsx`

The lookup page reads `?zip=` from query params, calls `/api/zip-lookup`, and renders:
- State, county, city for that ZIP
- Voter registration link (or "not available" message)
- Ballot tracking link (or fallback message)
- Upcoming elections
- Current representatives

**Commit after completion.**

---

## Task 13: Laws & Regulations Pages

**Files:**
- Create: `src/pages/laws/index.astro`
- Create: `src/pages/laws/federal.astro`
- Create: `src/pages/laws/executive-orders.astro`

Index page shows categorized law sources by level. Federal page links to U.S. Code, CFR, Federal Register. Executive orders page lists current EOs from database.

**Commit after completion.**

---

## Task 14: Officials Directory

**Files:**
- Create: `src/pages/officials/index.astro`
- Create: `src/pages/officials/[slug].astro`

Index page allows browsing officials by state, branch, or chamber. Individual official pages show profile, office, jurisdiction, contact info, term dates.

**Commit after completion.**

---

## Task 15: Accessibility, SEO & Polish

**Files:**
- Modify: `src/layouts/BaseLayout.astro` (add OpenGraph, structured data)
- Create: `src/components/SkipLink.astro`
- Create: `public/robots.txt`
- Create: `public/sitemap-index.xml` (or use Astro sitemap integration)

Ensure all pages have:
- Proper heading hierarchy
- ARIA labels on interactive elements
- Keyboard navigation for map and scope switcher
- OpenGraph meta tags
- JSON-LD structured data for government organization schema

**Commit after completion.**

---

## Task 16: Build, Test & Deploy Prep

**Files:**
- Create: `scripts/validate-data.ts` — checks all jurisdictions have required fields
- Modify: `package.json` — add build, validate, and deploy scripts
- Create: `.github/workflows/build.yml` — CI pipeline

**Step 1: Data validation script**

Queries Supabase and verifies:
- 50+ state jurisdictions exist
- 3,100+ county jurisdictions exist
- All states have election_services entries
- Federal agencies exist
- Congress members loaded

**Step 2: CI workflow**

```yaml
name: Build & Validate
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npm run build
```

**Step 3: Commit**

```bash
git add scripts/validate-data.ts .github/ package.json
git commit -m "feat: add data validation, CI pipeline, and deploy prep"
```

---

## Execution Order

Tasks can be partially parallelized:

```
Task 1 (scaffold) ──→ Task 2 (design system) ──→ Task 8 (homepage)
                  ╲
                   ──→ Task 3 (DB schema) ──→ Task 4 (geo imports) ──→ Task 5 (federal imports) ──→ Task 6 (state imports)
                  ╲
                   ──→ Task 7 (map component)

After Tasks 2-7 complete:
  Task 9 (federal pages) ─┐
  Task 10 (state pages)   ├──→ Task 15 (a11y/SEO) ──→ Task 16 (build/deploy)
  Task 11 (API endpoints) │
  Task 12 (elections)     │
  Task 13 (laws)          │
  Task 14 (officials)     ┘
```
