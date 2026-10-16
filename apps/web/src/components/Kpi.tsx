import { TrendingDown, TrendingUp } from 'lucide-react';

import { InfoHint } from '@/components/InfoHint';
import { formatNPR } from '@/components/Money';

/** One dashboard KPI card. `cents` renders as money, `raw` as a plain number;
 *  `sign` colours it and adds a trend arrow by sign. */
export function Kpi({
  label,
  cents,
  raw,
  sign,
  subtext,
  hintTopic,
}: {
  label: string;
  cents?: number;
  raw?: number;
  sign?: boolean;
  subtext?: string;
  hintTopic?: string;
}) {
  const value = raw != null ? raw.toString() : formatNPR(cents ?? 0);
  const positive = (cents ?? raw ?? 0) >= 0;
  return (
    <div className="kpi">
      <div className="label">
        {label}
        {hintTopic && <InfoHint topic={hintTopic} />}
      </div>
      <div
        className="value"
        style={sign ? { color: positive ? 'var(--lime-fg)' : 'var(--danger-fg)' } : undefined}
      >
        {sign &&
          (positive ? (
            <TrendingUp size={20} strokeWidth={1.5} style={{ marginRight: 6 }} />
          ) : (
            <TrendingDown size={20} strokeWidth={1.5} style={{ marginRight: 6 }} />
          ))}
        {value}
      </div>
      {subtext && <div className="delta">{subtext}</div>}
    </div>
  );
}
