import { useMemo, useRef, useState, useEffect } from 'react';
import { Copy, Check, Loader2, CalendarClock } from 'lucide-react';

import { TimePicker } from '@/components/TimePicker';
import { useUpdateStaff, type Staff, type StaffSchedule as Schedule } from '@/lib/api';
import { toast } from '@/lib/toast';
import { Can } from '@/lib/permissions';

const DAYS = [
  { key: '0', short: 'Sun', long: 'Sunday' },
  { key: '1', short: 'Mon', long: 'Monday' },
  { key: '2', short: 'Tue', long: 'Tuesday' },
  { key: '3', short: 'Wed', long: 'Wednesday' },
  { key: '4', short: 'Thu', long: 'Thursday' },
  { key: '5', short: 'Fri', long: 'Friday' },
  { key: '6', short: 'Sat', long: 'Saturday' },
] as const;

const DEFAULT_RANGE = { start: '09:00', end: '17:00' };

/** "HH:MM" 24h → "9:00 AM" in the user's locale. */
function label12(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function sameSchedule(a: Schedule, b: Schedule): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => {
    const av = a[k];
    const bv = b[k];
    return !!av && !!bv && av.start === bv.start && av.end === bv.end;
  });
}

/**
 * Weekly recurring shift template. Each day is either off or a single time
 * range. A "copy to…" popover clones one day's range across other days, with
 * Weekdays / All-days quick-picks. Edits are staged locally and committed in a
 * single PATCH to the staff row's `schedule` jsonb.
 */
export function StaffSchedule({ staff }: { staff: Staff }) {
  const update = useUpdateStaff(staff.id);
  const [draft, setDraft] = useState<Schedule>(staff.schedule ?? {});

  // Re-sync when the upstream record changes (e.g. after a save invalidates).
  useEffect(() => {
    setDraft(staff.schedule ?? {});
  }, [staff.schedule]);

  const dirty = useMemo(() => !sameSchedule(draft, staff.schedule ?? {}), [draft, staff.schedule]);
  const invalid = useMemo(
    () => Object.values(draft).some((r) => r.start >= r.end),
    [draft],
  );

  const setDay = (key: string, range: { start: string; end: string } | null) => {
    setDraft((prev) => {
      const next = { ...prev };
      if (range) next[key] = range;
      else delete next[key];
      return next;
    });
  };

  const cloneTo = (source: { start: string; end: string }, targets: string[]) => {
    setDraft((prev) => {
      const next = { ...prev };
      for (const k of targets) next[k] = { ...source };
      return next;
    });
  };

  const save = async () => {
    try {
      await update.mutateAsync({ schedule: draft });
      toast.success('Schedule saved');
    } catch (err) {
      toast.error('Could not save schedule', (err as { message?: string }).message ?? 'Please try again.');
    }
  };

  const workingCount = Object.keys(draft).length;

  return (
    <div className="panel staff-schedule">
      <div className="staff-schedule__head">
        <div className="staff-schedule__title">
          <CalendarClock size={16} strokeWidth={1.6} />
          <h3>Weekly shifts</h3>
          <span className="staff-schedule__count">
            {workingCount === 0 ? 'No days set' : `${workingCount} working ${workingCount === 1 ? 'day' : 'days'}`}
          </span>
        </div>
        <Can perm="staff:update">
          <button
            className="btn small primary"
            onClick={() => void save()}
            disabled={!dirty || invalid || update.isPending}
          >
            {update.isPending ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
            Save schedule
          </button>
        </Can>
      </div>

      <div className="staff-week">
        {DAYS.map((d) => {
          const range = draft[d.key];
          const working = !!range;
          const badRange = working && range.start >= range.end;
          return (
            <div key={d.key} className={`staff-day ${working ? 'on' : 'off'}`}>
              <Can
                perm="staff:update"
                fallback={
                  <>
                    <span className="staff-day__name">{d.short}</span>
                    <span className="staff-day__static">
                      {working ? `${label12(range.start)} – ${label12(range.end)}` : 'Rest day'}
                    </span>
                  </>
                }
              >
                <label className="staff-day__toggle" title={working ? 'Working' : 'Rest day'}>
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
                    <CloneMenu sourceKey={d.key} range={range} onClone={cloneTo} />
                  </>
                ) : (
                  <span className="staff-day__rest">Rest day</span>
                )}
              </Can>
            </div>
          );
        })}
      </div>
      {dirty && <p className="staff-schedule__hint">Unsaved changes — click “Save schedule”.</p>}
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
