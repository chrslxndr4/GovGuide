/**
 * Set photo_url on the officials table for all Congress members
 * using Bioguide portrait URLs.
 *
 * Source: https://bioguide.congress.gov/bioguide/photo/{bioguideId}.jpg
 * Public domain images for all 538 current members.
 *
 * Run with:  npm run import:congress-photos
 */

import { supabase } from './lib/supabase-admin.js';

const BIOGUIDE_PHOTO_URL = 'https://bioguide.congress.gov/bioguide/photo';
const BATCH_SIZE = 50;

async function main() {
  console.log('--- Import Congress Member Photos ---\n');

  // Fetch all officials with a bioguide_id that don't already have a photo_url
  const { data: officials, error } = await supabase
    .from('officials')
    .select('id, bioguide_id')
    .not('bioguide_id', 'is', null)
    .is('photo_url', null);

  if (error) {
    console.error('Failed to query officials:', error.message);
    process.exit(1);
  }

  if (!officials || officials.length === 0) {
    console.log('All Congress members already have photo URLs. Nothing to do.');
    return;
  }

  console.log(`Found ${officials.length} officials needing photo URLs.\n`);

  let updated = 0;
  let errors = 0;

  for (let i = 0; i < officials.length; i += BATCH_SIZE) {
    const batch = officials.slice(i, i + BATCH_SIZE);

    const updates = batch.map((o) => ({
      id: o.id,
      photo_url: `${BIOGUIDE_PHOTO_URL}/${o.bioguide_id}.jpg`,
    }));

    const { error: upsertError } = await supabase
      .from('officials')
      .upsert(updates, { onConflict: 'id' });

    if (upsertError) {
      console.error(`Batch error at offset ${i}:`, upsertError.message);
      errors += batch.length;
    } else {
      updated += batch.length;
    }

    process.stdout.write('.');
  }

  console.log('\n');
  console.log(`Updated: ${updated}`);
  if (errors > 0) console.log(`Errors:  ${errors}`);
  console.log('Done.');
}

main();
