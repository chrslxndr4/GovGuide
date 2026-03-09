interface SeverityBadgeProps {
  score: number; // 0.0 to 10.0
}

type SeverityLevel = 'critical' | 'high' | 'medium' | 'low';

interface SeverityConfig {
  label: string;
  bgColor: string;
  textColor: string;
}

function getSeverityLevel(score: number): SeverityLevel {
  if (score >= 8) return 'critical';
  if (score >= 6) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

const SEVERITY_CONFIG: Record<SeverityLevel, SeverityConfig> = {
  critical: {
    label: 'Critical',
    bgColor: '#DC2626',
    textColor: '#FFFFFF',
  },
  high: {
    label: 'High',
    bgColor: '#D97706',
    textColor: '#FFFFFF',
  },
  medium: {
    label: 'Medium',
    bgColor: '#F59E0B',
    textColor: '#1C1917',
  },
  low: {
    label: 'Low',
    bgColor: '#475569',
    textColor: '#FFFFFF',
  },
};

export default function SeverityBadge({ score }: SeverityBadgeProps) {
  const level = getSeverityLevel(score);
  const config = SEVERITY_CONFIG[level];
  const displayScore = score.toFixed(1);

  return (
    <span
      style={{ backgroundColor: config.bgColor, color: config.textColor }}
      className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold leading-none whitespace-nowrap"
      aria-label={`Severity: ${config.label}, score ${displayScore}`}
    >
      {config.label}
      <span className="opacity-80 font-mono">{displayScore}</span>
    </span>
  );
}

export { getSeverityLevel, SEVERITY_CONFIG };
export type { SeverityLevel, SeverityConfig };
