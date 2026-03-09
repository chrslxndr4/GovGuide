import { useState } from 'react';

interface GraphControlsProps {
  hops: number;
  onHopsChange: (hops: number) => void;
  minAmount: number | undefined;
  onMinAmountChange: (amount: number | undefined) => void;
  relationshipTypes: string[];
  onRelationshipTypesChange: (types: string[]) => void;
  onExport?: () => void;
}

const RELATIONSHIP_TYPE_OPTIONS = [
  { value: 'donated_to', label: 'Donations' },
  { value: 'contributed_to', label: 'Contributions' },
  { value: 'spent_for', label: 'Spent For' },
  { value: 'spent_against', label: 'Spent Against' },
  { value: 'lobbied_via', label: 'Lobbied Via' },
  { value: 'granted_to', label: 'Grants' },
  { value: 'paid_by', label: 'Contracts' },
  { value: 'affiliated_with', label: 'Affiliations' },
];

const AMOUNT_THRESHOLDS = [
  { value: undefined, label: 'No minimum' },
  { value: 1000, label: '$1,000+' },
  { value: 10000, label: '$10,000+' },
  { value: 50000, label: '$50,000+' },
  { value: 100000, label: '$100,000+' },
  { value: 500000, label: '$500,000+' },
  { value: 1000000, label: '$1,000,000+' },
];

export default function GraphControls({
  hops,
  onHopsChange,
  minAmount,
  onMinAmountChange,
  relationshipTypes,
  onRelationshipTypesChange,
  onExport,
}: GraphControlsProps) {
  const [expanded, setExpanded] = useState(false);

  function toggleRelType(type: string) {
    if (relationshipTypes.includes(type)) {
      onRelationshipTypesChange(relationshipTypes.filter(t => t !== type));
    } else {
      onRelationshipTypesChange([...relationshipTypes, type]);
    }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-800 text-sm">Graph Controls</h3>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-blue-600 hover:text-blue-800"
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>

      {/* Depth slider */}
      <div>
        <label className="block text-xs text-slate-600 mb-1">
          Depth: {hops} hop{hops !== 1 ? 's' : ''}
        </label>
        <input
          type="range"
          min={1}
          max={5}
          value={hops}
          onChange={e => onHopsChange(parseInt(e.target.value))}
          className="w-full"
        />
      </div>

      {/* Amount threshold */}
      <div>
        <label className="block text-xs text-slate-600 mb-1">Minimum Amount</label>
        <select
          value={minAmount ?? ''}
          onChange={e => onMinAmountChange(e.target.value ? parseInt(e.target.value) : undefined)}
          className="w-full text-sm border border-slate-300 rounded px-2 py-1"
        >
          {AMOUNT_THRESHOLDS.map(t => (
            <option key={t.label} value={t.value ?? ''}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {expanded && (
        <>
          {/* Relationship type toggles */}
          <div>
            <label className="block text-xs text-slate-600 mb-2">Relationship Types</label>
            <div className="flex flex-wrap gap-1">
              {RELATIONSHIP_TYPE_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => toggleRelType(opt.value)}
                  className={`text-xs px-2 py-1 rounded ${
                    relationshipTypes.length === 0 || relationshipTypes.includes(opt.value)
                      ? 'bg-blue-100 text-blue-800 border border-blue-300'
                      : 'bg-slate-100 text-slate-500 border border-slate-200'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {relationshipTypes.length > 0 && (
              <button
                onClick={() => onRelationshipTypesChange([])}
                className="text-xs text-slate-500 mt-1 hover:text-slate-700"
              >
                Show all types
              </button>
            )}
          </div>

          {/* Export */}
          {onExport && (
            <button
              onClick={onExport}
              className="w-full text-sm bg-slate-100 text-slate-700 py-2 rounded hover:bg-slate-200"
            >
              Export Graph Data
            </button>
          )}
        </>
      )}
    </div>
  );
}
