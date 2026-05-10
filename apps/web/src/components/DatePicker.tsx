import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';

type Props = {
  /** ISO date string (YYYY-MM-DD) or empty when no date is picked. */
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Hard min/max — clamps the visible calendar and disables out-of-range cells. */
  min?: string;
  max?: string;
  /** Quick-pick chips above the grid. Each maps to an ISO date. */
  presets?: { label: string; value: string }[];
};

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function toIso(d: Date): string {
  // Format in local time so a date picked at 23:00 in NPT still maps to
  // the calendar day the user clicked. Avoids the off-by-one trap.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseIso(s: string): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

export function DatePicker({ value, onChange, placeholder = 'pick a date', min, max, presets }: Props) {
  const [open, setOpen] = useState(false);
  const [anchorSide, setAnchorSide] = useState<'left' | 'right'>('left');
  const wrapRef = useRef<HTMLDivElement>(null);

  // Anchor the visible month — defaults to the currently selected date or
  // today. Doesn't change as the user types, only on chevron clicks.
  const initialAnchor = parseIso(value) ?? new Date();
  const [anchor, setAnchor] = useState<Date>(
    new Date(initialAnchor.getFullYear(), initialAnchor.getMonth(), 1),
  );

  useEffect(() => {
    if (!open) return;
    // Re-anchor on open so the calendar always lands on the relevant
    // month even if the user changed value via a preset between opens.
    const v = parseIso(value);
    if (v) setAnchor(new Date(v.getFullYear(), v.getMonth(), 1));
  }, [open, value]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  // Flip the popover to right-anchor when there isn't enough room on the
  // right of the trigger — keeps it inside a narrow modal column instead
  // of bleeding past the modal-body's content area.
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const POP_WIDTH = 290;
    const triggerRect = wrapRef.current.getBoundingClientRect();
    const scroller =
      wrapRef.current.closest<HTMLElement>('.modal-body') ?? document.documentElement;
    const scrollerRect = scroller.getBoundingClientRect();
    const rightSpace = scrollerRect.right - triggerRect.left;
    setAnchorSide(rightSpace < POP_WIDTH + 8 ? 'right' : 'left');
  }, [open]);

  const cells = useMemo(() => buildMonth(anchor), [anchor]);
  const minD = parseIso(min ?? '');
  const maxD = parseIso(max ?? '');
  const selected = parseIso(value);
  const today = toIso(new Date());

  const display = selected
    ? selected.toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : placeholder;

  const monthLabel = anchor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const stepMonth = (delta: number) => {
    setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1));
  };

  return (
    <div className="dp" ref={wrapRef}>
      <button
        type="button"
        className={`dp-trigger ${selected ? '' : 'empty'}`}
        onClick={() => setOpen((o) => !o)}
      >
        <Calendar size={14} strokeWidth={1.5} />
        <span>{display}</span>
      </button>

      {open && (
        <div
          className="dp-pop"
          role="dialog"
          style={anchorSide === 'right' ? { left: 'auto', right: 0 } : undefined}
        >
          {presets && presets.length > 0 && (
            <div className="dp-presets">
              {presets.map((p) => (
                <button
                  type="button"
                  key={p.value}
                  className={`chip ${value === p.value ? 'active' : ''}`}
                  onClick={() => {
                    onChange(p.value);
                    setOpen(false);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}

          <div className="dp-head">
            <button type="button" className="btn icon" onClick={() => stepMonth(-1)} aria-label="prev">
              <ChevronLeft size={14} strokeWidth={1.5} />
            </button>
            <span className="dp-month">{monthLabel}</span>
            <button type="button" className="btn icon" onClick={() => stepMonth(1)} aria-label="next">
              <ChevronRight size={14} strokeWidth={1.5} />
            </button>
          </div>

          <div className="dp-grid">
            {WEEKDAYS.map((w) => (
              <span key={w} className="dp-wd">
                {w}
              </span>
            ))}
            {cells.map((d, i) => {
              const iso = toIso(d);
              const isCurrentMonth = d.getMonth() === anchor.getMonth();
              const isSelected = iso === value;
              const isToday = iso === today;
              const outOfRange = (minD && d < minD) || (maxD && d > maxD);
              return (
                <button
                  type="button"
                  key={i}
                  className={[
                    'dp-cell',
                    isCurrentMonth ? '' : 'muted',
                    isSelected ? 'sel' : '',
                    isToday && !isSelected ? 'today' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  disabled={!!outOfRange}
                  onClick={() => {
                    onChange(iso);
                    setOpen(false);
                  }}
                >
                  {d.getDate()}
                </button>
              );
            })}
          </div>

          <div className="dp-foot">
            <button
              type="button"
              className="btn"
              onClick={() => {
                onChange(today);
                setOpen(false);
              }}
            >
              Today
            </button>
            {value && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  onChange('');
                  setOpen(false);
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Build a 6×7 grid of dates, leading with the Monday of the week
 * containing day 1 of `anchor`. Trailing cells spill into the next
 * month so the grid height never jumps between months. */
function buildMonth(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const dow = (first.getDay() + 6) % 7; // shift Sun=0 → Mon=0
  const start = new Date(first);
  start.setDate(1 - dow);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    cells.push(d);
  }
  return cells;
}
