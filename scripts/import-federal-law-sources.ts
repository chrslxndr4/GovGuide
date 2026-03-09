/**
 * Seed static law_sources entries for the major federal law repositories.
 *
 * Run with:  npm run import:federal-laws
 */

import { supabase } from './lib/supabase-admin.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LawType =
  | 'constitution'
  | 'statute'
  | 'regulation'
  | 'executive_order'
  | 'ordinance'
  | 'administrative_code'
  | 'municipal_code';

interface LawSourceDefinition {
  title: string;
  law_type: LawType;
  source_url: string;
  api_url?: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Static source definitions
// ---------------------------------------------------------------------------

const FEDERAL_LAW_SOURCES: LawSourceDefinition[] = [
  {
    title: 'United States Code',
    law_type: 'statute',
    source_url: 'https://uscode.house.gov/',
    api_url: 'https://api.govinfo.gov/',
    description:
      'The codification of the general and permanent federal statutory law of the United States, organized by subject matter into 54 titles.',
  },
  {
    title: 'Code of Federal Regulations',
    law_type: 'regulation',
    source_url: 'https://www.ecfr.gov/',
    api_url: 'https://www.federalregister.gov/api/v1/',
    description:
      'The codification of the general and permanent rules and regulations published in the Federal Register by the executive departments and agencies of the federal government.',
  },
  {
    title: 'Federal Register',
    law_type: 'regulation',
    source_url: 'https://www.federalregister.gov/',
    api_url: 'https://www.federalregister.gov/api/v1/',
    description:
      'The official daily journal of the federal government, containing proposed rules, final rules, presidential documents, and public notices.',
  },
  {
    title: 'Constitution of the United States',
    law_type: 'constitution',
    source_url: 'https://constitution.congress.gov/',
    description:
      'The supreme law of the United States, establishing the framework of the federal government and enumerating fundamental rights.',
  },
  {
    title: 'Public Laws (Congress.gov)',
    law_type: 'statute',
    source_url: 'https://www.congress.gov/public-laws',
    api_url: 'https://api.congress.gov/v3/',
    description:
      'Acts of Congress enacted into law, browseable and searchable by Congress number.',
  },
  {
    title: 'GovInfo — Congressional Bills',
    law_type: 'statute',
    source_url: 'https://www.govinfo.gov/app/collection/BILLS',
    api_url: 'https://api.govinfo.gov/',
    description:
      'Full text of bills and resolutions introduced in the U.S. House and Senate, provided by the Government Publishing Office.',
  },
  {
    title: 'Unified Agenda of Regulatory and Deregulatory Actions',
    law_type: 'regulation',
    source_url: 'https://www.reginfo.gov/public/do/eAgendaMain',
    description:
      'The semi-annual regulatory agenda published by federal agencies listing planned and ongoing rulemaking activities.',
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function getFederalJurisdictionId(): Promise<string> {
  const { data, error } = await supabase
    .from('jurisdictions')
    .select('id')
    .eq('slug', 'usa')
    .single();

  if (error || !data) {
    throw new Error(
      `Could not find federal jurisdiction (slug='usa'): ${error?.message}`,
    );
  }
  return (data as { id: string }).id;
}

async function importFederalLawSources(): Promise<void> {
  console.log('=== Import Federal Law Sources ===\n');

  const jurisdictionId = await getFederalJurisdictionId();

  let inserted = 0;
  let skipped = 0;

  for (const source of FEDERAL_LAW_SOURCES) {
    console.log(`  Processing: ${source.title} …`);

    const insert = {
      jurisdiction_id: jurisdictionId,
      law_type: source.law_type,
      title: source.title,
      description: source.description,
      source_url: source.source_url,
      api_url: source.api_url ?? null,
      metadata: {},
    };

    const { error } = await supabase
      .from('law_sources')
      .upsert(insert, { onConflict: 'source_url' });

    if (error) {
      console.error(`    ERROR: ${error.message}`);
      skipped++;
    } else {
      console.log('    OK');
      inserted++;
    }
  }

  console.log(
    `\n=== Completed. Inserted/updated: ${inserted}, skipped: ${skipped} ===`,
  );
}

importFederalLawSources().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
