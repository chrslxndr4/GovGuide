import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

// dotenv/config loads .env into process.env at import time.
// The --env-file=.env flag passed to tsx acts as a fallback for shells that
// already export the variables without a .env file present.
const supabaseUrl = process.env['PUBLIC_SUPABASE_URL'];
const serviceRoleKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];

if (!supabaseUrl) {
  throw new Error(
    'Missing environment variable: PUBLIC_SUPABASE_URL\n' +
      'Set it in your shell or pass --env-file=.env to tsx.',
  );
}
if (!serviceRoleKey) {
  throw new Error(
    'Missing environment variable: SUPABASE_SERVICE_ROLE_KEY\n' +
      'Set it in your shell or pass --env-file=.env to tsx.',
  );
}

export const supabase = createClient(supabaseUrl, serviceRoleKey);
