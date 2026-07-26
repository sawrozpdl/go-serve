// Preview zoom.
//
// The sheets are sized in real millimetres, so at 100% an A4 page is ~794 CSS px
// wide and simply does not fit beside a composer rail on a laptop. The old code
// handled that with a hardcoded `transform: scale(0.82)` under 1400px, which had
// two problems: the factor was a guess unrelated to the actual pane width, and a
// transform does not resize the layout box — so the scroll container measured the
// unscaled size and the scrollbars were wrong.
//
// Zoom is applied as the CSS `zoom` property on a wrapper OUTSIDE the `.rpt`
// element (see ReportBuilderPage). Two reasons that matters:
//   - `zoom` participates in layout, so the scroll container's dimensions are
//     correct and one preview sheet still equals one printed page.
//   - printReport() clones `.rpt` and serializes its outerHTML, so anything set
//     on `.rpt` itself would follow the document into the print iframe and shrink
//     the actual PDF. The wrapper is not cloned.

/** Millimetres per CSS inch / inch, i.e. px per mm at 96dpi. */
const PX_PER_MM = 96 / 25.4;

/** The zoom stops, as fractions. Coarse on purpose — a continuous slider invites
 *  fiddling, and these cover "read the text" through "see the whole page". */
export const ZOOM_STEPS = [0.5, 0.65, 0.8, 1, 1.25, 1.5] as const;

export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

/** Clamp to the supported range. Non-finite input falls back to 1 rather than
 *  poisoning the CSS with NaN, which would silently blank the preview. */
export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** The next stop up (or down) from the current zoom.
 *
 *  Works off the current value rather than an index, so a "fit" zoom — which is
 *  an arbitrary fraction, not one of the stops — still steps sensibly to the next
 *  stop above or below it. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const z = clampZoom(current);
  if (direction === 1) {
    const next = ZOOM_STEPS.find((s) => s > z + 1e-6);
    return next ?? MAX_ZOOM;
  }
  const prev = [...ZOOM_STEPS].reverse().find((s) => s < z - 1e-6);
  return prev ?? MIN_ZOOM;
}

/** The zoom at which one sheet fills the available width.
 *
 *  `availablePx` should already have the gutter subtracted. Returns a clamped
 *  fraction; a zero/negative container (an unmounted or hidden pane) yields
 *  MIN_ZOOM rather than 0 or Infinity. */
export function fitZoom(availablePx: number, sheetWidthMm: number): number {
  if (!Number.isFinite(availablePx) || availablePx <= 0) return MIN_ZOOM;
  if (!Number.isFinite(sheetWidthMm) || sheetWidthMm <= 0) return MIN_ZOOM;
  return clampZoom(availablePx / (sheetWidthMm * PX_PER_MM));
}

/** For the button label: 0.8 → "80%". */
export function zoomLabel(z: number): string {
  return `${Math.round(clampZoom(z) * 100)}%`;
}
