import { useState, useId } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SubmissionType = 'correction' | 'addition' | 'update' | 'tip';
type EntityType = 'official' | 'agency' | 'legislation' | 'financial_record' | 'other';

type FormStatus = 'idle' | 'submitting' | 'success' | 'error';

interface FormFields {
  submission_type: SubmissionType | '';
  entity_type: EntityType | '';
  title: string;
  description: string;
  source_url: string;
  jurisdiction: string;
  contact_email: string;
  /** Honeypot — must remain empty */
  website: string;
}

interface ValidationErrors {
  submission_type?: string;
  entity_type?: string;
  title?: string;
  description?: string;
  source_url?: string;
  contact_email?: string;
}

interface ApiSuccessResponse {
  success: true;
  id: string;
}

interface ApiErrorResponse {
  error: string;
}

type ApiResponse = ApiSuccessResponse | ApiErrorResponse;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUBMISSION_TYPE_OPTIONS: { value: SubmissionType; label: string; description: string }[] = [
  { value: 'correction', label: 'Correction', description: 'Fix inaccurate information' },
  { value: 'addition', label: 'Addition', description: 'Add missing information' },
  { value: 'update', label: 'Update', description: 'Update outdated information' },
  { value: 'tip', label: 'Tip', description: 'Share a lead for investigation' },
];

const ENTITY_TYPE_OPTIONS: { value: EntityType; label: string }[] = [
  { value: 'official', label: 'Elected Official or Appointee' },
  { value: 'agency', label: 'Government Agency' },
  { value: 'legislation', label: 'Bill or Legislation' },
  { value: 'financial_record', label: 'Financial Record' },
  { value: 'other', label: 'Other' },
];

const EMPTY_FORM: FormFields = {
  submission_type: '',
  entity_type: '',
  title: '',
  description: '',
  source_url: '',
  jurisdiction: '',
  contact_email: '',
  website: '',
};

const DESCRIPTION_MIN_LENGTH = 50;
const TITLE_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 5000;
const SOURCE_URL_MAX_LENGTH = 2000;
const JURISDICTION_MAX_LENGTH = 200;
const EMAIL_MAX_LENGTH = 254;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateFields(fields: FormFields): ValidationErrors {
  const errors: ValidationErrors = {};

  if (!fields.submission_type) {
    errors.submission_type = 'Please select a submission type.';
  }

  if (!fields.entity_type) {
    errors.entity_type = 'Please select an entity type.';
  }

  if (!fields.title.trim()) {
    errors.title = 'Title is required.';
  }

  if (fields.description.trim().length < DESCRIPTION_MIN_LENGTH) {
    errors.description = `Description must be at least ${DESCRIPTION_MIN_LENGTH} characters. Currently ${fields.description.trim().length}.`;
  }

  if (!fields.source_url.trim()) {
    errors.source_url = 'A source URL is required to verify the submission.';
  } else {
    try {
      const parsed = new URL(fields.source_url.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.source_url = 'Source URL must use http or https.';
      }
    } catch {
      errors.source_url = 'Please enter a valid URL (e.g. https://example.gov/document).';
    }
  }

  if (fields.contact_email.trim()) {
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(fields.contact_email.trim())) {
      errors.contact_email = 'Please enter a valid email address.';
    }
  }

  return errors;
}

function hasErrors(errors: ValidationErrors): boolean {
  return Object.keys(errors).length > 0;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface FieldErrorProps {
  id: string;
  message: string | undefined;
}

function FieldError({ id, message }: FieldErrorProps) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-red-600 text-xs mt-1 flex items-center gap-1">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 16 16"
        fill="currentColor"
        className="w-3.5 h-3.5 shrink-0"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M8 15A7 7 0 1 0 8 1a7 7 0 0 0 0 14zm0-4a.75.75 0 0 1-.75-.75V8a.75.75 0 0 1 1.5 0v2.25A.75.75 0 0 1 8 11zm.75-5.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0z"
          clipRule="evenodd"
        />
      </svg>
      {message}
    </p>
  );
}

interface LabelProps {
  htmlFor: string;
  children: React.ReactNode;
  required?: boolean;
  optional?: boolean;
}

function FieldLabel({ htmlFor, children, required = false, optional = false }: LabelProps) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-civic-navy mb-1">
      {children}
      {required && (
        <span className="text-red-500 ml-0.5" aria-hidden="true">
          {' '}*
        </span>
      )}
      {optional && (
        <span className="text-civic-slate font-normal text-xs ml-1.5">(optional)</span>
      )}
    </label>
  );
}

