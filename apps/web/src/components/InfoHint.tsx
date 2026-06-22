import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

// Phones get a tap-to-open bottom sheet instead of a tiny popover, so long
// copy is never clipped. Tracked reactively so rotating / resizing switches.
function useIsMobile(query = '(max-width: 640px)') {
  const [match, setMatch] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(query).matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatch(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return match;
}

/**
 * A tiny "what is this?" affordance: an Info icon that reveals a short
 * explanation.
 *
 * Desktop: hover/focus for a quick peek, click to pin. The bubble renders in a
 * portal with fixed, viewport-clamped coordinates, so no `overflow:hidden`
 * ancestor (panels, KPI cards) can ever clip it and it can't run off-screen.
 *
 * Mobile: tap opens a bottom sheet with the full text — no clipped popovers.
 *
 * Pass `topic` to source the copy from the single metric registry
 * (guide/explainers.tsx) and surface a deep link into GoServe Training.
 */
export function InfoHint({ children, topic, label = 'What is this?', size = 13 }: Props) {
  const [open, setOpen] = useState(false); // hover/focus peek (desktop)
  const [pinned, setPinned] = useState(false); // click-pinned (desktop)
  const [sheetOpen, setSheetOpen] = useState(false); // mobile bottom sheet
  const [pos, setPos] = useState<{ top: number; left: number; maxWidth: number } | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const isMobile = useIsMobile();
  const explainer = topic ? explainerById[topic] : undefined;
  const content = children ?? explainer?.short ?? null;
  const showPopover = !isMobile && (open || pinned);

  const cancelClose = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };
  useEffect(() => () => cancelClose(), []);

  // Pin (desktop): close on Escape or a click outside both the trigger and the
  // portaled bubble.
  useEffect(() => {
    if (!pinned) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || bubbleRef.current?.contains(target)) return;
      setPinned(false);
      setOpen(false);
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

  // Mobile sheet: Escape closes; lock background scroll while open.
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheetOpen(false);
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [sheetOpen]);

  // Position the desktop popover from the trigger rect, clamped to the viewport.
  // Recompute on scroll/resize so it tracks while open.
  useLayoutEffect(() => {
    if (!showPopover) {
      setPos(null);
      return;
    }
    const recompute = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const margin = 8;
      const maxWidth = Math.min(280, window.innerWidth - margin * 2);
      let left = Math.min(rect.left, window.innerWidth - maxWidth - margin);
      left = Math.max(margin, left);
      let top = rect.bottom + 6;
      // Flip above when the bubble would overflow the bottom of the viewport.
      const bubbleH = bubbleRef.current?.offsetHeight ?? 0;
      if (bubbleH && top + bubbleH > window.innerHeight - margin) {
        const above = rect.top - 6 - bubbleH;
        if (above >= margin) top = above;
      }
      setPos({ top, left, maxWidth });
    };
    recompute();
    window.addEventListener('scroll', recompute, true);
    window.addEventListener('resize', recompute);
    return () => {
      window.removeEventListener('scroll', recompute, true);
      window.removeEventListener('resize', recompute);
    };
  }, [showPopover, content]);

  const onTriggerClick = () => {
    if (isMobile) {
      setSheetOpen((s) => !s);
      return;
    }
    setPinned((p) => !p);
    setOpen((o) => !o);
  };

  const guideLink = explainer ? (
    <Link
      className="info-hint__more"
      to={`/admin/guide#${explainer.anchor}`}
      onClick={() => {
        setPinned(false);
        setOpen(false);
        setSheetOpen(false);
      }}
    >
      Learn more →
    </Link>
  ) : null;

  return (
    <span
      className="info-hint"
      onMouseEnter={() => {
        if (isMobile) return;
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={() => {
        if (!isMobile) scheduleClose();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="info-hint__trigger"
        aria-label={label}
        aria-expanded={showPopover || sheetOpen}
        aria-haspopup="dialog"
        onClick={onTriggerClick}
        onFocus={() => !isMobile && setOpen(true)}
        onBlur={() => !isMobile && !pinned && setOpen(false)}
      >
        <Info size={size} strokeWidth={1.7} aria-hidden />
      </button>

      {showPopover &&
        createPortal(
          <span
            ref={bubbleRef}
            className="info-hint__bubble"
            role="tooltip"
            style={{
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              maxWidth: pos?.maxWidth ?? 280,
            }}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
          >
            {content}
            {guideLink}
          </span>,
          document.body,
        )}

      {isMobile &&
        sheetOpen &&
        createPortal(
          <div className="info-sheet-scrim" onClick={() => setSheetOpen(false)}>
            <div
              className="info-sheet"
              role="dialog"
              aria-modal="true"
              aria-label={label}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="info-sheet__grip" aria-hidden />
              <div className="info-sheet__body">{content}</div>
              {guideLink}
              <button
                type="button"
                className="info-sheet__close"
                onClick={() => setSheetOpen(false)}
              >
                Got it
              </button>
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
