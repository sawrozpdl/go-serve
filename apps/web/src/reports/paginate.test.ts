import { describe, expect, it } from 'vitest';

import { estimatePages, paginate } from './paginate';
import type { ReportBlock, TableRow, TaggedBlock } from './types';

// A sheet 100mm tall, rows 5mm, table header 10mm → 18 rows per full sheet.
const OPTS = {
  contentHeightMm: 100,
  // Uniform row heights keep the arithmetic in the assertions obvious: 10mm of
  // header + 5mm rows over a 100mm sheet = 18 rows per full sheet.
  tableMetrics: (b: ReportBlock) => ({
    headerMm: 10,
    rowsMm: b.kind === 'table' ? b.rows.map(() => 5) : [],
  }),
  // Fixed heights per kind keep the arithmetic in the assertions obvious.
  measure: (b: ReportBlock) => {
    switch (b.kind) {
      case 'heading':
        return 10;
      case 'kpis':
        return 30;
      case 'note':
        return 8;
      case 'spacer':
        return b.mm;
      case 'prose':
        return 40;
      default:
        return 20;
    }
  },
};

function tag(block: ReportBlock, sectionId = 's'): TaggedBlock {
  return { sectionId, block };
}

function heading(text: string): ReportBlock {
  return { kind: 'heading', text, level: 2, keepWithNext: true };
}

function rows(n: number): TableRow[] {
  return Array.from({ length: n }, (_, i) => ({ cells: [`r${i}`, i] }));
}

function table(n: number, caption?: string): ReportBlock {
  return {
    kind: 'table',
    columns: [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B', numeric: true },
    ],
    rows: rows(n),
    caption,
    repeatHeader: true,
  };
}

/** All body-row cells across every chunk of a table, in order. */
function allTableCells(sheets: { blocks: TaggedBlock[] }[]): unknown[] {
  const out: unknown[] = [];
  for (const s of sheets) {
    for (const { block } of s.blocks) {
      if (block.kind === 'table') out.push(...block.rows.map((r) => r.cells[0]));
    }
  }
  return out;
}

/**
 * Index helpers. `noUncheckedIndexedAccess` is on, so every `sheets[0]` is
 * `T | undefined` — these assert presence once instead of littering the
 * assertions with non-null operators.
 */
function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined)
    throw new Error(`expected an element at index ${i}, got ${arr.length} items`);
  return v;
}

/** Kinds of the blocks on a sheet. */
function kinds(sheet: { blocks: TaggedBlock[] }): string[] {
  return sheet.blocks.map((b) => b.block.kind);
}

/** The table block on a sheet, asserted to be one. */
function tableOn(sheet: { blocks: TaggedBlock[] }, i = 0): Extract<ReportBlock, { kind: 'table' }> {
  const block = at(sheet.blocks, i).block;
  if (block.kind !== 'table') throw new Error(`expected a table at index ${i}, got ${block.kind}`);
  return block;
}

