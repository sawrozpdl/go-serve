import { describe, expect, it } from 'vitest';

import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEPS,
  clampZoom,
  fitZoom,
  stepZoom,
  zoomLabel,
} from './zoom';

describe('clampZoom', () => {
  it('keeps values inside the supported range', () => {
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
  });

  it('falls back to 1 for every non-finite input', () => {
    // A NaN would reach the DOM as `zoom: NaN` and blank the preview, which reads
    // as "the builder is broken" rather than "a number was bad". The infinities
    // take the same path deliberately: they only arrive via an upstream bug, and
    // 100% is a recoverable default where 150% just looks broken too.
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(Infinity)).toBe(1);
    expect(clampZoom(-Infinity)).toBe(1);
  });
});

describe('stepZoom', () => {
  it('walks the stops in both directions', () => {
    expect(stepZoom(0.5, 1)).toBe(0.65);
    expect(stepZoom(0.65, 1)).toBe(0.8);
    expect(stepZoom(0.8, -1)).toBe(0.65);
    expect(stepZoom(1, -1)).toBe(0.8);
  });

  it('saturates at both ends instead of wrapping', () => {
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });

  it('steps sensibly from an off-stop value', () => {
    // "Fit" produces an arbitrary fraction, so stepping must work off the value
    // rather than an index into ZOOM_STEPS — otherwise the first click after Fit
    // jumps somewhere unrelated.
    expect(stepZoom(0.73, 1)).toBe(0.8);
    expect(stepZoom(0.73, -1)).toBe(0.65);
    expect(stepZoom(0.9, 1)).toBe(1);
    expect(stepZoom(0.9, -1)).toBe(0.8);
  });

  it('does not stall on a value equal to a stop', () => {
    // Float equality: 0.8 must step to 1, not back to itself.
    for (const s of ZOOM_STEPS) {
      if (s < MAX_ZOOM) expect(stepZoom(s, 1)).toBeGreaterThan(s);
      if (s > MIN_ZOOM) expect(stepZoom(s, -1)).toBeLessThan(s);
    }
  });
});

describe('fitZoom', () => {
  it('scales an A4 page to the pane width', () => {
    // A4 is 210mm ≈ 794px at 96dpi, so a 794px pane fits at ~100%.
    expect(fitZoom(794, 210)).toBeCloseTo(1, 2);
    // Half the width, half the zoom.
    expect(fitZoom(397, 210)).toBeCloseTo(0.5, 2);
  });

  it('clamps rather than returning an unusable zoom', () => {
    expect(fitZoom(80, 210)).toBe(MIN_ZOOM);
    expect(fitZoom(4000, 210)).toBe(MAX_ZOOM);
  });

  it('degrades safely for a container with no width', () => {
    // A hidden or not-yet-measured pane reports 0. Dividing by it would give
    // Infinity and a page scaled off the screen.
    expect(fitZoom(0, 210)).toBe(MIN_ZOOM);
    expect(fitZoom(-10, 210)).toBe(MIN_ZOOM);
    expect(fitZoom(NaN, 210)).toBe(MIN_ZOOM);
  });

  it('degrades safely for a zero-width sheet', () => {
    expect(fitZoom(800, 0)).toBe(MIN_ZOOM);
    expect(fitZoom(800, NaN)).toBe(MIN_ZOOM);
  });

  it('gives landscape a smaller fit than portrait in the same pane', () => {
    // Landscape A4 is 297mm wide, so it must fit at a lower zoom than 210mm.
    expect(fitZoom(900, 297)).toBeLessThan(fitZoom(900, 210));
  });
});

describe('zoomLabel', () => {
  it('renders whole percentages', () => {
    expect(zoomLabel(0.8)).toBe('80%');
    expect(zoomLabel(1)).toBe('100%');
    expect(zoomLabel(0.655)).toBe('66%');
    expect(zoomLabel(NaN)).toBe('100%');
  });
});