function inputClass(hasError: boolean): string {
  return [
    'w-full px-3 py-2 rounded-md border text-sm text-slate-800',
    'placeholder:text-slate-400',
    'focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent',
    'transition-colors',
    hasError
      ? 'border-red-400 bg-red-50 focus:ring-red-400'
      : 'border-slate-300 bg-white',
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Success Banner
// ---------------------------------------------------------------------------

function SuccessBanner({ submissionId, onReset }: { submissionId: string; onReset: () => void }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-green-50 border border-green-200 rounded-lg p-6 text-center"
    >
      <div className="flex justify-center mb-3" aria-hidden="true">
        <span className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-green-100">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-6 h-6 text-green-600"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5z"
              clipRule="evenodd"
            />
          </svg>
        </span>
      </div>
      <h3 className="text-base font-semibold text-green-800 mb-1">Submission Received</h3>
      <p className="text-sm text-green-700 mb-1">
        Thank you for helping make government more transparent.
      </p>
      <p className="text-xs font-mono text-green-600 mb-4">ID: {submissionId}</p>
      <button
        onClick={onReset}
        className="inline-flex items-center gap-1.5 text-sm text-green-700 border border-green-300 rounded-md px-4 py-2 hover:bg-green-100 transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
      >
        Submit another
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function SubmissionForm() {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;

  const [fields, setFields] = useState<FormFields>(EMPTY_FORM);
  const [touched, setTouched] = useState<Partial<Record<keyof FormFields, boolean>>>({});
  const [status, setStatus] = useState<FormStatus>('idle');
  const [apiError, setApiError] = useState<string | null>(null);
  const [successId, setSuccessId] = useState<string | null>(null);

  const errors = validateFields(fields);

  function update<K extends keyof FormFields>(key: K, value: FormFields[K]) {
    setFields(f => ({ ...f, [key]: value }));
  }

  function markTouched(key: keyof FormFields) {
    setTouched(t => ({ ...t, [key]: true }));
  }

  function visibleError(key: keyof ValidationErrors): string | undefined {
    return touched[key] ? errors[key] : undefined;
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    // Mark all validatable fields as touched to surface all errors
    const allTouched: Partial<Record<keyof FormFields, boolean>> = {
      submission_type: true,
      entity_type: true,
      title: true,
      description: true,
      source_url: true,
      contact_email: true,
    };
    setTouched(allTouched);

    if (hasErrors(errors)) return;

    setStatus('submitting');
    setApiError(null);

    try {
      const payload = {
        submission_type: fields.submission_type,
        entity_type: fields.entity_type,
        title: fields.title.trim(),
        description: fields.description.trim(),
        source_url: fields.source_url.trim(),
        jurisdiction: fields.jurisdiction.trim() || null,
        contact_email: fields.contact_email.trim() || null,
        website: fields.website, // honeypot
      };

      const res = await fetch('/api/community/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data: ApiResponse = await res.json();

      if (!res.ok || 'error' in data) {
        throw new Error('error' in data ? data.error : `Server error: ${res.status}`);
      }

      setSuccessId(data.id);
      setStatus('success');
    } catch (err) {
      setApiError(err instanceof Error ? err.message : 'An unexpected error occurred. Please try again.');
      setStatus('error');
    }
  }

  function handleReset() {
    setFields(EMPTY_FORM);
    setTouched({});
    setStatus('idle');
    setApiError(null);
    setSuccessId(null);
  }

  const descriptionLength = fields.description.trim().length;
  const isSubmitting = status === 'submitting';

  if (status === 'success' && successId) {
    return <SuccessBanner submissionId={successId} onReset={handleReset} />;
  }

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      aria-label="Community data submission form"
      className="flex flex-col gap-8"
    >
      {/* Honeypot — visually hidden, must never be filled by a real user */}
      <div aria-hidden="true" className="hidden" tabIndex={-1}>
        <label htmlFor={id('website')}>Website</label>
        <input
          id={id('website')}
          type="text"
          name="website"
          value={fields.website}
          onChange={e => update('website', e.target.value)}
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      {/* Global API error */}
      {status === 'error' && apiError && (
        <div
          role="alert"
          className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-start gap-2.5"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-5 h-5 text-red-500 shrink-0 mt-0.5"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM8.28 7.22a.75.75 0 0 0-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 1 0 1.06 1.06L10 11.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L11.06 10l1.72-1.72a.75.75 0 0 0-1.06-1.06L10 8.94 8.28 7.22z"
              clipRule="evenodd"
            />
          </svg>
          <p className="text-sm text-red-700">{apiError}</p>
        </div>
      )}

      {/* --- Fieldset: Submission Classification --- */}
      <fieldset className="border border-slate-200 rounded-lg p-5">
        <legend className="text-sm font-semibold text-civic-navy px-1 -ml-1">
          Submission Classification
        </legend>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-5">

          {/* Submission type */}
          <div>
            <FieldLabel htmlFor={id('submission_type')} required>
              Submission Type
            </FieldLabel>
            <select
              id={id('submission_type')}
              value={fields.submission_type}
              onChange={e => update('submission_type', e.target.value as SubmissionType | '')}
              onBlur={() => markTouched('submission_type')}
              aria-describedby={
                visibleError('submission_type') ? id('submission_type-error') : undefined
              }
              aria-invalid={!!visibleError('submission_type')}
              className={inputClass(!!visibleError('submission_type'))}
              disabled={isSubmitting}
            >
              <option value="" disabled>
                Select a type...
              </option>
              {SUBMISSION_TYPE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label} — {opt.description}
                </option>
              ))}
            </select>
            <FieldError
              id={id('submission_type-error')}
              message={visibleError('submission_type')}
            />
          </div>

          {/* Entity type */}
          <div>
            <FieldLabel htmlFor={id('entity_type')} required>
              Related Entity Type
            </FieldLabel>
            <select
              id={id('entity_type')}
              value={fields.entity_type}
              onChange={e => update('entity_type', e.target.value as EntityType | '')}
              onBlur={() => markTouched('entity_type')}
              aria-describedby={
                visibleError('entity_type') ? id('entity_type-error') : undefined
              }
              aria-invalid={!!visibleError('entity_type')}
              className={inputClass(!!visibleError('entity_type'))}
              disabled={isSubmitting}
            >
              <option value="" disabled>
                Select an entity...
              </option>
              {ENTITY_TYPE_OPTIONS.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <FieldError
              id={id('entity_type-error')}
              message={visibleError('entity_type')}
            />
          </div>
        </div>
      </fieldset>

      {/* --- Fieldset: Details --- */}
      <fieldset className="border border-slate-200 rounded-lg p-5">
        <legend className="text-sm font-semibold text-civic-navy px-1 -ml-1">Details</legend>
        <div className="mt-3 flex flex-col gap-5">

          {/* Title */}
          <div>
            <FieldLabel htmlFor={id('title')} required>
              Title
            </FieldLabel>
            <p id={id('title-hint')} className="text-xs text-civic-slate mb-1.5">
              A short, descriptive title summarizing the submission.
            </p>
            <input
              id={id('title')}
              type="text"
              value={fields.title}
              onChange={e => update('title', e.target.value)}
              onBlur={() => markTouched('title')}
              maxLength={TITLE_MAX_LENGTH}
              aria-describedby={`${id('title-hint')}${visibleError('title') ? ` ${id('title-error')}` : ''}`}
              aria-invalid={!!visibleError('title')}
              placeholder="e.g. Incorrect district assignment for Rep. Jane Smith"
              className={inputClass(!!visibleError('title'))}
              disabled={isSubmitting}
            />
            <div className="flex items-start justify-between gap-2">
              <FieldError id={id('title-error')} message={visibleError('title')} />
              <span
                className="text-[11px] text-slate-400 font-mono mt-1 ml-auto shrink-0"
                aria-live="polite"
                aria-label={`${fields.title.length} of ${TITLE_MAX_LENGTH} characters`}
              >
                {fields.title.length}/{TITLE_MAX_LENGTH}
              </span>
            </div>
          </div>

          {/* Description */}
          <div>
            <FieldLabel htmlFor={id('description')} required>
              Description
            </FieldLabel>
            <p id={id('description-hint')} className="text-xs text-civic-slate mb-1.5">
              Describe the correction, addition, or tip in detail. Minimum {DESCRIPTION_MIN_LENGTH} characters. Include
              what is wrong, what the correct information is, and why it matters.
            </p>
            <textarea
              id={id('description')}
              value={fields.description}
              onChange={e => update('description', e.target.value)}
              onBlur={() => markTouched('description')}
              maxLength={DESCRIPTION_MAX_LENGTH}
              rows={6}
              aria-describedby={`${id('description-hint')}${visibleError('description') ? ` ${id('description-error')}` : ''}`}
              aria-invalid={!!visibleError('description')}
              placeholder="Provide as much relevant context as possible..."
              className={`${inputClass(!!visibleError('description'))} resize-y min-h-[120px]`}
              disabled={isSubmitting}
            />
            <div className="flex items-start justify-between gap-2">
              <FieldError id={id('description-error')} message={visibleError('description')} />
              <span
                className={`text-[11px] font-mono mt-1 ml-auto shrink-0 ${
                  descriptionLength < DESCRIPTION_MIN_LENGTH
                    ? 'text-amber-600'
                    : 'text-slate-400'
                }`}
                aria-live="polite"
                aria-label={`${descriptionLength} of minimum ${DESCRIPTION_MIN_LENGTH} characters`}
              >
                {descriptionLength}/{DESCRIPTION_MIN_LENGTH} min
              </span>
            </div>
          </div>
        </div>
      </fieldset>

      {/* --- Fieldset: Source --- */}
      <fieldset className="border border-slate-200 rounded-lg p-5">
        <legend className="text-sm font-semibold text-civic-navy px-1 -ml-1">
          Source Verification
        </legend>
        <div className="mt-3">
          <FieldLabel htmlFor={id('source_url')} required>
            Source URL
          </FieldLabel>
          <p id={id('source_url-hint')} className="text-xs text-civic-slate mb-1.5">
            Link to the original document, official record, news article, or other verifiable
            public source that supports this submission. GovGuide only publishes information
            backed by primary or credible secondary sources.
          </p>
          <input
            id={id('source_url')}
            type="url"
            value={fields.source_url}
            onChange={e => update('source_url', e.target.value)}
            onBlur={() => markTouched('source_url')}
            maxLength={SOURCE_URL_MAX_LENGTH}
            aria-describedby={`${id('source_url-hint')}${visibleError('source_url') ? ` ${id('source_url-error')}` : ''}`}
            aria-invalid={!!visibleError('source_url')}
            placeholder="https://www.example.gov/official-document"
            className={inputClass(!!visibleError('source_url'))}
            disabled={isSubmitting}
          />
          <FieldError id={id('source_url-error')} message={visibleError('source_url')} />
        </div>
      </fieldset>

      {/* --- Fieldset: Optional Details --- */}
      <fieldset className="border border-slate-200 rounded-lg p-5">
        <legend className="text-sm font-semibold text-civic-navy px-1 -ml-1">
          Additional Details
          <span className="text-civic-slate font-normal text-xs ml-1.5">(optional)</span>
        </legend>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-5">

          {/* Jurisdiction */}
          <div>
            <FieldLabel htmlFor={id('jurisdiction')} optional>
              Jurisdiction
            </FieldLabel>
            <p id={id('jurisdiction-hint')} className="text-xs text-civic-slate mb-1.5">
              State, county, city, or federal — e.g. "Travis County, TX" or "US Senate".
            </p>
            <input
              id={id('jurisdiction')}
              type="text"
              value={fields.jurisdiction}
              onChange={e => update('jurisdiction', e.target.value)}
              maxLength={JURISDICTION_MAX_LENGTH}
              aria-describedby={id('jurisdiction-hint')}
              placeholder="e.g. Travis County, TX"
              className={inputClass(false)}
              disabled={isSubmitting}
            />
          </div>

          {/* Contact email */}
          <div>
            <FieldLabel htmlFor={id('contact_email')} optional>
              Contact Email
            </FieldLabel>
            <p id={id('contact_email-hint')} className="text-xs text-civic-slate mb-1.5">
              If you'd like to be contacted about your submission. Never published.
            </p>
            <input
              id={id('contact_email')}
              type="email"
              value={fields.contact_email}
              onChange={e => update('contact_email', e.target.value)}
              onBlur={() => markTouched('contact_email')}
              maxLength={EMAIL_MAX_LENGTH}
              aria-describedby={`${id('contact_email-hint')}${visibleError('contact_email') ? ` ${id('contact_email-error')}` : ''}`}
              aria-invalid={!!visibleError('contact_email')}
              placeholder="you@example.com"
              className={inputClass(!!visibleError('contact_email'))}
              disabled={isSubmitting}
              autoComplete="email"
            />
            <FieldError
              id={id('contact_email-error')}
              message={visibleError('contact_email')}
            />
          </div>
        </div>
      </fieldset>

      {/* Submit row */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pt-2">
        <p className="text-xs text-civic-slate max-w-md">
          All submissions are reviewed by the GovGuide team before publication. By submitting you
          confirm that the information is accurate to the best of your knowledge.
        </p>
        <button
          type="submit"
          disabled={isSubmitting}
          className="inline-flex items-center gap-2 px-6 py-2.5 bg-civic-blue text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-civic-blue focus:ring-offset-2 shrink-0"
        >
          {isSubmitting ? (
            <>
              <svg
                className="animate-spin w-4 h-4"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              Submitting...
            </>
          ) : (
            'Submit'
          )}
        </button>
      </div>
    </form>
  );
}
