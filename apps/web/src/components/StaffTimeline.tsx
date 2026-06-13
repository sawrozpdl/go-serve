import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus, X, Clock, TrendingUp, Users, AlertTriangle } from 'lucide-react';

import {
  useTenantSettings,
  useUpdateStaff,
  type Staff,
  type StaffSchedule,
} from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { toast } from '@/lib/toast';
import {
  coverageForDay,
  dayOpenRange,
  fromMinutes,
  runsWithin,
  shiftsUnion,
  staffShift,
  summariseCoverage,
  type Range,
} from '@/lib/coverage';
import { DAYS, label12 } from '@/components/WeeklyHoursGrid';

const SLOT = 15; // coverage resolution, minutes
const SNAP = 15; // drag snap, minutes
const MIN_DUR = 30; // shortest shift, minutes
const PAD = 60; // axis padding around the busy window, minutes
const DEFAULT_AXIS: Range = { start: 6 * 60, end: 22 * 60 }; // 6a–10p fallback

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const snap = (n: number) => Math.round(n / SNAP) * SNAP;

/** "9–5" style compact range label for chips. */
function rangeLabel(r: Range): string {
  return `${label12(fromMinutes(r.start))} – ${label12(fromMinutes(r.end))}`;
}

type DraftMap = Record<string, StaffSchedule>;

/**
 * Interactive weekly scheduling board. A compact week strip surfaces which days
 * run thin; selecting a day opens a lane-per-person editor where shift bars are
 * dragged (edges resize, body moves) and saved per person. A coverage ribbon
 * and summary keep the owner aware of staffing through open hours — purely
 * informational, nothing is blocked.
 */
