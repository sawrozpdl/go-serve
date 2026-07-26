// Sheet geometry helpers.
//
// Split out of ReportDocument.tsx so that file exports only components (React
// Fast Refresh stops working for a module that mixes the two).

import { PAPER_MM } from './types';
import type { Density, Orientation, PaperSize } from './types';

export type SheetGeometry = {
  paper: PaperSize;
  orientation: Orientation;
  density: Density;
};

/** Outer sheet size in mm, with landscape swapping the axes. */
export function sheetSizeMm(paper: PaperSize, orientation: Orientation): { w: number; h: number } {
  const { w, h } = PAPER_MM[paper];
  return orientation === 'portrait' ? { w, h } : { w: h, h: w };
}
