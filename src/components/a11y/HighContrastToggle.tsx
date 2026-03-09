import { useEffect, useState } from 'react';

const STORAGE_KEY = 'govguide-high-contrast';
const HTML_CLASS = 'high-contrast';

function readStoredPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function applyContrast(enabled: boolean): void {
  if (enabled) {
    document.documentElement.classList.add(HTML_CLASS);
  } else {
    document.documentElement.classList.remove(HTML_CLASS);
  }
}

export default function HighContrastToggle() {
  const [enabled, setEnabled] = useState(false);

  // Sync with stored preference on mount (runs client-side only)
  useEffect(() => {
    const stored = readStoredPreference();
    setEnabled(stored);
    applyContrast(stored);
  }, []);

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    applyContrast(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // localStorage unavailable — silently continue
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={enabled}
      aria-label={enabled ? 'Disable high contrast mode' : 'Enable high contrast mode'}
      title={enabled ? 'Disable high contrast mode' : 'Enable high contrast mode'}
      className={[
        'inline-flex items-center justify-center w-8 h-8 rounded-md transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-civic-blue focus:ring-offset-1',
        enabled
          ? 'bg-civic-navy text-white border border-white'
          : 'bg-slate-100 text-slate-600 hover:bg-slate-200 border border-slate-300',
      ].join(' ')}
    >
      {/* Accessibility / contrast icon */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {/* Half-filled circle representing contrast */}
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3v18" />
        <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none" />
      </svg>
    </button>
  );
}
