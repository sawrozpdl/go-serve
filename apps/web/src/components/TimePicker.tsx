import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Clock } from 'lucide-react';

type Props = {
  /** "HH:MM" in 24-hour form, or '' when no time is picked. */
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Minute granularity of the option list. Default 15. */
  step?: number;
};

/** Format an "HH:MM" 24h string the way the rest of the app shows times
 *  (e.g. "2:30 PM"), honouring the user's locale. */
function label12(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function toMinutes(hhmm: string): number {
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** Time picker that mirrors the DatePicker's look — a trigger button plus a
 *  popover. The body is a single scrollable list of slots so selecting a time
 *  is one click rather than a native spinner. */
export function TimePicker({ value, onChange, placeholder = 'pick a time', step = 15 }: Props) {
  const [open, setOpen] = useState(false);
  const [anchorSide, setAnchorSide] = useState<'left' | 'right'>('left');
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const options = useMemo(() => {
    const out: string[] = [];
    for (let mins = 0; mins < 24 * 60; mins += step) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      out.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
    return out;
  }, [step]);

  // The slot closest to the current value — used to land the scroll position
  // near the relevant time, including when the value is off the step grid.
  const nearest = useMemo(() => {
    if (!value) return '';
    const target = toMinutes(value);
    let best = options[0];
    let bestDiff = Infinity;
    for (const o of options) {
      const diff = Math.abs(toMinutes(o) - target);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = o;
      }
    }
    return best;
  }, [value, options]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    // Flip to right-anchor when there isn't room on the right — keeps the
    // popover inside a narrow modal column instead of bleeding past it.
    const POP_WIDTH = 168;
    const triggerRect = wrapRef.current.getBoundingClientRect();
    const scroller =
      wrapRef.current.closest<HTMLElement>('.modal-body') ?? document.documentElement;
    const scrollerRect = scroller.getBoundingClientRect();
    const rightSpace = scrollerRect.right - triggerRect.left;
    setAnchorSide(rightSpace < POP_WIDTH + 8 ? 'right' : 'left');
    // Land near the current value so the user isn't dropped at midnight.
    const target =
      listRef.current?.querySelector<HTMLElement>('.tp-opt.sel') ??
      listRef.current?.querySelector<HTMLElement>('[data-near="1"]');
    target?.scrollIntoView({ block: 'center' });
  }, [open]);

  const display = value ? label12(value) : placeholder;

  return (
    <div className="tp" ref={wrapRef}>
      <button
        type="button"
        className={`tp-trigger ${value ? '' : 'empty'}`}
        onClick={() => setOpen((o) => !o)}
      >
        <Clock size={14} strokeWidth={1.5} />
        <span>{display}</span>
      </button>

      {open && (
        <div
          className="tp-pop"
          role="dialog"
          style={anchorSide === 'right' ? { left: 'auto', right: 0 } : undefined}
        >
          <div className="tp-list" ref={listRef}>
            {options.map((o) => (
              <button
                type="button"
                key={o}
                className={`tp-opt ${o === value ? 'sel' : ''}`}
                data-near={o === nearest ? '1' : undefined}
                onClick={() => {
                  onChange(o);
                  setOpen(false);
                }}
              >
                {label12(o)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
