// Document framing — cover, filter disclosure, methodology appendix.
//
// These are not registry sections: they don't fetch anything and they wrap the
// selected sections rather than sitting among them. The builder composes them
// around the section blocks.

import { EXPLAINERS, explainerById } from '@/guide/explainers';

import { rangeLabel, resolvedWindowLabel, type ReportRange } from './range';
import { COVER_SECTION_ID } from './types';
import type { ReportBlock, ReportSpec, TaggedBlock } from './types';
import type { AnySection } from './section';

/** The cover occupies one whole sheet; ReportDocument keys off the section id. */
export function coverBlock(): TaggedBlock {
  // A spacer is a harmless stand-in: CoverBody draws the actual sheet, this
  // block only reserves the page.
  return { sectionId: COVER_SECTION_ID, block: { kind: 'spacer', mm: 0 } };
}

/**
 * States exactly what the document covers and on what basis.
 *
 * This is the page that makes a report defensible six months later. The old
 * export had none of it: a printout carried a title and a date and nothing about
 * which window, whose numbers, or what was left out.
 */
export function filtersBlocks(opts: {
  spec: ReportSpec;
  sections: AnySection[];
  resolvedFrom?: string;
  resolvedTo?: string;
  timezone?: string;
}): ReportBlock[] {
  const { spec, sections, resolvedFrom, resolvedTo, timezone } = opts;
  const windowLabel = resolvedWindowLabel(resolvedFrom, resolvedTo, timezone);
  const rangeSections = sections.filter((s) => s.needsRange);
  const snapshotSections = sections.filter((s) => !s.needsRange);

  const rows: { label: string; value: string }[] = [
    { label: 'Period requested', value: rangeLabel(spec.range) },
    ...(windowLabel ? [{ label: 'Period covered', value: windowLabel }] : []),
    ...(timezone ? [{ label: 'Day boundaries', value: `midnight to midnight, ${timezone}` }] : []),
    { label: 'Sections included', value: String(sections.length) },
    {
      label: 'Comparison',
      value: spec.compare ? 'Previous period of equal length' : 'None',
    },
  ];

  const blocks: ReportBlock[] = [
    { kind: 'heading', text: 'About this report', level: 1, keepWithNext: true },
    { kind: 'rows', rows: rows.map((r) => ({ label: r.label, value: r.value })) },
  ];

  if (snapshotSections.length > 0) {
    blocks.push({
      kind: 'note',
      text:
        `${snapshotSections.length} of the sections in this report are a snapshot rather than ` +
        `period figures — they show the position at the moment the report was generated and are ` +
        `not affected by the period above: ` +
        `${snapshotSections.map((s) => s.label).join(', ')}.`,
    });
  }

  if (rangeSections.length > 0) {
    blocks.push({
      kind: 'note',
      text:
        `Sales figures are attributed to the day a serve was settled, not the day it was ` +
        `opened. Expenses are attributed to the day they were paid. Credit collected is ` +
        `attributed to the day the money was received, which will differ from the day the ` +
        `original serve was billed.`,
    });
  }

  blocks.push({
    kind: 'table',
    repeatHeader: true,
    caption: 'Sections in this report, in the order they appear',
    columns: [
      { key: 'n', label: '#', numeric: true, width: 0.6 },
      { key: 'name', label: 'Section', width: 3 },
      { key: 'group', label: 'Family', width: 1.6 },
      { key: 'basis', label: 'Basis', width: 1.6 },
      { key: 'detail', label: 'Detail', width: 1.6 },
    ],
    rows: sections.map((s, i) => {
      const sel = spec.sections.find((x) => x.id === s.id);
      return {
        cells: [
          i + 1,
          s.label,
          s.group,
          s.needsRange ? 'Period' : 'Snapshot',
          sel?.detail === 'topN'
            ? `Top ${sel.topN}`
            : sel?.detail === 'summary'
              ? 'Summary'
              : 'Everything',
        ],
      };
    }),
  });

  return blocks;
}

/**
 * The methodology appendix, built from the shared metric registry
 * (guide/explainers.tsx) so the PDF explains a number exactly the way the app's
 * tooltips and the training guide do. One definition, three surfaces.
 *
 * Only the metrics actually present in this document are included.
 */
export function methodologyBlocks(sections: AnySection[]): ReportBlock[] {
  const wanted = new Set<string>();
  for (const s of sections) for (const id of s.explainerIds ?? []) wanted.add(id);
  if (wanted.size === 0) return [];

  // Keep EXPLAINERS' own order — it runs sales → profit → cash, which reads
  // better than the order sections happen to be selected in.
  const chosen = EXPLAINERS.filter((e) => wanted.has(e.id));
  if (chosen.length === 0) return [];

  return [
    { kind: 'pagebreak' },
    {
      kind: 'heading',
      text: 'How these numbers are calculated',
      sub: 'Appendix — definitions for the figures used in this report',
      level: 1,
      keepWithNext: true,
    },
    ...chosen.flatMap((e): ReportBlock[] => [
      { kind: 'heading', text: e.label, level: 2, keepWithNext: true },
      { kind: 'prose', paragraphs: [plainText(e.short)] },
    ]),
  ];
}

/** Explainer ids that don't resolve — surfaced by registry.test.ts. */
export function unknownExplainerIds(sections: AnySection[]): string[] {
  const bad: string[] = [];
  for (const s of sections) {
    for (const id of s.explainerIds ?? []) {
      if (!explainerById[id]) bad.push(`${s.id} -> ${id}`);
    }
  }
  return bad;
}

/**
 * Flatten explainer copy to plain text.
 *
 * `short` is a ReactNode (it carries <strong>, <em> and guide <Link>s for the
 * on-screen tooltip). The report needs a string, and rendering React here would
 * drag the whole document model into JSX for no gain — the emphasis carries no
 * information the sentence doesn't.
 */
function plainText(node: unknown): string {
  const out: string[] = [];
  walk(node, out);
  return out.join('').replace(/\s+/g, ' ').trim();
}

function walk(node: unknown, out: string[]): void {
  if (node == null || typeof node === 'boolean') return;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const c of node) walk(c, out);
    return;
  }
  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props?: { children?: unknown } }).props;
    if (props && 'children' in props) walk(props.children, out);
  }
}

/** Title for a range so the document names its own period sensibly. */
export function defaultTitle(range: ReportRange): string {
  return `Business report — ${rangeLabel(range)}`;
}
