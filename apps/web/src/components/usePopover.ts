/* usePopover — open/close + placement for a trigger-anchored dropdown that is
 * portalled to <body>.
 *
 * Every picker in the app used to render its popover as an absolutely
 * positioned child of its trigger, which meant any ancestor scroll container
 * clipped it. The report builder has three of them stacked
 * (`.page-shell--fill .page-shell__body`, `.rb-rail`, `.rb-group`), so the
 * calendar was cut off entirely and no date could be picked.
 *
 * The pattern here is the one InfoHint already uses for its bubble: portal to
 * body, position `fixed` from the trigger's rect, and recompute on
 * capture-phase scroll + resize so the popover tracks the trigger while an
 * ancestor scrolls.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { placePopover, toRect, type PlaceOptions, type PopoverPlacement } from '@/lib/popover';

type Options = PlaceOptions & {
  /** Measured popover width, used before the node exists to place it. */
  width: number;
  /** Called after the popover closes for any reason. */
  onClose?: () => void;
};

export type PopoverApi<T extends HTMLElement, P extends HTMLElement> = {
  open: boolean;
  setOpen: (next: boolean) => void;
  toggle: () => void;
  close: () => void;
  triggerRef: React.RefObject<T>;
  popRef: React.RefObject<P>;
  /** Spread onto the portalled popover element. */
  style: React.CSSProperties;
  placement: PopoverPlacement['placement'];
};

export function usePopover<T extends HTMLElement, P extends HTMLElement>(
  opts: Options,
): PopoverApi<T, P> {
  // Destructured to primitives rather than kept as an options object: the
  // placement effect below depends on these, and an object literal from the
  // caller would be a new reference every render.
  const { width, onClose, margin, gap, matchWidth } = opts;
  const [open, setOpenState] = useState(false);
  const [pos, setPos] = useState<PopoverPlacement | null>(null);
  const triggerRef = useRef<T>(null);
  const popRef = useRef<P>(null);

  const close = useCallback(() => {
    setOpenState(false);
    setPos(null);
    onClose?.();
  }, [onClose]);

  const setOpen = useCallback(
    (next: boolean) => {
      if (next) setOpenState(true);
      else close();
    },
    [close],
  );

  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);

  // Position from the trigger's rect, clamped to the viewport. Measure the
  // popover's real height once it's mounted so the flip-above decision uses the
  // actual size rather than a guess.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const recompute = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const height = popRef.current?.offsetHeight ?? 0;
      setPos(
        placePopover(
          toRect(trigger.getBoundingClientRect()),
          { width, height },
          { width: window.innerWidth, height: window.innerHeight },
          { margin, gap, matchWidth },
        ),
      );
    };
    recompute();
    // Capture phase: the scroller is an ancestor, and scroll doesn't bubble.
    window.addEventListener('scroll', recompute, true);
    window.addEventListener('resize', recompute);
    return () => {
      window.removeEventListener('scroll', recompute, true);
      window.removeEventListener('resize', recompute);
    };
  }, [open, width, margin, gap, matchWidth]);

  // Outside click has to test the popover too — it's portalled to body, so it is
  // no longer a descendant of the trigger wrapper.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        triggerRef.current?.focus();
      }
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, close]);

  // Park it off-screen for the first paint, before the height is known —
  // otherwise a popover that needs to flip visibly jumps.
  const style: React.CSSProperties = pos
    ? { top: pos.top, left: pos.left, ...(pos.width != null ? { width: pos.width } : null) }
    : { top: -9999, left: -9999, visibility: 'hidden' };

  return {
    open,
    setOpen,
    toggle,
    close,
    triggerRef,
    popRef,
    style,
    placement: pos?.placement ?? 'below',
  };
}
