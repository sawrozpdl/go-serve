// The section contract.
//
// A section is one self-contained chunk of the report: it knows how to fetch its
// own data (completely — paging to the end, not to whatever a forgotten server
// LIMIT allowed), how many rows that came to, and how to turn it into blocks.
//
// Sections never render React and never touch pagination. That keeps the catalog
// in registry.ts declarative, and it means adding a report family is one file
// with no engine changes.

import type { Permission } from '@cafe-mgmt/rbac';

import { can, hasFeature, type Me } from '@/lib/api';

import type { DetailLevel, ReportBlock, TableRow } from './types';
import { boundedNote } from './types';
import type { ReportRange } from './range';

export type SectionGroup =
  | 'Sales'
  | 'Profit'
  | 'Operations'
  | 'Money'
  | 'Inventory'
  | 'People'
  | 'Audit';

export const SECTION_GROUPS: SectionGroup[] = [
  'Sales',
  'Profit',
  'Operations',
  'Money',
  'Inventory',
  'People',
  'Audit',
];

export type LoadCtx = {
  slug: string;
  range: ReportRange;
  /** Ask endpoints for previous-period figures where they support it. */
  compare: boolean;
};

export type RenderOpts = {
  detail: DetailLevel;
  topN: number;
  compare: boolean;
};

/** The window a section's data actually covers, as echoed by the API. */
export type ResolvedWindow = { from?: string; to?: string; timezone?: string };

export type ReportSection<T> = {
  id: string;
  group: SectionGroup;
  label: string;
  /** One line in the builder's section list. */
  description: string;
  /**
   * RBAC key required to see and load this section.
   *
   * `Permission` looks like a union of manifest keys but a JSON module import
   * widens its string values, so the compiler will happily accept a typo — and
   * an unknown key makes `can()` return false, silently hiding the section
   * rather than erroring. registry.test.ts checks every key against the
   * manifest for that reason; the Go side lints the same way.
   */
  perm?: Permission;
  /** Plan feature required, mirroring lib/features.ts. */
  feature?: string;
  /**
   * False for point-in-time sections (balances, stock on hand, staff roster).
   * They ignore the report range and print an "as of" stamp instead — showing a
   * date range above a current-balance table would misrepresent it.
   */
  needsRange: boolean;
  /** Wide tables read better rotated; the builder surfaces this as a hint. */
  prefersLandscape?: boolean;
  /** Metric ids from guide/explainers.tsx, for the methodology appendix. */
  explainerIds?: string[];
  defaultDetail: DetailLevel;
  /** Which detail levels make sense here (a KPI block has only 'summary'). */
  detailLevels: DetailLevel[];
  load: (ctx: LoadCtx) => Promise<T>;
  rowCount: (data: T) => number;
  resolvedWindow?: (data: T) => ResolvedWindow | undefined;
  render: (data: T, opts: RenderOpts) => ReportBlock[];
};

/**
 * Existential wrapper so heterogeneous sections live in one array. Each section
 * closes over its own data type internally; callers only ever pass a section's
 * own data back to its own methods (useReportData keys results by section id).
 */
export type AnySection = ReportSection<any>;

/** Identity helper that keeps each section's own T inferred at definition. */
export function defineSection<T>(s: ReportSection<T>): AnySection {
  return s;
}

/** Sections the signed-in member may actually see. */
export function visibleSections(me: Me | undefined, sections: AnySection[]): AnySection[] {
  return sections.filter((s) => {
    if (s.feature && !hasFeature(me, s.feature)) return false;
    if (s.perm && !can(me, s.perm)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Paging to completion
// ---------------------------------------------------------------------------

export type Paged<T> = { rows: T[]; total: number; truncated: boolean };

/**
 * Pull every page of an offset-paged endpoint.
 *
 * `hardCap` is a guard, not a feature: a tenant with 80k audit rows would other-
 * wise lock the browser building a 1,600-page document. When it trips, the
 * result is flagged `truncated` and the section MUST say so in its caption — the
 * one thing this whole rework exists to prevent is a silent subset.
 */
export async function pageAll<T>(
  fetchPage: (offset: number, limit: number) => Promise<{ rows: T[]; total: number }>,
  opts: { pageSize: number; hardCap: number },
): Promise<Paged<T>> {
  const rows: T[] = [];
  let total = 0;
  let offset = 0;
  for (;;) {
    const page = await fetchPage(offset, opts.pageSize);
    total = page.total;
    rows.push(...page.rows);
    offset += page.rows.length;
    // A short page means the end. A zero-length page also means the end, and
    // guards against a server that ignores offset (which would loop forever).
    if (page.rows.length === 0 || page.rows.length < opts.pageSize) break;
    if (rows.length >= total) break;
    if (rows.length >= opts.hardCap) return { rows, total, truncated: true };
  }
  return { rows, total, truncated: rows.length < total };
}

/** Cursor-paged equivalent, for the audit log's keyset pagination. */
export async function cursorAll<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ rows: T[]; nextCursor?: string | null }>,
  opts: { hardCap: number },
): Promise<Paged<T>> {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    rows.push(...page.rows);
    if (!page.nextCursor || page.rows.length === 0) break;
    if (rows.length >= opts.hardCap) {
      // Total is unknown with keyset paging — report what we have and flag it.
      return { rows, total: rows.length, truncated: true };
    }
    cursor = page.nextCursor;
  }
  return { rows, total: rows.length, truncated: false };
}

// ---------------------------------------------------------------------------
// Bounding + disclosure
// ---------------------------------------------------------------------------

/**
 * Apply a detail level to a row set and produce the caption that discloses it.
 *
 * This is the single place bounding happens, so no section can accidentally
 * print a subset without saying so. `orderedBy` names the sort the top-N is
 * taken along ("revenue", "amount") — "top 100" is meaningless without it.
 */
export function boundRows<T>(
  all: T[],
  opts: { detail: DetailLevel; topN: number },
  meta: { total: number; truncated?: boolean; orderedBy: string; emptyText?: string },
): { rows: T[]; caption?: string } {
  const captions: string[] = [];

  let rows = all;
  if (opts.detail === 'topN') {
    rows = all.slice(0, Math.max(1, opts.topN));
  }

  if (rows.length === 0) {
    return { rows, caption: meta.emptyText ?? 'No rows in this period.' };
  }

  // Deliberate bounding by the user's detail choice.
  const note = boundedNote(rows.length, meta.total, meta.orderedBy);
  if (note) captions.push(note);

  // Bounding forced by the fetch guard — a different fact, and worth its own
  // sentence because the user did not ask for it.
  if (meta.truncated && rows.length >= all.length) {
    captions.push(
      `Only the first ${all.length.toLocaleString('en-IN')} rows could be retrieved for this report; ` +
        `narrow the date range to cover the rest.`,
    );
  }

  return { rows, caption: captions.length ? captions.join(' ') : undefined };
}

// ---------------------------------------------------------------------------
// Block helpers
// ---------------------------------------------------------------------------

export function heading(text: string, sub?: string, level: 1 | 2 = 1): ReportBlock {
  return { kind: 'heading', text, sub, level, keepWithNext: true };
}

export function note(text: string, tone?: 'info' | 'warn'): ReportBlock {
  return { kind: 'note', text, tone };
}

/** A total row for the foot of a table. */
export function totalRow(cells: (string | number | null)[]): TableRow {
  return { cells, total: true };
}
