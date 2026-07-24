import { useTenantSettings } from '@/lib/api';

/**
 * Print-only report header — hidden on screen, shown at the top of the page
 * when printing (see the @media print block in admin.css). Gives the exported
 * PDF a title block: cafe name, report name, the date range it covers, and when
 * it was generated. Render it as the first child of an analytics screen's body.
 */
export function PrintHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  const tenant = useTenantSettings();
  const cafe = tenant.data?.branding?.cafeName || tenant.data?.name || 'GoServe';
  const generated = new Date().toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="print-only print-header">
      <div className="print-header__cafe">{cafe}</div>
      <div className="print-header__title">{title}</div>
      {subtitle && <div className="print-header__sub">{subtitle}</div>}
      <div className="print-header__meta">Generated {generated}</div>
    </div>
  );
}
