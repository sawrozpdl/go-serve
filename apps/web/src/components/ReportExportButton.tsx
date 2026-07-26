import { FileText } from 'lucide-react';
import { Link } from 'react-router-dom';

import { rangeToParams, type ReportRange } from '@/reports/range';

/**
 * "Export PDF" on a report screen.
 *
 * Replaces the old ExportPdfButton, which called `window.print()` on the live
 * app document — so the PDF was whatever happened to be mounted and on screen:
 * the active tab only, tables cut off at whatever a server LIMIT returned, and
 * drill-downs missing entirely.
 *
 * This instead hands off to the report builder, pre-scoped to a template that
 * covers this screen's data and to the period the user is already looking at.
 * One click still gets them to a finished document, but the document is built
 * from freshly fetched complete data rather than scraped from the DOM — and they
 * can see and adjust it before printing.
 */
export function ReportExportButton({
  template,
  range,
  label = 'Export PDF',
}: {
  /** Template key from reports/presets.ts. */
  template: string;
  /** The screen's current period, carried through so the builder opens on it. */
  range?: ReportRange;
  label?: string;
}) {
  const params = new URLSearchParams({ template, ...(range ? rangeToParams(range) : {}) });
  return (
    <Link className="btn no-print" to={`/admin/reports/builder?${params}`}>
      <FileText size={14} strokeWidth={1.6} /> {label}
    </Link>
  );
}