describe('paginate', () => {
  it('packs atomic blocks up to the sheet height and no further', () => {
    // 3 × 30mm kpis = 90mm fits; a fourth would be 120mm.
    const blocks = Array.from({ length: 4 }, () => tag({ kind: 'kpis', cells: [] }));
    const { sheets } = paginate(blocks, OPTS);
    expect(sheets).toHaveLength(2);
    expect(at(sheets, 0).blocks).toHaveLength(3);
    expect(at(sheets, 1).blocks).toHaveLength(1);
  });

  it('fills a sheet exactly without spilling to a new one', () => {
    // 5 × 20mm = exactly 100mm.
    const blocks = Array.from({ length: 5 }, () => tag({ kind: 'bars', rows: [] }));
    const { sheets } = paginate(blocks, OPTS);
    expect(sheets).toHaveLength(1);
    expect(at(sheets, 0).blocks).toHaveLength(5);
  });

  it('starts a new sheet on a pagebreak', () => {
    const blocks = [
      tag({ kind: 'note', text: 'a' }),
      tag({ kind: 'pagebreak' }),
      tag({ kind: 'note', text: 'b' }),
    ];
    const { sheets } = paginate(blocks, OPTS);
    expect(sheets).toHaveLength(2);
    // The break itself is not rendered as content.
    expect(kinds(at(sheets, 0))).toEqual(['note']);
    expect(kinds(at(sheets, 1))).toEqual(['note']);
  });

  it('never leaves a keep-with-next heading as the last block on a sheet', () => {
    // 90mm of kpis, then a heading (10mm — exactly fills the sheet), then content.
    const blocks = [
      tag({ kind: 'kpis', cells: [] }),
      tag({ kind: 'kpis', cells: [] }),
      tag({ kind: 'kpis', cells: [] }),
      tag(heading('Expenses')),
      tag({ kind: 'note', text: 'body' }),
    ];
    const { sheets } = paginate(blocks, OPTS);
    expect(sheets).toHaveLength(2);
    expect(kinds(at(sheets, 0))).toEqual(['kpis', 'kpis', 'kpis']);
    // The heading travelled to sit above its content.
    expect(kinds(at(sheets, 1))).toEqual(['heading', 'note']);
  });

  it('splits a long table across sheets and repeats the header', () => {
    const { sheets } = paginate([tag(table(40))], OPTS);
    // 18 rows per sheet → 18 + 18 + 4.
    expect(sheets).toHaveLength(3);
    expect(sheets.map((s) => tableOn(s).rows.length)).toEqual([18, 18, 4]);
    // Every chunk carries the column definitions, so the header re-renders.
    for (const s of sheets) {
      expect(tableOn(s).columns).toHaveLength(2);
      expect(tableOn(s).repeatHeader).toBe(true);
    }
  });

  it('loses no rows when splitting', () => {
    const { sheets } = paginate([tag(table(97))], OPTS);
    const cells = allTableCells(sheets);
    expect(cells).toHaveLength(97);
    expect(cells).toEqual(rows(97).map((r) => r.cells[0]));
  });

  it('marks continuation chunks and leaves the first chunk caption clean', () => {
    const { sheets } = paginate([tag(table(40, 'Expense register'))], OPTS);
    expect(sheets.map((s) => tableOn(s).caption)).toEqual([
      'Expense register',
      'Expense register (continued — part 2)',
      'Expense register (continued — part 3)',
    ]);
  });

  it('pushes a table to the next sheet rather than orphaning a stub header', () => {
    // 95mm used → only 5mm left, not even a header. The table must move, and
    // take its heading with it.
    const blocks = [
      tag({ kind: 'kpis', cells: [] }),
      tag({ kind: 'kpis', cells: [] }),
      tag({ kind: 'kpis', cells: [] }),
      tag({ kind: 'note', text: 'x' }), // 30*3 + 8 = 98mm
      tag(heading('Register')),
      tag(table(10)),
    ];
    const { sheets } = paginate(blocks, OPTS);
    expect(sheets).toHaveLength(2);
    expect(kinds(at(sheets, 1))).toEqual(['heading', 'table']);
    expect(tableOn(at(sheets, 1), 1).rows).toHaveLength(10);
  });

  it('keeps an empty table so its caption can state that there are no rows', () => {
    const { sheets } = paginate([tag(table(0, 'No expenses in this period'))], OPTS);
    expect(sheets).toHaveLength(1);
    const t = tableOn(at(sheets, 0));
    expect(t.rows).toHaveLength(0);
    expect(t.caption).toBe('No expenses in this period');
  });

  it("packs by each row's real height, not a uniform estimate", () => {
    // The bug real data exposed: report tables have free-text columns (expense
    // notes, vendor names) that wrap. With a uniform 5mm row assumption the
    // engine fitted 18 rows per sheet and the tall ones ran off the bottom of
    // the page. Here rows alternate 5mm and 20mm.
    const t = table(12);
    const { sheets } = paginate([tag(t)], {
      ...OPTS,
      tableMetrics: () => ({ headerMm: 10, rowsMm: [5, 20, 5, 20, 5, 20, 5, 20, 5, 20, 5, 20] }),
    });

    // Every chunk must fit inside the 100mm sheet, header included.
    const heights = [5, 20, 5, 20, 5, 20, 5, 20, 5, 20, 5, 20];
    let cursor = 0;
    for (const sheet of sheets) {
      const rows = tableOn(sheet).rows.length;
      const mm = 10 + heights.slice(cursor, cursor + rows).reduce((a, b) => a + b, 0);
      expect(mm).toBeLessThanOrEqual(100);
      cursor += rows;
    }
    // And no row may be dropped on the way.
    expect(cursor).toBe(12);
    expect(allTableCells(sheets)).toHaveLength(12);
  });

  it('keeps a row that is taller than a whole sheet, and reports it', () => {
    // Dropping it would lose data silently; overflowing one page is the lesser
    // evil, and the builder surfaces the count as a warning.
    const { sheets, oversized } = paginate([tag(table(2))], {
      ...OPTS,
      tableMetrics: () => ({ headerMm: 10, rowsMm: [200, 5] }),
    });
    expect(allTableCells(sheets)).toHaveLength(2);
    expect(oversized).toBeGreaterThan(0);
  });

  it('gives an oversized atomic block its own sheet and reports it', () => {
    const blocks = [
      tag({ kind: 'note', text: 'before' }),
      tag({ kind: 'spacer', mm: 250 }), // 2.5 sheets tall
      tag({ kind: 'note', text: 'after' }),
    ];
    const { sheets, oversized } = paginate(blocks, OPTS);
    expect(oversized).toBe(1);
    expect(sheets).toHaveLength(3);
    expect(kinds(at(sheets, 0))).toEqual(['note']);
    expect(kinds(at(sheets, 1))).toEqual(['spacer']);
    expect(kinds(at(sheets, 2))).toEqual(['note']);
  });

  it('returns no sheets for no blocks', () => {
    expect(paginate([], OPTS).sheets).toEqual([]);
  });
});

describe('estimatePages', () => {
  it('counts a table by its rows', () => {
    // 10mm header + 200 rows * 5mm = 1010mm / 100mm = 11 pages.
    expect(estimatePages([tag(table(200))], OPTS)).toBe(11);
  });

  it('never reports fewer than one page', () => {
    expect(estimatePages([], OPTS)).toBe(1);
    expect(estimatePages([tag({ kind: 'note', text: 'x' })], OPTS)).toBe(1);
  });

  it('rounds a pagebreak up to the next whole sheet', () => {
    const blocks = [
      tag({ kind: 'note', text: 'a' }), // 8mm
      tag({ kind: 'pagebreak' }), // -> 100mm
      tag({ kind: 'note', text: 'b' }), // 108mm -> 2 pages
    ];
    expect(estimatePages(blocks, OPTS)).toBe(2);
  });
});
