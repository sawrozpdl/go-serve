import { Download } from 'lucide-react';

/**
 * Export the current analytics screen to PDF via the browser's own
 * print-to-PDF. We don't render server-side — the on-screen data is already
 * the full date-range-bounded set, so "print" IS the export. The @media print
 * rules (admin.css) strip the app chrome and expand scroll regions; this button
 * just names the file (document.title → the PDF's suggested filename) and opens
 * the dialog. Pair it with a <PrintHeader> so the printout is self-labelling.
 */
export function ExportPdfButton({ title, subtitle }: { title: string; subtitle?: string }) {
  const onClick = () => {
    const prev = document.title;
    document.title = `GoServe — ${title}${subtitle ? ` — ${subtitle}` : ''}`;
    const restore = () => {
      document.title = prev;
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    window.print();
  };

  return (
    <button type="button" className="btn no-print" onClick={onClick}>
      <Download size={14} strokeWidth={1.6} /> Export PDF
    </button>
  );
}
