import SeverityBadge, { getSeverityLevel } from './SeverityBadge';

interface EntityRef {
  id: string;
  name: string;
  type: string;
}

interface ConflictAlert {
  id: string;
  alert_type: string;
  severity_score: number;
  entity_ids: string[];
  description: string;
  evidence: Record<string, string | number | boolean | null>;
  detected_at: string;
  status: 'active' | 'reviewed' | 'dismissed';
  entities?: EntityRef[];
}

interface ConflictCardProps {
  alert: ConflictAlert;
}

const ALERT_TYPE_LABELS: Record<string, string> = {
  donor_vote: 'Donor-Vote Conflict',
  stock_committee: 'Stock-Committee Conflict',
  trade_timing: 'Trade Timing',
  judicial_financial: 'Judicial Financial',
  contract_donor: 'Contract-Donor Conflict',
  revolving_door: 'Revolving Door',
  dark_money_chain: 'Dark Money',
  prediction_insider: 'Insider Trading',
};

const SEVERITY_BORDER_COLORS: Record<string, string> = {
  critical: '#DC2626',
  high: '#D97706',
  medium: '#F59E0B',
  low: '#475569',
};

const STATUS_STYLES: Record<ConflictAlert['status'], string> = {
  active: 'bg-red-50 text-[#DC2626] border border-red-200',
  reviewed: 'bg-blue-50 text-[#2563EB] border border-blue-200',
  dismissed: 'bg-slate-100 text-[#475569] border border-slate-200',
};

const STATUS_LABELS: Record<ConflictAlert['status'], string> = {
  active: 'Active',
  reviewed: 'Reviewed',
  dismissed: 'Dismissed',
};

function formatAlertType(alertType: string): string {
  return ALERT_TYPE_LABELS[alertType] ?? alertType.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDetectedAt(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatEvidenceKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatEvidenceValue(value: string | number | boolean | null): string {
  if (value === null || value === undefined) return 'N/A';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return value.toLocaleString();
  return String(value);
}

function EvidenceSummary({ evidence }: { evidence: ConflictAlert['evidence'] }) {
  const entries = Object.entries(evidence);
  if (entries.length === 0) return null;

  return (
    <div className="mt-3 p-3 bg-[#F8FAFC] rounded-md border border-slate-100">
      <p className="text-xs font-semibold text-[#1B2A4A] uppercase tracking-wider mb-2">
        Evidence
      </p>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-baseline gap-1.5 min-w-0">
            <dt className="text-xs text-[#475569] shrink-0">{formatEvidenceKey(key)}:</dt>
            <dd className="text-xs text-[#1B2A4A] font-medium truncate">
              {formatEvidenceValue(value)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function EntityPills({ entities, entityIds }: { entities: EntityRef[] | undefined; entityIds: string[] }) {
  if (entities && entities.length > 0) {
    return (
      <div className="flex flex-wrap gap-1.5 mt-3">
        {entities.map((entity) => (
          <a
            key={entity.id}
            href={`/entities/${entity.id}`}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#1B2A4A]/8 text-[#1B2A4A] text-xs font-medium hover:bg-[#2563EB]/10 hover:text-[#2563EB] transition-colors border border-[#1B2A4A]/12"
          >
            <span className="text-[10px] text-[#475569] font-normal">{entity.type}</span>
            {entity.name}
          </a>
        ))}
      </div>
    );
  }

  if (entityIds.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-3">
      {entityIds.map((id) => (
        <a
          key={id}
          href={`/entities/${id}`}
          className="inline-flex items-center px-2 py-0.5 rounded bg-[#1B2A4A]/8 text-[#1B2A4A] text-xs font-medium hover:bg-[#2563EB]/10 hover:text-[#2563EB] transition-colors border border-[#1B2A4A]/12 font-mono"
        >
          {id}
        </a>
      ))}
    </div>
  );
}

export default function ConflictCard({ alert }: ConflictCardProps) {
  const level = getSeverityLevel(alert.severity_score);
  const borderColor = SEVERITY_BORDER_COLORS[level];
  const typeLabel = formatAlertType(alert.alert_type);
  const detectedDate = formatDetectedAt(alert.detected_at);

  return (
    <article
      className="bg-white rounded-lg border border-slate-200 overflow-hidden shadow-sm hover:shadow-md transition-shadow"
      style={{ borderLeftColor: borderColor, borderLeftWidth: '4px' }}
      aria-label={`Conflict alert: ${typeLabel}`}
    >
      {/* Header */}
      <div className="px-5 pt-4 pb-3 flex flex-wrap items-start gap-3 justify-between">
        <div className="flex items-center gap-2.5 flex-wrap">
          <h3 className="text-sm font-semibold text-[#1B2A4A] leading-snug">{typeLabel}</h3>
          <SeverityBadge score={alert.severity_score} />
        </div>
        <time
          dateTime={alert.detected_at}
          className="text-xs text-[#475569] shrink-0 mt-0.5"
        >
          {detectedDate}
        </time>
      </div>

      {/* Body */}
      <div className="px-5 pb-3">
        <p className="text-sm text-[#475569] leading-relaxed">{alert.description}</p>

        <EntityPills entities={alert.entities} entityIds={alert.entity_ids} />

        <EvidenceSummary evidence={alert.evidence} />
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-slate-100 flex items-center justify-between gap-3">
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_STYLES[alert.status]}`}
        >
          {STATUS_LABELS[alert.status]}
        </span>
        <a
          href={`/conflicts/${alert.id}`}
          className="text-xs font-medium text-[#2563EB] hover:underline shrink-0"
        >
          View full details &rarr;
        </a>
      </div>
    </article>
  );
}

export type { ConflictAlert, EntityRef };
