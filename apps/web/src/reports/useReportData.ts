// Data fan-out for the selected sections.
//
// One react-query per section, keyed by (section, tenant, range). Sections load
// independently so a slow one (the profitability drill-down fans out a request
// per category) doesn't hold up the preview, and a failing one degrades to an
// in-document error rather than an empty report.
//
// Deliberately NOT reusing the app's report hooks: those carry
// `refetchInterval: 60_000`, which on a report screen would silently re-lay-out
// the document under the user every minute, mid-read.

import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useTenant } from '@/lib/tenant';

import { rangeReady, type ReportRange } from './range';
import { sectionById } from './registry';
import type { AnySection, ResolvedWindow } from './section';
import type { ReportSpec, TaggedBlock } from './types';

export type SectionResult = {
  section: AnySection;
  data?: unknown;
  rowCount: number;
  isLoading: boolean;
  error?: Error;
};

export type ReportData = {
  results: SectionResult[];
  /** Blocks for every section that loaded, in the spec's order. */
  blocks: TaggedBlock[];
  /** The window the data actually covers, taken from the API's own echo. */
  window: ResolvedWindow;
  isLoading: boolean;
  loadedCount: number;
  totalCount: number;
  errors: { label: string; message: string }[];
};

export function useReportData(spec: ReportSpec, sections: AnySection[]): ReportData {
  const { slug } = useTenant();
  const ready = rangeReady(spec.range) && !!slug;

  // Only the fields a loader actually reads belong in the key — including the
  // whole spec would refetch every section on a paper-size change.
  const queries = useQueries({
    queries: sections.map((s) => ({
      queryKey: ['report-section', s.id, slug, keyForRange(spec.range), spec.compare] as const,
      enabled: ready,
      queryFn: () => s.load({ slug: slug!, range: spec.range, compare: spec.compare }),
      // A report is a point-in-time document: once fetched, it must not move.
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchInterval: false as const,
      retry: 1,
    })),
  });

  return useMemo(() => {
    const results: SectionResult[] = sections.map((s, i) => {
      const q = queries[i];
      return {
        section: s,
        data: q?.data,
        rowCount: q?.data !== undefined ? safeRowCount(s, q.data) : 0,
        isLoading: q?.isLoading ?? true,
        error: (q?.error as Error | undefined) ?? undefined,
      };
    });

    const blocks: TaggedBlock[] = [];
    const errors: { label: string; message: string }[] = [];
    let window: ResolvedWindow = {};

    for (const r of results) {
      if (r.error) {
        errors.push({ label: r.section.label, message: r.error.message });
        // Say so in the document. A section that silently vanished would leave
        // the reader believing the report is complete.
        blocks.push({
          sectionId: r.section.id,
          block: {
            kind: 'heading',
            text: r.section.label,
            level: 1,
            keepWithNext: true,
          },
        });
        blocks.push({
          sectionId: r.section.id,
          block: {
            kind: 'note',
            tone: 'warn',
            text:
              `This section could not be loaded and is missing from the report ` +
              `(${r.error.message}). Regenerate the report before relying on it.`,
          },
        });
        continue;
      }
      if (r.data === undefined) continue;

      const sel = spec.sections.find((x) => x.id === r.section.id);
      const rendered = safeRender(r.section, r.data, {
        detail: sel?.detail ?? r.section.defaultDetail,
        topN: sel?.topN ?? 100,
        compare: spec.compare,
      });
      if (rendered.error) {
        errors.push({ label: r.section.label, message: rendered.error });
        continue;
      }

      // An empty section is dropped unless the user asked to keep it, so a
      // "Monthly P&L" for a quiet month isn't twelve pages of "no rows".
      if (!spec.includeEmpty && r.rowCount === 0 && r.section.needsRange) continue;

      for (const block of rendered.blocks) blocks.push({ sectionId: r.section.id, block });

      // First period-scoped section to report a window defines the document's
      // stated coverage. Snapshot sections have none, so they can't set it.
      if (!window.from && r.section.needsRange) {
        const w = r.section.resolvedWindow?.(r.data);
        if (w?.from) window = w;
      }
    }

    return {
      results,
      blocks,
      window,
      isLoading: queries.some((q) => q.isLoading),
      loadedCount: results.filter((r) => r.data !== undefined || r.error).length,
      totalCount: sections.length,
      errors,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, spec, ...queries.map((q) => q.dataUpdatedAt), ...queries.map((q) => q.status)]);
}

/** Stable key for a range — a preset and a month must not share a cache slot. */
function keyForRange(r: ReportRange): string {
  if (r.kind === 'preset') return `p:${r.preset}`;
  if (r.kind === 'month') return `m:${r.month}`;
  return `c:${r.from}:${r.to}`;
}

/**
 * A section's own rowCount/render must never take the whole report down. These
 * run over live tenant data with shapes the type system only assumes, so a
 * single unexpected null turns into one broken section rather than a blank page.
 */
function safeRowCount(s: AnySection, data: unknown): number {
  try {
    return s.rowCount(data);
  } catch {
    return 0;
  }
}

function safeRender(
  s: AnySection,
  data: unknown,
  opts: { detail: 'summary' | 'topN' | 'full'; topN: number; compare: boolean },
): { blocks: ReturnType<AnySection['render']>; error?: string } {
  try {
    return { blocks: s.render(data, opts) };
  } catch (e) {
    return { blocks: [], error: e instanceof Error ? e.message : 'failed to render' };
  }
}

/** Sections the spec selects, in the spec's order, filtered to what exists. */
export function selectedSections(spec: ReportSpec, allowed: AnySection[]): AnySection[] {
  const byId = new Map(allowed.map((s) => [s.id, s]));
  return spec.sections
    .map((sel) => byId.get(sel.id) ?? sectionById(sel.id))
    .filter((s): s is AnySection => !!s && byId.has(s.id));
}
