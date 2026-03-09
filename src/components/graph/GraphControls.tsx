// ─── Types ────────────────────────────────────────────────────────────────────

interface GraphControlsProps {
  depth: number;
  onDepthChange: (depth: number) => void;
  minAmount: number;
  onMinAmountChange: (amount: number) => void;
  relationshipTypes: string[];
  activeTypes: string[];
  onToggleType: (type: string) => void;
  layout: string;
  onLayoutChange: (layout: string) => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LAYOUT_OPTIONS: { value: string; label: string }[] = [
  { value: 'cose', label: 'Force-directed' },
  { value: 'breadthfirst', label: 'Hierarchical' },
  { value: 'circle', label: 'Circular' },
];

const RELATIONSHIP_TYPE_META: Record<string, { label: string; color: string }> = {
  donation: { label: 'Donations', color: '#059669' },
  lobbying: { label: 'Lobbying', color: '#D97706' },
  contract: { label: 'Contracts', color: '#DC2626' },
};

const AMOUNT_PRESETS: { label: string; value: number }[] = [
  { label: 'Any', value: 0 },
  { label: '$1K+', value: 1_000 },
  { label: '$10K+', value: 10_000 },
  { label: '$100K+', value: 100_000 },
  { label: '$1M+', value: 1_000_000 },
];

// ─── GraphControls ────────────────────────────────────────────────────────────

export default function GraphControls({
  depth,
  onDepthChange,
  minAmount,
  onMinAmountChange,
  relationshipTypes,
  activeTypes,
  onToggleType,
  layout,
  onLayoutChange,
}: GraphControlsProps) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5"
      role="toolbar"
      aria-label="Graph controls"
    >
      {/* ── Depth slider ────────────────────────────────────────────────────── */}
      <fieldset className="flex items-center gap-2">
        <legend className="text-[10px] font-semibold text-civic-slate uppercase tracking-wider sr-only">
          Depth
        </legend>
        <label
          htmlFor="graph-depth"
          className="text-[10px] font-semibold text-civic-slate uppercase tracking-wider whitespace-nowrap"
        >
          Depth
        </label>
        <div className="flex items-center gap-1.5">
          <input
            id="graph-depth"
            type="range"
            min={1}
            max={5}
            step={1}
            value={depth}
            onChange={(e) => onDepthChange(Number(e.target.value))}
            className="w-24 h-1.5 accent-civic-navy cursor-pointer"
            aria-valuemin={1}
            aria-valuemax={5}
            aria-valuenow={depth}
          />
          <span className="text-xs font-mono font-bold text-civic-navy w-4 text-center">{depth}</span>
        </div>
      </fieldset>

      {/* ── Divider ─────────────────────────────────────────────────────────── */}
      <span className="hidden sm:block w-px h-5 bg-slate-200 flex-none" aria-hidden="true" />

      {/* ── Min amount presets ──────────────────────────────────────────────── */}
      <fieldset className="flex items-center gap-1.5">
        <legend className="text-[10px] font-semibold text-civic-slate uppercase tracking-wider whitespace-nowrap mr-1">
          Min Amount
        </legend>
        {AMOUNT_PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            onClick={() => onMinAmountChange(preset.value)}
            aria-pressed={minAmount === preset.value}
            className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
              minAmount === preset.value
                ? 'bg-civic-navy text-white'
                : 'bg-slate-100 text-civic-slate hover:bg-slate-200 hover:text-civic-navy'
            }`}
          >
            {preset.label}
          </button>
        ))}
      </fieldset>

      {/* ── Divider ─────────────────────────────────────────────────────────── */}
      <span className="hidden sm:block w-px h-5 bg-slate-200 flex-none" aria-hidden="true" />

      {/* ── Relationship type toggles ────────────────────────────────────────── */}
      <fieldset className="flex items-center gap-2">
        <legend className="text-[10px] font-semibold text-civic-slate uppercase tracking-wider whitespace-nowrap">
          Show
        </legend>
        {relationshipTypes.map((type) => {
          const meta = RELATIONSHIP_TYPE_META[type] ?? { label: type, color: '#475569' };
          const isActive = activeTypes.includes(type);
          return (
            <label
              key={type}
              className="flex items-center gap-1 cursor-pointer select-none"
              title={`Toggle ${meta.label}`}
            >
              <input
                type="checkbox"
                checked={isActive}
                onChange={() => onToggleType(type)}
                className="sr-only"
              />
              <span
                className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                  isActive
                    ? 'border-transparent text-white'
                    : 'bg-white border-slate-200 text-civic-slate hover:border-slate-400'
                }`}
                style={isActive ? { backgroundColor: meta.color } : undefined}
                aria-hidden="true"
              >
                <span
                  className="w-2 h-2 rounded-full flex-none"
                  style={{ backgroundColor: isActive ? '#ffffff' : meta.color }}
                />
                {meta.label}
              </span>
            </label>
          );
        })}
      </fieldset>

      {/* ── Divider ─────────────────────────────────────────────────────────── */}
      <span className="hidden sm:block w-px h-5 bg-slate-200 flex-none" aria-hidden="true" />

      {/* ── Layout selector ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <label
          htmlFor="graph-layout"
          className="text-[10px] font-semibold text-civic-slate uppercase tracking-wider whitespace-nowrap"
        >
          Layout
        </label>
        <select
          id="graph-layout"
          value={layout}
          onChange={(e) => onLayoutChange(e.target.value)}
          className="text-[11px] font-medium text-civic-navy bg-slate-50 border border-slate-200 rounded px-2 py-0.5 cursor-pointer hover:border-slate-300 focus:outline-none focus:ring-1 focus:ring-civic-blue"
        >
          {LAYOUT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
