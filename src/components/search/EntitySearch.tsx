import { useState, useRef, useEffect } from 'react';

interface SearchResult {
  id: string;
  name: string;
  type: string;
  category: 'entity' | 'official' | 'bill' | 'judge';
  detail?: string;
}

interface EntitySearchProps {
  onSelect: (result: SearchResult) => void;
  placeholder?: string;
  types?: string[];
}

export default function EntitySearch({
  onSelect,
  placeholder = 'Search officials, organizations, bills...',
  types,
}: EntitySearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (query.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }

    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ q: query, limit: '10' });
        if (types?.length === 1) params.set('type', types[0]);
        const res = await fetch(`/api/search?${params}`);
        const data = await res.json();

        const mapped: SearchResult[] = [];
        if (data.results.entities) {
          for (const e of data.results.entities) {
            mapped.push({
              id: e.id,
              name: e.name,
              type: e.entity_type,
              category: 'entity',
              detail: e.entity_type.replace(/_/g, ' '),
            });
          }
        }
        if (data.results.officials) {
          for (const o of data.results.officials) {
            mapped.push({
              id: o.id,
              name: o.full_name,
              type: 'official',
              category: 'official',
              detail: `${o.party} — ${o.office?.title || ''}`,
            });
          }
        }
        if (data.results.bills) {
          for (const b of data.results.bills) {
            mapped.push({
              id: b.id,
              name: b.title.length > 60 ? b.title.slice(0, 57) + '...' : b.title,
              type: 'bill',
              category: 'bill',
              detail: b.bill_id,
            });
          }
        }
        if (data.results.judges) {
          for (const j of data.results.judges) {
            mapped.push({
              id: j.id,
              name: j.full_name,
              type: 'judge',
              category: 'judge',
              detail: j.court?.name || '',
            });
          }
        }

        setResults(mapped);
        setOpen(mapped.length > 0);
        setSelectedIndex(-1);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
  }, [query]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      e.preventDefault();
      onSelect(results[selectedIndex]);
      setOpen(false);
      setQuery(results[selectedIndex].name);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const CATEGORY_COLORS: Record<string, string> = {
    entity: 'bg-blue-100 text-blue-700',
    official: 'bg-green-100 text-green-700',
    bill: 'bg-amber-100 text-amber-700',
    judge: 'bg-purple-100 text-purple-700',
  };

  return (
    <div className="relative w-full">
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => results.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        placeholder={placeholder}
        className="w-full px-4 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {loading && (
        <div className="absolute right-3 top-2.5 text-xs text-slate-400">...</div>
      )}

      {open && results.length > 0 && (
        <div className="absolute z-50 top-full mt-1 w-full bg-white rounded-lg shadow-lg border border-slate-200 max-h-80 overflow-y-auto">
          {results.map((r, i) => (
            <button
              key={`${r.category}-${r.id}`}
              onClick={() => {
                onSelect(r);
                setOpen(false);
                setQuery(r.name);
              }}
              className={`w-full text-left px-4 py-2 text-sm hover:bg-slate-50 flex items-center gap-2 ${
                i === selectedIndex ? 'bg-slate-100' : ''
              }`}
            >
              <span className={`text-xs px-1.5 py-0.5 rounded ${CATEGORY_COLORS[r.category] || ''}`}>
                {r.category}
              </span>
              <span className="font-medium text-slate-800 truncate">{r.name}</span>
              {r.detail && (
                <span className="text-xs text-slate-500 ml-auto shrink-0">{r.detail}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
