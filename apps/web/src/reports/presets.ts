// Report templates and saved presets.
//
// A template is a starting point, not a constraint — it just seeds the spec, and
// the user edits from there. They exist because "build what you want" is
// paralysing from an empty list of 24 sections, and because the four or five
// documents a cafe actually needs are well known.

import type { ReportRange } from './range';
import { DEFAULT_RANGE } from './range';
import { sectionById } from './registry';
import type { DetailLevel, ReportSpec, SectionSelection } from './types';

export type Template = {
  key: string;
  name: string;
  /** Who asks for this document and why. Shown under the name. */
  description: string;
  title: string;
  range?: ReportRange;
  landscape?: boolean;
  compare?: boolean;
  methodology?: boolean;
  /** Section ids, in document order. Unknown or ungranted ids are dropped. */
  sections: (string | [string, DetailLevel, number?])[];
};

export const TEMPLATES: Template[] = [
  {
    key: 'daily_close',
    name: 'Daily close',
    description: 'End-of-day pack: drawer reconciliation, what sold, what was paid out.',
    title: 'Daily close',
    range: { kind: 'preset', preset: 'today' },
    sections: [
      'sales.summary',
      'sales.payment_mix',
      'ops.shifts',
      ['ops.order_log', 'full'],
      'ops.voids_discounts',
      ['money.expenses', 'full'],
    ],
  },
  {
    key: 'monthly_pl',
    name: 'Monthly P&L',
    description: 'The accounting month: net revenue, margin by category, every expense.',
    title: 'Monthly profit & loss',
    range: { kind: 'preset', preset: 'lastmonth' },
    compare: true,
    methodology: true,
    sections: [
      'sales.summary',
      'profit.summary',
      'profit.by_category',
      ['money.expenses', 'full'],
      'profit.drilldowns',
    ],
  },
  {
    key: 'board_pack',
    name: 'Owner / board pack',
    description: 'Trading performance, position and equity, with previous-period comparison.',
    title: 'Owner report',
    range: { kind: 'preset', preset: 'lastmonth' },
    compare: true,
    methodology: true,
    sections: [
      'sales.summary',
      'sales.daily',
      'profit.summary',
      'profit.by_category',
      ['sales.top_sellers', 'full'],
      'money.balances',
      'money.owner_equity',
      'money.credit',
    ],
  },
  {
    key: 'tax_pack',
    name: 'Tax / VAT pack',
    description: 'What was billed, what VAT was collected, and every expense with its vendor.',
    title: 'Tax and VAT summary',
    range: { kind: 'preset', preset: 'lastmonth' },
    methodology: true,
    sections: [
      'sales.summary',
      'sales.daily',
      ['ops.order_log', 'full'],
      ['money.expenses', 'full'],
      'money.transfers',
    ],
  },
  {
    key: 'stocktake',
    name: 'Stocktake',
    description: 'Stock on hand with valuation, low-stock list, and every movement.',
    title: 'Stocktake',
    landscape: true,
    sections: ['inv.on_hand', ['inv.movements', 'topN', 200]],
  },
  {
    key: 'payroll',
    name: 'Payroll',
    description: 'Who is on the books and what they were actually paid.',
    title: 'Payroll report',
    range: { kind: 'preset', preset: 'lastmonth' },
    sections: ['people.staff', ['people.pay', 'full']],
  },
  {
    key: 'menu_performance',
    name: 'Menu performance',
    description: 'Which items and categories earn their place on the menu.',
    title: 'Menu performance',
    range: { kind: 'preset', preset: '30d' },
    landscape: true,
    compare: true,
    sections: [
      'sales.summary',
      'sales.category_mix',
      ['sales.top_sellers', 'full'],
      ['sales.movers', 'full'],
      'profit.by_category',
    ],
  },
  {
    key: 'operations',
    name: 'Operations review',
    description: 'When the cafe is busy, how fast it turns, and where tables earn.',
    title: 'Operations review',
    range: { kind: 'preset', preset: '30d' },
    landscape: true,
    sections: [
      'sales.summary',
      'sales.velocity',
      'sales.heatmap',
      'sales.table_mix',
      'ops.voids_discounts',
    ],
  },
  {
    key: 'custom',
    name: 'Start from scratch',
    description: 'Pick your own sections.',
    title: 'Report',
    sections: [],
  },
];

export const DEFAULT_TOP_N = 100;

export function templateByKey(key: string): Template | undefined {
  return TEMPLATES.find((t) => t.key === key);
}

/**
 * Expand a template's shorthand into concrete selections.
 *
 * A bare id takes the section's own `defaultDetail` rather than a hardcoded
 * 'full': a KPI block only supports 'summary', and asking it for 'full' would
 * make the "About this report" page claim a detail level the section doesn't
 * have. Templates only spell out a detail when they want to override it.
 */
export function templateSelections(t: Template): SectionSelection[] {
  return t.sections.map((s) => {
    if (typeof s !== 'string') return { id: s[0], detail: s[1], topN: s[2] ?? DEFAULT_TOP_N };
    const section = sectionById(s);
    return {
      id: s,
      detail: section?.defaultDetail ?? ('full' as DetailLevel),
      topN: DEFAULT_TOP_N,
    };
  });
}

export function specFromTemplate(t: Template, range?: ReportRange): ReportSpec {
  return {
    title: t.title,
    range: range ?? t.range ?? DEFAULT_RANGE,
    paper: 'a4',
    orientation: t.landscape ? 'landscape' : 'portrait',
    density: 'comfortable',
    cover: true,
    methodology: t.methodology ?? false,
    compare: t.compare ?? false,
    includeEmpty: false,
    sections: templateSelections(t),
  };
}

// ---------------------------------------------------------------------------
// Saved presets
// ---------------------------------------------------------------------------

/**
 * A user-saved spec, stored in `tenants.preferences.reportPresets`.
 *
 * The range is deliberately NOT saved: a preset is "the shape of my monthly board
 * pack", and a saved absolute window would silently re-issue last March's report
 * every time. A saved *preset* range (e.g. "last month") is kept, because that
 * one stays correct as time passes.
 */
export type SavedPreset = {
  name: string;
  spec: Omit<ReportSpec, 'range'> & { range?: Extract<ReportRange, { kind: 'preset' }> };
};

export function toSavedPreset(name: string, spec: ReportSpec): SavedPreset {
  const { range, ...rest } = spec;
  return {
    name,
    spec: { ...rest, ...(range.kind === 'preset' ? { range } : {}) },
  };
}

export function fromSavedPreset(p: SavedPreset, fallback: ReportRange): ReportSpec {
  return { ...p.spec, range: p.spec.range ?? fallback };
}
