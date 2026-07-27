import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';

import { usePopover } from './usePopover';

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
  /** Drop the weekday from the trigger label ("1 Jul 2026" rather than
   *  "Mon, 1 Jul 2026"). For narrow columns — two pickers side by side in the
   *  report builder's 290px rail can't fit the long form. */
  compact?: boolean;
};

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/** Matches `.dp-pop { width }` in admin.css — used to place the popover before
 *  it has been measured. */
const POP_WIDTH = 290;

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

export function DatePicker({
  value,
  onChange,
  placeholder = 'pick a date',
  min,
  max,
  presets,
  compact = false,
}: Props) {
  // The calendar is portalled to <body> and positioned fixed: every scroll
  // container it used to live inside (modal bodies, the report-builder rail,
  // `page-shell--fill` page bodies) clipped it.
  const pop = usePopover<HTMLButtonElement, HTMLDivElement>({ width: POP_WIDTH });
  const { open, close } = pop;

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

  const cells = useMemo(() => buildMonth(anchor), [anchor]);
  const minD = parseIso(min ?? '');
  const maxD = parseIso(max ?? '');
  const selected = parseIso(value);
  const today = toIso(new Date());

  const display = selected
    ? selected.toLocaleDateString('en-GB', {
        ...(compact ? null : { weekday: 'short' as const }),
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
    <div className="dp">
      <button
        ref={pop.triggerRef}
        type="button"
        className={`dp-trigger ${selected ? '' : 'empty'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={pop.toggle}
      >
        <Calendar size={14} strokeWidth={1.5} />
        <span>{display}</span>
      </button>

      {open &&
        createPortal(
          <div ref={pop.popRef} className="dp-pop" role="dialog" style={pop.style}>
            {presets && presets.length > 0 && (
              <div className="dp-presets">
                {presets.map((p) => (
                  <button
                    type="button"
                    key={p.value}
                    className={`chip ${value === p.value ? 'active' : ''}`}
                    onClick={() => {
                      onChange(p.value);
                      close();
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            <div className="dp-head">
              <button
                type="button"
                className="btn icon"
                onClick={() => stepMonth(-1)}
                aria-label="prev"
              >
                <ChevronLeft size={14} strokeWidth={1.5} />
              </button>
              <span className="dp-month">{monthLabel}</span>
              <button
                type="button"
                className="btn icon"
                onClick={() => stepMonth(1)}
                aria-label="next"
              >
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
                      close();
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
                  close();
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
                    close();
                  }}
                >
                  Clear
                </button>
              )}
            </div>
          </div>,
          document.body,
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
