// Measure-and-pack pagination.
//
// The old export handed the live DOM to `window.print()` and let Chrome break it
// wherever it liked — which is how tables ended up sliced mid-row, headings
// orphaned at page feet, and scroll regions clipped entirely. Here we decide the
// breaks ourselves: every sheet is a fixed-size box, and this module packs blocks
// into sheets until each one is full.
//
// The engine is pure. It never touches the DOM — the caller supplies a
// `measure(block) => mm` callback (the builder measures against an offscreen
// container at the sheet's content width; tests pass a stub). That's what makes
// the break logic testable without a headless browser.

import type { ReportBlock, TaggedBlock } from './types';

export type Sheet = { blocks: TaggedBlock[] };

export type MeasureFn = (block: ReportBlock) => number;

/**
 * Measured geometry of one table, in mm.
 *
 * `rowsMm` is per-row and must be the REAL rendered heights, not a uniform
 * estimate. Report tables have free-text columns (expense notes, vendor names)
 * that wrap to two or three lines, so a single representative row height
 * underestimates the tall ones, packs too many onto a sheet, and clips the
 * bottom of the page — which is the exact failure this whole rework exists to
 * remove. Measuring each row costs one offscreen layout pass and removes the
 * guess entirely.
 */
export type TableMetrics = {
  /** Column header row plus any caption above it. Repeated on every chunk. */
  headerMm: number;
  rowsMm: number[];
};

export type PaginateOpts = {
  /** Usable content height of one sheet, in mm. */
  contentHeightMm: number;
  measure: MeasureFn;
  /** Real measured geometry for a table block. */
  tableMetrics: (block: ReportBlock) => TableMetrics;
};

/**
 * Fewest body rows worth starting a table with at the foot of a sheet. Below
 * this, push the whole table to the next sheet — a header plus one lonely row is
 * worse than a little white space.
 */
const MIN_ORPHAN_ROWS = 3;

/**
 * Pack blocks into sheets.
 *
 * Rules, in the order they matter:
 *  - `pagebreak` starts a new sheet.
 *  - A `keepWithNext` block (section headings) never lands as the last block on
 *    a sheet; if it would, it moves to the next sheet with its content.
 *  - `table` blocks split across sheets, repeating the column header and marking
 *    each continuation. Every other block is atomic.
 *  - A single block taller than a whole sheet gets its own sheet and is allowed
 *    to overflow rather than vanish. Chrome will clip it, but it is present and
 *    the caller can see the overflow (see `oversized`).
 */
export function paginate(
  blocks: TaggedBlock[],
  opts: PaginateOpts,
): { sheets: Sheet[]; oversized: number } {
  const { contentHeightMm, measure, tableMetrics } = opts;
  const sheets: Sheet[] = [];
  let current: TaggedBlock[] = [];
  let used = 0;
  let oversized = 0;

  const flush = () => {
    if (current.length) sheets.push({ blocks: current });
    current = [];
    used = 0;
  };

  // Pull a pending keep-with-next block off the current sheet so it travels
  // with the content it introduces.
  const detachTrailingKeeps = (): TaggedBlock[] => {
    const held: TaggedBlock[] = [];
    for (;;) {
      const last = current[current.length - 1];
      if (!last || !isKeepWithNext(last.block)) break;
      current.pop();
      used -= measure(last.block);
      held.unshift(last);
    }
    return held;
  };

  for (let i = 0; i < blocks.length; i++) {
    const tagged = blocks[i];
    if (!tagged) continue;
    const { block } = tagged;

    if (block.kind === 'pagebreak') {
      flush();
      continue;
    }

    if (block.kind === 'table') {
      const metrics = tableMetrics(block);
      const placed = placeTable(tagged, {
        contentHeightMm,
        remainingMm: contentHeightMm - used,
        metrics,
      });

      // Nothing fits here at all — move any trailing heading along and retry on
      // a fresh sheet.
      if (placed.head === null) {
        const held = detachTrailingKeeps();
        flush();
        current.push(...held);
        used = held.reduce((n, h) => n + measure(h.block), 0);
        i -= 1; // re-run this table against the new sheet
        continue;
      }

      current.push(placed.head);
      used += placed.headMm;
      if (placed.oversizedRows > 0) oversized += placed.oversizedRows;

      // Remaining chunks each own a full sheet's worth of rows.
      for (const chunk of placed.rest) {
        flush();
        current.push(chunk.block);
        used = chunk.mm;
      }
      continue;
    }

    const h = measure(block);

    if (h > contentHeightMm) {
      // Taller than any sheet. Give it a sheet of its own so it is at least
      // whole-ish, and report it so the builder can warn.
      const held = detachTrailingKeeps();
      flush();
      current.push(...held, tagged);
      used = contentHeightMm; // treat the sheet as full
      oversized += 1;
      continue;
    }

    if (used + h > contentHeightMm) {
      const held = detachTrailingKeeps();
      flush();
      current.push(...held);
      used = held.reduce((n, x) => n + measure(x.block), 0);
    }

    current.push(tagged);
    used += h;
  }

  flush();
  return { sheets, oversized };
}

