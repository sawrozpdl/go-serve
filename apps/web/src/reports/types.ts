// Report builder — the document model.
//
// A report is a ReportSpec: a range, some page options, and an ordered list of
// section selections. Rendering happens in two stages:
//
//   1. Each selected section turns its fetched data into a flat ReportBlock[]
//      (see registry.ts). Blocks are the atoms of layout — a heading, a KPI
//      grid, a table, a note. Nothing in a block knows about pages.
//   2. paginate() measures those blocks and packs them into fixed-size sheets
//      (see paginate.ts). One sheet renders to exactly one printed page.
//
// The split matters: sections stay declarative and testable, and the layout
// engine stays pure (it only needs a measure callback, so it runs in jsdom).

import type { ReportRange } from './range';

export type PaperSize = 'a4' | 'letter' | 'legal';
export type Orientation = 'portrait' | 'landscape';
export type Density = 'comfortable' | 'compact';

/** Paper dimensions in millimetres, portrait. `@page size` uses the same names. */
export const PAPER_MM: Record<PaperSize, { w: number; h: number; label: string }> = {
  a4: { w: 210, h: 297, label: 'A4' },
  letter: { w: 215.9, h: 279.4, label: 'Letter' },
  legal: { w: 215.9, h: 355.6, label: 'Legal' },
};

/** Page margin and the vertical space the running header/footer reserve, in mm. */
export const SHEET_PAD_MM = 14;
export const SHEET_HEADER_MM = 10;
export const SHEET_FOOTER_MM = 8;

/** Usable content box of one sheet, in mm. */
export function contentBoxMm(paper: PaperSize, orientation: Orientation): { w: number; h: number } {
  const { w, h } = PAPER_MM[paper];
  const pw = orientation === 'portrait' ? w : h;
  const ph = orientation === 'portrait' ? h : w;
  return {
    w: pw - SHEET_PAD_MM * 2,
    h: ph - SHEET_PAD_MM * 2 - SHEET_HEADER_MM - SHEET_FOOTER_MM,
  };
}

// ---------------------------------------------------------------------------
// Detail level
// ---------------------------------------------------------------------------

/**
 * How much of a section's data to print. The export is PDF-only — there is no
 * CSV escape hatch — so a 4,000-row table has to be bounded deliberately rather
 * than silently truncated by a forgotten server LIMIT (which is exactly what the
 * old screenshot export did).
 *
 * Whenever a section renders fewer rows than it loaded, it MUST emit a
 * provenance line saying so (see `boundedNote`). That is the whole contract:
 * the document always discloses what it left out.
 */
export type DetailLevel = 'summary' | 'topN' | 'full';

export type SectionSelection = {
  id: string;
  detail: DetailLevel;
  /** Row cap when detail === 'topN'. */
  topN: number;
};

export type ReportSpec = {
  /** Free-text document title; defaults to the template's name. */
  title: string;
  range: ReportRange;
  paper: PaperSize;
  orientation: Orientation;
  density: Density;
  /** Render the full-page cover sheet (letterhead + range + prepared-by). */
  cover: boolean;
  /** Append the "how these numbers are calculated" appendix. */
  methodology: boolean;
  /** Show a previous-period comparison column wherever a section supports it. */
  compare: boolean;
  /** Keep sections whose data came back empty (they print "no rows"). */
  includeEmpty: boolean;
  sections: SectionSelection[];
};

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export type Align = 'left' | 'right';

export type TableColumn = {
  key: string;
  label: string;
  align?: Align;
  /** Render in the tabular-figures font. Money and counts want this. */
  numeric?: boolean;
  /** Relative column width hint (flex-ish); omitted columns share the rest. */
  width?: number;
};

export type TableRow = {
  /** Cell text, already formatted. Layout never formats numbers itself. */
  cells: (string | number | null)[];
  /** Renders bold with a rule above — for subtotal/total rows. */
  total?: boolean;
  /** Muted styling, for "no COGS allocated"-style caveat rows. */
  muted?: boolean;
};

export type KpiCell = {
  label: string;
  value: string;
  /** Small line under the value — a comparison, a share, a caveat. */
  note?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
};

export type ReportBlock =
  /** Section title. `keepWithNext` stops a heading orphaning at a page foot. */
  | { kind: 'heading'; text: string; sub?: string; level: 1 | 2; keepWithNext: true }
  | { kind: 'kpis'; cells: KpiCell[] }
  | {
      kind: 'table';
      columns: TableColumn[];
      rows: TableRow[];
      /** Printed above the table — the provenance line lives here. */
      caption?: string;
      /** Repeated at the top of every continuation chunk. */
      repeatHeader: true;
    }
  /** Label/value rows — the receipt-style arithmetic used by the P&L bridge. */
  | {
      kind: 'rows';
      rows: { label: string; value: string; total?: boolean; tone?: KpiCell['tone'] }[];
    }
  /** Horizontal bar comparison (revenue vs cost). Values are pre-scaled 0..1. */
  | {
      kind: 'bars';
      rows: { label: string; bars: { frac: number; tone: string; note: string }[] }[];
    }
  | { kind: 'note'; text: string; tone?: 'info' | 'warn' }
  /** Free prose, used by the methodology appendix. */
  | { kind: 'prose'; paragraphs: string[] }
  | { kind: 'spacer'; mm: number }
  /** Forces the next block onto a fresh sheet. */
  | { kind: 'pagebreak' };

/** A block tagged with the section it came from, so the layout can group. */
export type TaggedBlock = { sectionId: string; block: ReportBlock };

/**
 * Reserved section id for the cover. The cover is a whole sheet with its own
 * layout rather than a normal block flow, so ReportDocument keys off this to
 * skip the running header/footer on page 1.
 */
export const COVER_SECTION_ID = '__cover__';

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * The disclosure line a bounded section must print. Keep the wording uniform —
 * an auditor reading the PDF should be able to tell at a glance that a table is
 * a subset, and of what.
 */
export function boundedNote(shown: number, total: number, orderedBy: string): string | undefined {
  if (shown >= total) return undefined;
  return `Showing top ${shown.toLocaleString('en-IN')} of ${total.toLocaleString('en-IN')} rows by ${orderedBy}. The remainder is omitted from this document.`;
}
