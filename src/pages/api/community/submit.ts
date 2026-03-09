export const prerender = false;

import type { APIRoute } from 'astro';
import { createServiceClient } from '../../../lib/supabase';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SubmissionType = 'correction' | 'addition' | 'update' | 'tip';
type EntityType = 'official' | 'agency' | 'legislation' | 'financial_record' | 'other';

interface RawBody {
  submission_type: unknown;
  entity_type: unknown;
  title: unknown;
  description: unknown;
  source_url: unknown;
  jurisdiction: unknown;
  contact_email: unknown;
  website: unknown;
}

interface ValidatedSubmission {
  submission_type: SubmissionType;
  entity_type: EntityType;
  title: string;
  description: string;
  source_url: string;
  jurisdiction: string | null;
  contact_email: string | null;
}

type ValidationResult =
  | { valid: false; error: string }
  | { valid: true; data: ValidatedSubmission };

// ---------------------------------------------------------------------------
// Rate limiter — simple in-memory map, 5 submissions per IP per hour
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(ip, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return false;
  }

  entry.count += 1;
  return true;
}

// Periodically prune stale entries to prevent unbounded memory growth.
// This runs lazily on each request rather than via a timer to stay
// compatible with serverless environments.
function pruneRateLimitMap(): void {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap.entries()) {
    if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(ip);
    }
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_SUBMISSION_TYPES = new Set<SubmissionType>([
  'correction',
  'addition',
  'update',
  'tip',
]);

const VALID_ENTITY_TYPES = new Set<EntityType>([
  'official',
  'agency',
  'legislation',
  'financial_record',
  'other',
]);

const TITLE_MAX = 200;
const DESCRIPTION_MIN = 50;
const DESCRIPTION_MAX = 5000;
const SOURCE_URL_MAX = 2000;
const JURISDICTION_MAX = 200;
const EMAIL_MAX = 254;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validateBody(body: RawBody): ValidationResult {
  // Honeypot check — bots that fill hidden fields are rejected silently
  // (we return success to avoid revealing the check)
  if (typeof body.website === 'string' && body.website.trim().length > 0) {
    return { valid: false, error: 'HONEYPOT' };
  }

  const submissionType = typeof body.submission_type === 'string'
    ? body.submission_type.trim()
    : '';
  if (!VALID_SUBMISSION_TYPES.has(submissionType as SubmissionType)) {
    return { valid: false, error: 'Invalid submission_type.' };
  }

  const entityType = typeof body.entity_type === 'string'
    ? body.entity_type.trim()
    : '';
  if (!VALID_ENTITY_TYPES.has(entityType as EntityType)) {
    return { valid: false, error: 'Invalid entity_type.' };
  }

  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) {
    return { valid: false, error: 'title is required.' };
  }
  if (title.length > TITLE_MAX) {
    return { valid: false, error: `title must be ${TITLE_MAX} characters or fewer.` };
  }

  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (description.length < DESCRIPTION_MIN) {
    return {
      valid: false,
      error: `description must be at least ${DESCRIPTION_MIN} characters.`,
    };
  }
  if (description.length > DESCRIPTION_MAX) {
    return {
      valid: false,
      error: `description must be ${DESCRIPTION_MAX} characters or fewer.`,
    };
  }

  const sourceUrl = typeof body.source_url === 'string' ? body.source_url.trim() : '';
  if (!sourceUrl) {
    return { valid: false, error: 'source_url is required.' };
  }
  if (sourceUrl.length > SOURCE_URL_MAX) {
    return { valid: false, error: `source_url must be ${SOURCE_URL_MAX} characters or fewer.` };
  }
  if (!isValidUrl(sourceUrl)) {
    return { valid: false, error: 'source_url must be a valid http or https URL.' };
  }

  const jurisdiction =
    typeof body.jurisdiction === 'string' && body.jurisdiction.trim()
      ? body.jurisdiction.trim().slice(0, JURISDICTION_MAX)
      : null;

  let contactEmail: string | null = null;
  if (typeof body.contact_email === 'string' && body.contact_email.trim()) {
    const trimmed = body.contact_email.trim();
    if (!isValidEmail(trimmed)) {
      return { valid: false, error: 'contact_email is not a valid email address.' };
    }
    if (trimmed.length > EMAIL_MAX) {
      return { valid: false, error: `contact_email must be ${EMAIL_MAX} characters or fewer.` };
    }
    contactEmail = trimmed;
  }

  return {
    valid: true,
    data: {
      submission_type: submissionType as SubmissionType,
      entity_type: entityType as EntityType,
      title,
      description,
      source_url: sourceUrl,
      jurisdiction,
      contact_email: contactEmail,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getClientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'
  );
}

function jsonResponse(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const POST: APIRoute = async ({ request }) => {
  // Only accept JSON
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return jsonResponse({ error: 'Content-Type must be application/json.' }, 415);
  }

  // Parse body
  let rawBody: RawBody;
  try {
    rawBody = await request.json() as RawBody;
  } catch {
    return jsonResponse({ error: 'Invalid JSON body.' }, 400);
  }

  // Prune stale rate-limit entries on each request
  pruneRateLimitMap();

  // Rate limit check
  const ip = getClientIp(request);
  if (!checkRateLimit(ip)) {
    return jsonResponse(
      { error: 'Too many submissions. Please wait before trying again.' },
      429
    );
  }

  // Validate
  const result = validateBody(rawBody);

  // Honeypot triggered — return fake success to confuse bots
  if (!result.valid && result.error === 'HONEYPOT') {
    return jsonResponse({ success: true, id: 'noop' }, 200);
  }

  if (!result.valid) {
    return jsonResponse({ error: result.error }, 400);
  }

  // Insert into Supabase using the service client so RLS doesn't block writes
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from('community_submissions')
    .insert({
      submission_type: result.data.submission_type,
      entity_type: result.data.entity_type,
      title: result.data.title,
      description: result.data.description,
      source_url: result.data.source_url,
      jurisdiction: result.data.jurisdiction,
      contact_email: result.data.contact_email,
      status: 'pending',
      submitted_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    console.error('[community/submit] Supabase insert error:', error.message);
    return jsonResponse({ error: 'Failed to save submission. Please try again.' }, 500);
  }

  return jsonResponse({ success: true, id: data.id }, 201);
};
