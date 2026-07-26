// The section catalog.
//
// Adding a report family means writing a sections/*.ts file and adding it to the
// array below. Nothing in the layout engine, the builder UI or the print path
// needs to know it exists.

import { AUDIT_SECTIONS } from './sections/audit';
import { MONEY_SECTIONS } from './sections/money';
import { OPS_SECTIONS } from './sections/ops';
import { PEOPLE_SECTIONS } from './sections/people';
import { PROFIT_SECTIONS } from './sections/profit';
import { SALES_SECTIONS } from './sections/sales';
import { STOCK_SECTIONS } from './sections/stock';
import type { AnySection } from './section';

export const ALL_SECTIONS: AnySection[] = [
  ...SALES_SECTIONS,
  ...PROFIT_SECTIONS,
  ...OPS_SECTIONS,
  ...MONEY_SECTIONS,
  ...STOCK_SECTIONS,
  ...PEOPLE_SECTIONS,
  ...AUDIT_SECTIONS,
];

export const SECTIONS_BY_ID: Record<string, AnySection> = Object.fromEntries(
  ALL_SECTIONS.map((s) => [s.id, s]),
);

export function sectionById(id: string): AnySection | undefined {
  return SECTIONS_BY_ID[id];
}