function isKeepWithNext(b: ReportBlock): boolean {
  return b.kind === 'heading' && b.keepWithNext === true;
}

// ---------------------------------------------------------------------------
// Table splitting
// ---------------------------------------------------------------------------

type TablePlacement = {
  /** First chunk, sized to the space left on the current sheet. */
  head: TaggedBlock | null;
  /** Height the first chunk occupies (header + its rows), in mm. */
  headMm: number;
  /** Follow-on chunks, one per subsequent sheet, with their heights. */
  rest: { block: TaggedBlock; mm: number }[];
  /** Rows so tall they can't fit a sheet even alone — reported, never dropped. */
  oversizedRows: number;
};

function placeTable(
  tagged: TaggedBlock,
  opts: { contentHeightMm: number; remainingMm: number; metrics: TableMetrics },
): TablePlacement {
  const { contentHeightMm, remainingMm, metrics } = opts;
  const empty: TablePlacement = { head: null, headMm: 0, rest: [], oversizedRows: 0 };
  const block = tagged.block;
  if (block.kind !== 'table') return empty;

  const { headerMm } = metrics;
  const rowMm = (i: number) => metrics.rowsMm[i] ?? 0;

  /** How many rows starting at `start` fit in `budgetMm` (at least one). */
  const fit = (start: number, budgetMm: number): { count: number; mm: number } => {
    let mm = headerMm;
    let count = 0;
    for (let i = start; i < block.rows.length; i++) {
      const h = rowMm(i);
      // Always take one row even when it alone overflows: dropping it would
      // lose data silently, which is never the right trade in a report.
      if (count > 0 && mm + h > budgetMm) break;
      mm += h;
      count += 1;
    }
    return { count, mm };
  };

  const total = block.rows.length;
  // An empty table still prints — its caption carries the "no rows" statement.
  if (total === 0) return { head: tagged, headMm: headerMm, rest: [], oversizedRows: 0 };

  const here = fit(0, remainingMm);
  // Not enough room for a header plus a decent stub, and there IS a fresh sheet
  // to move to: reflow rather than orphan a two-row fragment.
  if (here.count < MIN_ORPHAN_ROWS && remainingMm < contentHeightMm && total >= MIN_ORPHAN_ROWS) {
    return empty;
  }

  const oversizedRows = metrics.rowsMm.filter((h) => headerMm + h > contentHeightMm).length;

  const head: TaggedBlock = {
    sectionId: tagged.sectionId,
    block: { ...block, rows: block.rows.slice(0, here.count) },
  };

  const rest: { block: TaggedBlock; mm: number }[] = [];
  let cursor = here.count;
  let part = 2;
  while (cursor < total) {
    const chunk = fit(cursor, contentHeightMm);
    rest.push({
      mm: chunk.mm,
      block: {
        sectionId: tagged.sectionId,
        block: {
          ...block,
          rows: block.rows.slice(cursor, cursor + chunk.count),
          caption: continuationCaption(block.caption, part),
        },
      },
    });
    cursor += chunk.count;
    part += 1;
  }

  return { head, headMm: here.mm, rest, oversizedRows };
}

function continuationCaption(caption: string | undefined, part: number): string {
  const base = caption ? `${caption} ` : '';
  return `${base}(continued — part ${part})`;
}

// ---------------------------------------------------------------------------
// Estimation, for the builder's "≈ N pages" hints
// ---------------------------------------------------------------------------

/**
 * Rough page count for a block list without laying it out. Used for the
 * per-section "4,182 rows → ~84 pages" warning, where being a page or two out
 * doesn't matter but blocking the UI on a real measure pass would.
 */
export function estimatePages(
  blocks: TaggedBlock[],
  opts: {
    contentHeightMm: number;
    measure: MeasureFn;
    tableMetrics: (block: ReportBlock) => TableMetrics;
  },
): number {
  let mm = 0;
  for (const { block } of blocks) {
    if (block.kind === 'pagebreak') {
      mm = Math.ceil(mm / opts.contentHeightMm) * opts.contentHeightMm;
      continue;
    }
    if (block.kind === 'table') {
      const m = opts.tableMetrics(block);
      mm += m.headerMm + m.rowsMm.reduce((n, h) => n + h, 0);
      continue;
    }
    mm += opts.measure(block);
  }
  return Math.max(1, Math.ceil(mm / opts.contentHeightMm));
}
