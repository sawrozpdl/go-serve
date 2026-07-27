import { useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Clock } from 'lucide-react';

import { usePopover } from './usePopover';

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

/** Matches `.tp-pop { width }` in admin.css. */
const POP_WIDTH = 168;

/** Time picker that mirrors the DatePicker's look — a trigger button plus a
 *  popover. The body is a single scrollable list of slots so selecting a time
 *  is one click rather than a native spinner. */
export function TimePicker({ value, onChange, placeholder = 'pick a time', step = 15 }: Props) {
  // Portalled to <body> for the same reason as DatePicker — see usePopover.
  const pop = usePopover<HTMLButtonElement, HTMLDivElement>({ width: POP_WIDTH });
  const { open, close } = pop;
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

  // Land near the current value so the user isn't dropped at midnight.
  // Deliberately NOT scrollIntoView: the popover is `position: fixed` in a
  // portal, so scrollIntoView would also scroll whichever ancestor scroller the
  // trigger lives in (`.modal-body`, `.rb-rail`, the page body) and drag the
  // trigger out from under the popover. Setting scrollTop moves only the list.
  useLayoutEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const target =
      list.querySelector<HTMLElement>('.tp-opt.sel') ??
      list.querySelector<HTMLElement>('[data-near="1"]');
    if (!target) return;
    list.scrollTop = target.offsetTop - list.clientHeight / 2 + target.offsetHeight / 2;
  }, [open]);

  const display = value ? label12(value) : placeholder;

  return (
    <div className="tp">
      <button
        ref={pop.triggerRef}
        type="button"
        className={`tp-trigger ${value ? '' : 'empty'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={pop.toggle}
      >
        <Clock size={14} strokeWidth={1.5} />
        <span>{display}</span>
      </button>

      {open &&
        createPortal(
          <div ref={pop.popRef} className="tp-pop" role="dialog" style={pop.style}>
            <div className="tp-list" ref={listRef}>
              {options.map((o) => (
                <button
                  type="button"
                  key={o}
                  className={`tp-opt ${o === value ? 'sel' : ''}`}
                  data-near={o === nearest ? '1' : undefined}
                  onClick={() => {
                    onChange(o);
                    close();
                  }}
                >
                  {label12(o)}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
