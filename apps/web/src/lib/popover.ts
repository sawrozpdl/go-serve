/* Popover placement — the geometry behind every trigger-anchored dropdown
 * (DatePicker, TimePicker, SearchSelect).
 *
 * These popovers are portalled to <body> and positioned `fixed`, because the
 * app is full of scroll containers that would otherwise clip an absolutely
 * positioned child: `.page-shell--fill .page-shell__body` and `.rb-group` are
 * `overflow: hidden`, `.rb-rail` and `.modal-body` are `auto`. A calendar
 * opened in the report builder's rail used to be cut off entirely.
 *
 * Kept as a pure function of rects so the flip/clamp rules can be tested
 * without a DOM. Coordinates are viewport-relative, i.e. ready for
 * `position: fixed`.
 */

export type Rect = { top: number; left: number; bottom: number; right: number; width: number };

export type Viewport = { width: number; height: number };

export type PopoverSize = { width: number; height: number };

export type PopoverPlacement = {
  top: number;
  left: number;
  /** Set only when `matchWidth` is requested — the trigger's own width. */
  width?: number;
  /** Which side of the trigger the popover ended up on, for callers that
   *  want to style a caret or animate from the right edge. */
  placement: 'below' | 'above';
};

export type PlaceOptions = {
  /** Minimum breathing room between the popover and the viewport edge. */
  margin?: number;
  /** Space between the trigger and the popover. */
  gap?: number;
  /** Pin the popover to the trigger's width (select-style dropdowns). */
  matchWidth?: boolean;
};

/**
 * Place a popover against its trigger: below by default, flipped above when it
 * would overflow the bottom and there is genuinely more room up there, always
 * clamped inside the viewport.
 *
 * When the popover is taller than the viewport, neither side fits — we pin it
 * to the top margin and let it scroll internally rather than flip pointlessly.
 */
export function placePopover(
  trigger: Rect,
  pop: PopoverSize,
  viewport: Viewport,
  opts: PlaceOptions = {},
): PopoverPlacement {
  const margin = opts.margin ?? 8;
  const gap = opts.gap ?? 4;

  const width = opts.matchWidth ? trigger.width : pop.width;

  // Horizontal: left-align with the trigger, then pull back so the right edge
  // stays inside the viewport. The max() runs last so a popover wider than the
  // viewport still starts at the margin instead of going negative.
  let left = trigger.left;
  const rightLimit = viewport.width - width - margin;
  if (left > rightLimit) left = rightLimit;
  if (left < margin) left = margin;

  // Vertical: below unless that overflows and above has more usable room.
  const below = trigger.bottom + gap;
  const roomBelow = viewport.height - margin - below;
  const roomAbove = trigger.top - gap - margin;

  let placement: PopoverPlacement['placement'] = 'below';
  let top = below;
  if (pop.height > roomBelow && roomAbove > roomBelow) {
    placement = 'above';
    top = trigger.top - gap - pop.height;
  }

  // Then keep the whole thing on screen. When neither side has room — a 256px
  // time list under a trigger 200px from the fold — picking the roomier side
  // isn't enough on its own: without this the popover just hung off the bottom
  // and its last options were unreachable. Pulling it up can overlap the
  // trigger, which is the lesser evil.
  const maxTop = viewport.height - margin - pop.height;
  if (top > maxTop) top = maxTop;
  // Never start above the top margin — a popover taller than the viewport gets
  // pinned here and scrolls internally instead of hanging off the top.
  if (top < margin) top = margin;

  return opts.matchWidth ? { top, left, width, placement } : { top, left, placement };
}

/** Narrow a DOMRect to the fields `placePopover` needs. */
export function toRect(r: DOMRect): Rect {
  return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, width: r.width };
}
