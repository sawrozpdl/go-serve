import type { ReactNode } from 'react';

/** One filter line for a report page.
 *
 *  Reports used to stack their controls: a chip row, then a full-width
 *  custom-range card, then a category/search row, then a serif panel head —
 *  ~230px of chrome before the first row of data on a page whose whole job is
 *  the table. Everything now rides one wrapping line, and the custom From/To
 *  sits inline in it (`.filter-daterange`) instead of opening a card below. */
export function ReportToolbar({ children }: { children: ReactNode }) {
  return <div className="report-toolbar">{children}</div>;
}

/** Right-hand cluster of a ReportToolbar — pushed over by margin-left:auto. */
export function ToolbarEnd({ children }: { children: ReactNode }) {
  return <div className="report-toolbar__end">{children}</div>;
}

type ChipOption<T extends string> = { value: T; label: string };

/** The `.chip` row every report hand-rolled. Generic over the value so each
 *  page keeps its own range model (Movers has DashboardRange, Profitability a
 *  day/span/custom triple) — all this needs is "one of N is active". */
export function RangeChips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: ChipOption<T>[];
  value: T | null;
  onChange: (next: T) => void;
}) {
  return (
    <div className="filter-row filter-row--compact">
      {options.map((o) => (
        <button
          type="button"
          key={o.value}
          className={`chip ${value === o.value ? 'active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Caption strip between the toolbar and the table: what you're looking at on
 *  the left, how much of it (and the pager) on the right. Replaces the 22px
 *  serif `.panel-head` — the page title already names the report. */
export function ReportCaption({
  title,
  children,
}: {
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="report-caption">
      <span className="report-caption__title">{title}</span>
      {children && <span className="report-caption__end">{children}</span>}
    </div>
  );
}
