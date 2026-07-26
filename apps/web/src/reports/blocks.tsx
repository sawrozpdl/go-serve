// Block renderers — the presentational half of the report.
//
// One component per ReportBlock kind, and nothing else. In particular these
// components never fetch, never format numbers (sections hand over finished
// strings) and never know which page they land on. That keeps them usable in
// three places at once: the offscreen measuring pass, the on-screen preview, and
// the serialized print document.

import type { ReportBlock, TableColumn } from './types';

export function Block({ block }: { block: ReportBlock }) {
  switch (block.kind) {
    case 'heading':
      return <Heading text={block.text} sub={block.sub} level={block.level} />;
    case 'kpis':
      return <Kpis cells={block.cells} />;
    case 'table':
      return <Table columns={block.columns} rows={block.rows} caption={block.caption} />;
    case 'rows':
      return <Rows rows={block.rows} />;
    case 'bars':
      return <Bars rows={block.rows} />;
    case 'note':
      return <Note text={block.text} tone={block.tone} />;
    case 'prose':
      return <Prose paragraphs={block.paragraphs} />;
    case 'spacer':
      return <div style={{ height: `${block.mm}mm` }} />;
    case 'pagebreak':
      // Consumed by paginate(); if one survives to render it is a no-op.
      return null;
  }
}

function Heading({ text, sub, level }: { text: string; sub?: string; level: 1 | 2 }) {
  const Tag = level === 1 ? 'h2' : 'h3';
  return (
    <Tag className={level === 1 ? 'rpt-h1' : 'rpt-h2'}>
      {text}
      {sub && <div className="rpt-h__sub">{sub}</div>}
    </Tag>
  );
}

function toneClass(tone?: string): string {
  if (tone === 'good') return 'rpt-tone-good';
  if (tone === 'warn') return 'rpt-tone-warn';
  if (tone === 'bad') return 'rpt-tone-bad';
  return '';
}

function Kpis({ cells }: { cells: Extract<ReportBlock, { kind: 'kpis' }>['cells'] }) {
  return (
    <div className="rpt-kpis">
      {cells.map((c, i) => (
        <div className="rpt-kpi" key={`${c.label}-${i}`}>
          <div className="rpt-kpi__label">{c.label}</div>
          <div className={`rpt-kpi__value ${toneClass(c.tone)}`}>{c.value}</div>
          {c.note && <div className="rpt-kpi__note">{c.note}</div>}
        </div>
      ))}
    </div>
  );
}

function colClass(col: TableColumn): string {
  return col.numeric || col.align === 'right' ? 'rpt-num' : '';
}

function Table({
  columns,
  rows,
  caption,
}: {
  columns: TableColumn[];
  rows: Extract<ReportBlock, { kind: 'table' }>['rows'];
  caption?: string;
}) {
  // Fixed layout needs explicit widths or the browser divides evenly, which
  // starves a long name column and leaves money columns over-wide.
  const totalWeight = columns.reduce((n, c) => n + (c.width ?? 1), 0);
  return (
    <div className="rpt-table-wrap">
      {caption && <div className="rpt-caption">{caption}</div>}
      <table className="rpt-table">
        <colgroup>
          {columns.map((c) => (
            <col
              key={c.key}
              style={{ width: `${(((c.width ?? 1) / totalWeight) * 100).toFixed(3)}%` }}
            />
          ))}
        </colgroup>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={colClass(c)}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="rpt-table__empty">
                No rows in this period.
              </td>
            </tr>
          )}
          {rows.map((r, ri) => (
            <tr
              key={ri}
              className={[r.total ? 'rpt-total' : '', r.muted ? 'rpt-muted' : '']
                .filter(Boolean)
                .join(' ')}
            >
              {columns.map((c, ci) => (
                <td key={c.key} className={colClass(c)}>
                  {r.cells[ci] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Rows({ rows }: { rows: Extract<ReportBlock, { kind: 'rows' }>['rows'] }) {
  return (
    <div className="rpt-rows">
      {rows.map((r, i) => (
        <div className={`rpt-row ${r.total ? 'rpt-total' : ''}`} key={`${r.label}-${i}`}>
          <span>{r.label}</span>
          <span className={`rpt-row__v ${toneClass(r.tone)}`}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}

function Bars({ rows }: { rows: Extract<ReportBlock, { kind: 'bars' }>['rows'] }) {
  return (
    <div className="rpt-bars">
      {rows.map((r, i) => (
        <div className="rpt-bar-row" key={`${r.label}-${i}`}>
          <div className="rpt-bar-row__l">{r.label}</div>
          <div className="rpt-bar-row__t">
            {r.bars.map((b, bi) => (
              <div
                key={bi}
                className={`rpt-bar rpt-bar--${b.tone}`}
                // Clamp so a negative or out-of-range fraction can't blow the
                // row's width out and shove the figures off the page.
                style={{ width: `${Math.max(0, Math.min(1, b.frac)) * 100}%` }}
              />
            ))}
          </div>
          <div className="rpt-bar-row__n">{r.bars.map((b) => b.note).join(' · ')}</div>
        </div>
      ))}
    </div>
  );
}

function Note({ text, tone }: { text: string; tone?: 'info' | 'warn' }) {
  return <div className={`rpt-note ${tone === 'warn' ? 'rpt-note--warn' : ''}`}>{text}</div>;
}

function Prose({ paragraphs }: { paragraphs: string[] }) {
  return (
    <div className="rpt-prose">
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
    </div>
  );
}