export function StaffTimeline({ staff }: { staff: Staff[] }) {
  const settings = useTenantSettings();
  const { can } = usePermissions();
  const canEdit = can('staff:update');

  const openingHours: StaffSchedule = settings.data?.preferences?.openingHours ?? {};
  const comfort = settings.data?.preferences?.comfortCoverage ?? 2;

  // Local optimistic copy of every active person's schedule so dragging updates
  // coverage live; each lane persists its own row on drag-end.
  const [draft, setDraft] = useState<DraftMap>({});
  const draggingRef = useRef(false);

  const serverSig = useMemo(
    () => staff.map((s) => `${s.id}:${JSON.stringify(s.schedule ?? {})}`).join('|'),
    [staff],
  );
  useEffect(() => {
    if (draggingRef.current) return; // don't clobber an in-flight drag
    const next: DraftMap = {};
    for (const s of staff) next[s.id] = s.schedule ?? {};
    setDraft(next);
  }, [serverSig, staff]);

  const [day, setDay] = useState<string>(() => String(new Date().getDay()));

  // Staff with their live (draft) schedules, for coverage maths.
  const liveStaff = useMemo(
    () => staff.map((s) => ({ ...s, schedule: draft[s.id] ?? s.schedule ?? {} })),
    [staff, draft],
  );

  // Per-day stats for the week strip.
  const weekStats = useMemo(
    () =>
      DAYS.map((d) => {
        const counts = coverageForDay(liveStaff, d.key, SLOT);
        const open = dayOpenRange(openingHours, d.key);
        const evalWindow = open ?? shiftsUnion(liveStaff, d.key);
        const summary = summariseCoverage(counts, SLOT, evalWindow, comfort);
        const working = liveStaff.filter((s) => staffShift(s, d.key)).length;
        return { ...d, counts, open, summary, working };
      }),
    [liveStaff, openingHours, comfort],
  );

  const sel = weekStats.find((d) => d.key === day) ?? weekStats[0];

  // Axis spans the open window + any shifts, padded, snapped to whole hours.
  const axis = useMemo<Range>(() => {
    const union = shiftsUnion(liveStaff, day);
    const lo: number[] = [];
    const hi: number[] = [];
    if (sel?.open) {
      lo.push(sel.open.start);
      hi.push(sel.open.end);
    }
    if (union) {
      lo.push(union.start);
      hi.push(union.end);
    }
    if (!lo.length) return DEFAULT_AXIS;
    let start = Math.min(...lo) - PAD;
    let end = Math.max(...hi) + PAD;
    start = clamp(Math.floor(start / 60) * 60, 0, 24 * 60);
    end = clamp(Math.ceil(end / 60) * 60, 0, 24 * 60);
    if (end - start < 6 * 60) end = clamp(start + 6 * 60, 0, 24 * 60); // keep readable
    return { start, end };
  }, [liveStaff, day, sel?.open]);

  const span = axis.end - axis.start;
  const pct = (m: number) => `${((clamp(m, axis.start, axis.end) - axis.start) / span) * 100}%`;

  const ticks = useMemo(() => {
    const out: number[] = [];
    const step = span > 14 * 60 ? 180 : 120; // 3h for long days, else 2h
    for (let m = Math.ceil(axis.start / step) * step; m <= axis.end; m += step) out.push(m);
    return out;
  }, [axis, span]);

  const setDaySchedule = (staffId: string, next: StaffSchedule) =>
    setDraft((prev) => ({ ...prev, [staffId]: next }));

  if (settings.isPending) return null;

  if (staff.length === 0) {
    return (
      <div className="panel staff-empty">
        <Users size={28} strokeWidth={1.5} />
        <h3>No active staff</h3>
        <p>Add team members and set their shifts to see the weekly timeline.</p>
      </div>
    );
  }

  const peakColor = sel && sel.summary.window ? sel.summary : null;

  return (
    <div className="tl">
      {/* Week strip ------------------------------------------------------- */}
      <div className="tl-week" role="tablist" aria-label="Day of week">
        {weekStats.map((d) => {
          const closed = !d.open;
          const thin = d.summary.window && d.summary.low < comfort;
          const status = closed ? 'closed' : thin ? 'thin' : 'ok';
          return (
            <button
              key={d.key}
              role="tab"
              aria-selected={d.key === day}
              className={`tl-day ${d.key === day ? 'sel' : ''}`}
              onClick={() => setDay(d.key)}
            >
              <span className="tl-day__name">{d.short}</span>
              <span className="tl-day__count">{d.working || '—'}</span>
              <span className={`tl-day__dot tl-day__dot--${status}`} aria-hidden="true" />
              <span className="tl-day__bar" aria-hidden="true">
                {d.open &&
                  runsWithin(d.counts, SLOT, d.open).map((run, i) => {
                    const level = run.count === 0 ? 'gap' : run.count < comfort ? 'thin' : 'ok';
                    const w = ((run.end - run.start) / (d.open!.end - d.open!.start)) * 100;
                    return (
                      <span
                        key={i}
                        className={`tl-day__seg tl-day__seg--${level}`}
                        style={{ width: `${w}%` }}
                      />
                    );
                  })}
              </span>
            </button>
          );
        })}
      </div>

      {/* Summary chips ---------------------------------------------------- */}
      {sel && (
        <div className="tl-summary">
          <span className="tl-chip">
            <Clock size={13} strokeWidth={1.7} />
            {sel.open ? `Open ${rangeLabel(sel.open)}` : 'Closed — no open hours set'}
          </span>
          {peakColor && (
            <>
              <span className="tl-chip">
                <TrendingUp size={13} strokeWidth={1.7} />
                Peak {sel.summary.peak}
              </span>
              <span className="tl-chip">
                <Users size={13} strokeWidth={1.7} />
                Lowest {sel.summary.low}
                {sel.summary.lowWindow ? ` · ${rangeLabel(sel.summary.lowWindow)}` : ''}
              </span>
              {(() => {
                const gap = sel.summary.gaps[0];
                const thin = sel.summary.thin[0];
                const first = gap ?? thin;
                if (!first) return null;
                return (
                  <span className="tl-chip tl-chip--warn" title="Hours below your comfort level">
                    <AlertTriangle size={13} strokeWidth={1.7} />
                    {gap ? `${rangeLabel(gap)} uncovered` : `${rangeLabel(first)} thin`}
                    {sel.summary.thin.length > 1 ? ` +${sel.summary.thin.length - 1}` : ''}
                  </span>
                );
              })()}
            </>
          )}
        </div>
      )}

      {/* Day editor ------------------------------------------------------- */}
      <div className="tl-board panel">
        {/* axis ticks */}
        <div className="tl-row tl-axis">
          <div className="tl-gutter" />
          <div className="tl-track">
            {ticks.map((t) => (
              <span key={t} className="tl-tick" style={{ left: pct(t) }}>
                {label12(fromMinutes(t))}
              </span>
            ))}
          </div>
        </div>

        {/* lanes */}
        <div className="tl-lanes">
          {liveStaff.map((s) => (
            <TimelineLane
              key={s.id}
              staff={s}
              dayKey={day}
              schedule={draft[s.id] ?? s.schedule ?? {}}
              serverSchedule={s.schedule ?? {}}
              axis={axis}
              openRange={sel?.open ?? null}
              canEdit={canEdit}
              pct={pct}
              onChange={setDaySchedule}
              onDraggingChange={(v) => (draggingRef.current = v)}
            />
          ))}
        </div>

        {/* coverage ribbon */}
        {sel && (
          <div className="tl-row tl-ribbon">
            <div className="tl-gutter tl-ribbon__label">coverage</div>
            <div className="tl-track">
              {sel.open && (
                <div
                  className="tl-openband"
                  style={{ left: pct(sel.open.start), width: `calc(${pct(sel.open.end)} - ${pct(sel.open.start)})` }}
                />
              )}
              {runsWithin(sel.counts, SLOT, axis).map((run, i) => {
                const level = run.count === 0 ? 'gap' : run.count < comfort ? 'thin' : 'ok';
                const h = sel.summary.peak > 0 ? (run.count / sel.summary.peak) * 100 : 0;
                return (
                  <div
                    key={i}
                    className={`tl-cov tl-cov--${level}`}
                    style={{
                      left: pct(run.start),
                      width: `calc(${pct(run.end)} - ${pct(run.start)})`,
                      height: `${Math.max(run.count === 0 ? 0 : 8, h)}%`,
                    }}
                    title={`${run.count} on shift · ${rangeLabel(run)}`}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// =========================================================================
// One staff lane — owns its drag + persistence for the selected day.
// =========================================================================

type DragState = {
  mode: 'move' | 'start' | 'end';
  startX: number;
  width: number;
  init: Range;
  latest: Range;
};

function TimelineLane({
  staff,
  dayKey,
  schedule,
  serverSchedule,
  axis,
  openRange,
  canEdit,
  pct,
  onChange,
  onDraggingChange,
}: {
  staff: Staff;
  dayKey: string;
  schedule: StaffSchedule;
  serverSchedule: StaffSchedule;
  axis: Range;
  openRange: Range | null;
  canEdit: boolean;
  pct: (m: number) => string;
  onChange: (staffId: string, next: StaffSchedule) => void;
  onDraggingChange: (v: boolean) => void;
}) {
  const update = useUpdateStaff(staff.id);
  const barRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);

  const range = staffShift({ schedule }, dayKey);
  const span = axis.end - axis.start;

  const initials =
    staff.full_name
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase() || '?';

  const persist = async (next: StaffSchedule) => {
    try {
      await update.mutateAsync({ schedule: next });
    } catch (err) {
      onChange(staff.id, serverSchedule); // revert optimistic edit
      toast.error('Could not save shift', (err as { message?: string }).message ?? 'Please try again.');
    }
  };

  const writeRange = (r: Range | null) => {
    const next = { ...schedule };
    if (r) next[dayKey] = { start: fromMinutes(r.start), end: fromMinutes(r.end) };
    else delete next[dayKey];
    return next;
  };

  const beginDrag = (mode: DragState['mode'], e: React.PointerEvent) => {
    if (!canEdit || !range || !barRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const width = barRef.current.parentElement!.getBoundingClientRect().width;
    barRef.current.setPointerCapture(e.pointerId);
    dragRef.current = { mode, startX: e.clientX, width, init: { ...range }, latest: { ...range } };
    setDragging(true);
    onDraggingChange(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dxMin = (((e.clientX - d.startX) / d.width) * span) || 0;
    let start = d.init.start;
    let end = d.init.end;
    if (d.mode === 'move') {
      const dur = end - start;
      start = clamp(snap(d.init.start + dxMin), axis.start, axis.end - dur);
      end = start + dur;
    } else if (d.mode === 'start') {
      start = clamp(snap(d.init.start + dxMin), axis.start, end - MIN_DUR);
    } else {
      end = clamp(snap(d.init.end + dxMin), start + MIN_DUR, axis.end);
    }
    d.latest = { start, end };
    onChange(staff.id, writeRange({ start, end }));
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    setDragging(false);
    onDraggingChange(false);
    try {
      barRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* capture already released */
    }
    void persist(writeRange(d.latest));
  };

  const addShift = () => {
    if (!canEdit) return;
    const seed = openRange ?? { start: 9 * 60, end: 17 * 60 };
    const start = clamp(seed.start, axis.start, axis.end - MIN_DUR);
    const end = clamp(seed.end, start + MIN_DUR, axis.end);
    const next = writeRange({ start, end });
    onChange(staff.id, next);
    void persist(next);
  };

  const removeShift = () => {
    if (!canEdit) return;
    const next = writeRange(null);
    onChange(staff.id, next);
    void persist(next);
  };

  return (
    <div className={`tl-lane ${range ? 'on' : 'off'}`}>
      <div className="tl-gutter tl-lane__who">
        <span className="tl-lane__avatar">{initials}</span>
        <span className="tl-lane__name" title={staff.full_name}>
          {staff.full_name}
        </span>
        {update.isPending && <Loader2 size={12} className="spin tl-lane__saving" />}
      </div>
      <div className="tl-track tl-lane__track">
        {openRange && (
          <div
            className="tl-openband"
            style={{ left: pct(openRange.start), width: `calc(${pct(openRange.end)} - ${pct(openRange.start)})` }}
            aria-hidden="true"
          />
        )}
        {range ? (
          <div
            ref={barRef}
            className={`tl-bar ${dragging ? 'dragging' : ''} ${canEdit ? '' : 'locked'}`}
            style={{ left: pct(range.start), width: `calc(${pct(range.end)} - ${pct(range.start)})` }}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            {canEdit && (
              <span
                className="tl-bar__handle tl-bar__handle--l"
                onPointerDown={(e) => beginDrag('start', e)}
                aria-hidden="true"
              />
            )}
            <span
              className="tl-bar__body"
              onPointerDown={(e) => canEdit && beginDrag('move', e)}
            >
              <span className="tl-bar__label">{rangeLabel(range)}</span>
            </span>
            {canEdit && (
              <span
                className="tl-bar__handle tl-bar__handle--r"
                onPointerDown={(e) => beginDrag('end', e)}
                aria-hidden="true"
              />
            )}
            {canEdit && (
              <button className="tl-bar__x" onClick={removeShift} title="Remove shift" aria-label="Remove shift">
                <X size={11} strokeWidth={2.2} />
              </button>
            )}
          </div>
        ) : canEdit ? (
          <button className="tl-add" onClick={addShift}>
            <Plus size={13} strokeWidth={2} /> shift
          </button>
        ) : (
          <span className="tl-lane__rest">off</span>
        )}
      </div>
    </div>
  );
}
