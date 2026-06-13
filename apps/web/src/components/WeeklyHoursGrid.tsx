import { useEffect, useRef, useState } from 'react';
import { Copy } from 'lucide-react';

import { TimePicker } from '@/components/TimePicker';
import type { StaffSchedule as Schedule } from '@/lib/api';

export const DAYS = [
  { key: '0', short: 'Sun', long: 'Sunday' },
  { key: '1', short: 'Mon', long: 'Monday' },
  { key: '2', short: 'Tue', long: 'Tuesday' },
  { key: '3', short: 'Wed', long: 'Wednesday' },
  { key: '4', short: 'Thu', long: 'Thursday' },
  { key: '5', short: 'Fri', long: 'Friday' },
  { key: '6', short: 'Sat', long: 'Saturday' },
] as const;

export const DEFAULT_RANGE = { start: '09:00', end: '17:00' };

/** "HH:MM" 24h → "9:00 AM" in the user's locale. */
export function label12(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

type Props = {
  value: Schedule;
  onChange: (next: Schedule) => void;
  /** When true, renders a static read-only summary per day (no inputs). */
  readOnly?: boolean;
  /** Show the per-day "Copy to…" popover. */
  showClone?: boolean;
  /** Word used in the off-day state — "Rest day" for staff, "Closed" for the cafe. */
  offLabel?: string;
};

/**
 * Controlled weekly time-range editor. Each day is either off or a single
 * "HH:MM" start–end range. Shared by the staff shift template and the cafe
 * opening-hours setting so the two read identically. Holds no fetch state —
 * the parent owns the value and persistence.
 */
export function WeeklyHoursGrid({ value, onChange, readOnly = false, showClone = false, offLabel = 'Rest day' }: Props) {
  const setDay = (key: string, range: { start: string; end: string } | null) => {
    const next = { ...value };
    if (range) next[key] = range;
    else delete next[key];
    onChange(next);
  };

  const cloneTo = (source: { start: string; end: string }, targets: string[]) => {
    const next = { ...value };
    for (const k of targets) next[k] = { ...source };
    onChange(next);
  };

  return (
    <div className="staff-week">
      {DAYS.map((d) => {
        const range = value[d.key];
        const working = !!range;
        const badRange = working && range.start >= range.end;
        return (
          <div key={d.key} className={`staff-day ${working ? 'on' : 'off'}`}>
            {readOnly ? (
              <>
                <span className="staff-day__name">{d.short}</span>
                <span className="staff-day__static">
                  {working ? `${label12(range.start)} – ${label12(range.end)}` : offLabel}
                </span>
              </>
            ) : (
              <>
                <label className="staff-day__toggle" title={working ? 'Open' : offLabel}>
                  <input
                    type="checkbox"
                    checked={working}
                    onChange={(e) => setDay(d.key, e.target.checked ? { ...DEFAULT_RANGE } : null)}
                  />
                  <span className="staff-day__name">{d.short}</span>
                </label>

                {working ? (
                  <>
                    <div className={`staff-day__range ${badRange ? 'is-bad' : ''}`}>
                      <TimePicker
                        value={range.start}
                        onChange={(v) => setDay(d.key, { ...range, start: v })}
                        step={30}
                      />
                      <span className="staff-day__dash">–</span>
                      <TimePicker
                        value={range.end}
                        onChange={(v) => setDay(d.key, { ...range, end: v })}
                        step={30}
                      />
                    </div>
                    {badRange && <span className="staff-day__warn">End must be after start</span>}
                    {showClone && <CloneMenu sourceKey={d.key} range={range} onClone={cloneTo} />}
                  </>
                ) : (
                  <span className="staff-day__rest">{offLabel}</span>
                )}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Per-day "copy this range to other days" popover. */
function CloneMenu({
  sourceKey,
  range,
  onClone,
}: {
  sourceKey: string;
  range: { start: string; end: string };
  onClone: (range: { start: string; end: string }, targets: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);

  const others = DAYS.filter((d) => d.key !== sourceKey);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  const toggle = (key: string) =>
    setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));

  const apply = (targets: string[]) => {
    if (targets.length) onClone(range, targets);
    setPicked([]);
    setOpen(false);
  };

  const weekdays = ['1', '2', '3', '4', '5'].filter((k) => k !== sourceKey);
  const allDays = others.map((d) => d.key);

  return (
    <div className="staff-clone" ref={wrapRef}>
      <button
        type="button"
        className="btn small ghost staff-clone__trigger"
        title="Copy this range to other days"
        onClick={() => setOpen((o) => !o)}
      >
        <Copy size={13} strokeWidth={1.6} /> Copy to…
      </button>
      {open && (
        <div className="staff-clone__pop" role="dialog">
          <div className="staff-clone__quick">
            <button type="button" className="btn small" onClick={() => apply(weekdays)}>
              Weekdays
            </button>
            <button type="button" className="btn small" onClick={() => apply(allDays)}>
              All days
            </button>
          </div>
          <div className="staff-clone__list">
            {others.map((d) => (
              <label key={d.key} className="staff-clone__opt">
                <input type="checkbox" checked={picked.includes(d.key)} onChange={() => toggle(d.key)} />
                <span>{d.long}</span>
              </label>
            ))}
          </div>
          <button
            type="button"
            className="btn small primary staff-clone__apply"
            disabled={picked.length === 0}
            onClick={() => apply(picked)}
          >
            Apply to {picked.length || 0} {picked.length === 1 ? 'day' : 'days'}
          </button>
        </div>
      )}
    </div>
  );
}
