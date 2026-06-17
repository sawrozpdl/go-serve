import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { Link } from 'react-router-dom';

import { explainerById } from '@/guide/explainers';

type Props = {
  /** Ad-hoc explanation. Optional when `topic` supplies the text. */
  children?: React.ReactNode;
  /**
   * Pull the explanation from the shared metric registry by id, and add a
   * "Learn more →" deep link to the matching guide section. `children`, if
   * given, overrides the registry's short text.
   */
  topic?: string;
  /** Accessible label for the trigger. Defaults to "What is this?". */
  label?: string;
  /** Icon size in px. Defaults to 13 to sit unobtrusively in headings. */
  size?: number;
};

/**
 * A tiny "what is this?" affordance: an Info icon that reveals a short
 * explanation. Opens on hover/focus for a quick peek and toggles (pins) on
 * click for touch devices. Closes on Escape or click-outside. No third-party
 * popover lib — mirrors the hand-rolled pattern in DatePicker.tsx.
 *
 * Pass `topic` to source the copy from the single metric registry
 * (guide/explainers.tsx) and surface a deep link into GoServe Training.
 */
export function InfoHint({ children, topic, label = 'What is this?', size = 13 }: Props) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [side, setSide] = useState<'left' | 'right'>('left');
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setPinned(false);
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPinned(false);
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [pinned]);

  // Flip to right-anchor when there isn't room for the bubble on the right.
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const BUBBLE = 240;
    const rect = wrapRef.current.getBoundingClientRect();
    setSide(window.innerWidth - rect.left < BUBBLE + 16 ? 'right' : 'left');
  }, [open]);

  const show = open || pinned;
  const explainer = topic ? explainerById[topic] : undefined;
  const content = children ?? explainer?.short ?? null;

  return (
    <span
      className="info-hint"
      ref={wrapRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="info-hint__trigger"
        aria-label={label}
        aria-expanded={show}
        onClick={() => {
          setPinned((p) => !p);
          setOpen((o) => !o);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => !pinned && setOpen(false)}
      >
        <Info size={size} strokeWidth={1.7} aria-hidden />
      </button>
      {show && (
        <span
          className="info-hint__bubble"
          role="tooltip"
          style={side === 'right' ? { left: 'auto', right: 0 } : undefined}
        >
          {content}
          {explainer && (
            <Link
              className="info-hint__more"
              to={`/admin/guide#${explainer.anchor}`}
              onClick={() => {
                setPinned(false);
                setOpen(false);
              }}
            >
              Learn more →
            </Link>
          )}
        </span>
      )}
    </span>
  );
}
