import { useState, useRef, useEffect } from 'react';

interface JudgeResult {
  id: string;
  slug: string;
  name: string;
  court: string;
  appointed_by: string | null;
}

interface ApiResponse {
  results: JudgeResult[];
}

export default function JudgeSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<JudgeResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ search: query.trim() });
        const res = await fetch(`/api/judicial?${params}`);
        if (!res.ok) throw new Error('Search failed');
        const data: ApiResponse = await res.json();
        setResults(data.results ?? []);
        setOpen((data.results ?? []).length > 0);
        setSelectedIndex(-1);
      } catch {
        setResults([]);
        setOpen(false);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(debounceRef.current);
  }, [query]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      e.preventDefault();
      navigateToJudge(results[selectedIndex].slug);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  function navigateToJudge(slug: string) {
    window.location.href = `/judicial/judges/${slug}`;
  }

  function handleBlur() {
    // Delay so click on result registers before dropdown closes
    setTimeout(() => setOpen(false), 150);
  }

  return (
    <div className="relative w-full max-w-2xl mx-auto">
      <label htmlFor="judge-search" className="sr-only">
        Search judges by name or court
      </label>
      <div className="relative">
        <div
          className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-4"
          aria-hidden="true"
        >
          <svg
            className="w-5 h-5 text-slate-400"
            viewBox="0 0 20 20"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" strokeWidth="1.5" />
            <path
              d="M13 13l3.5 3.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <input
          id="judge-search"
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => results.length > 0 && setOpen(true)}
          onBlur={handleBlur}
          placeholder="Search judges by name, court, or appointing president..."
          autoComplete="off"
          className="w-full pl-12 pr-4 py-3.5 bg-white border border-slate-300 rounded-xl text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-civic-blue focus:border-transparent shadow-sm"
          aria-label="Search judges"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={open ? 'judge-search-results' : undefined}
          aria-activedescendant={selectedIndex >= 0 ? `judge-result-${selectedIndex}` : undefined}
          role="combobox"
        />
        {loading && (
          <div
            className="absolute inset-y-0 right-4 flex items-center"
            aria-live="polite"
            aria-label="Loading results"
          >
            <div className="w-4 h-4 rounded-full border-2 border-civic-blue border-t-transparent animate-spin" />
          </div>
        )}
      </div>

      {open && results.length > 0 && (
        <ul
          id="judge-search-results"
          role="listbox"
          aria-label="Judge search results"
          className="absolute z-50 top-full mt-2 w-full bg-white rounded-xl shadow-lg border border-slate-200 max-h-80 overflow-y-auto"
        >
          {results.map((judge, i) => (
            <li key={judge.id} role="option" aria-selected={i === selectedIndex}>
              <button
                id={`judge-result-${i}`}
                onClick={() => navigateToJudge(judge.slug)}
                className={`w-full text-left px-4 py-3 text-sm transition-colors flex items-start gap-3 ${
                  i === selectedIndex
                    ? 'bg-civic-blue/5 text-civic-navy'
                    : 'hover:bg-slate-50 text-slate-800'
                } ${i < results.length - 1 ? 'border-b border-slate-100' : ''}`}
              >
                {/* Avatar initial */}
                <span
                  className="mt-0.5 shrink-0 w-7 h-7 rounded-full bg-[#2d2d4e] flex items-center justify-center text-xs font-display font-bold text-white/70"
                  aria-hidden="true"
                >
                  {judge.name.charAt(0).toUpperCase()}
                </span>

                <span className="flex-1 min-w-0">
                  <span className="block font-semibold text-slate-900 truncate">{judge.name}</span>
                  <span className="block text-xs text-civic-slate mt-0.5 truncate">{judge.court}</span>
                </span>

                {judge.appointed_by && (
                  <span className="shrink-0 text-xs text-slate-400 whitespace-nowrap mt-1">
                    Appt. {judge.appointed_by}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {!loading && query.trim().length >= 2 && results.length === 0 && open === false && (
        <p className="mt-3 text-sm text-slate-500 text-center" aria-live="polite">
          No judges found for &ldquo;{query}&rdquo;. Try a different name or court.
        </p>
      )}
    </div>
  );
}
