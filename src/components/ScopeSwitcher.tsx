import { useState } from 'react';

export type Scope = 'federal' | 'states' | 'counties' | 'cities' | 'districts';

interface ScopeSwitcherProps {
  onScopeChange: (scope: Scope) => void;
  initialScope?: Scope;
}

const scopes: { id: Scope; label: string }[] = [
  { id: 'federal', label: 'Federal' },
  { id: 'states', label: 'States' },
  { id: 'counties', label: 'Counties' },
  { id: 'cities', label: 'Cities' },
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
