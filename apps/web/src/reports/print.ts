// Printing the report.
//
// The report is already rendered on screen as a stack of exact-size sheets, so
// printing is just: take that DOM, wrap it in a standalone document with the
// report stylesheet and an `@page` rule, and hand it to the existing
// `printHTML()` iframe primitive (lib/printing.ts) that thermal slips already
// use.
//
// Serializing rather than re-rendering is the point. The old export printed the
// live app document, so it inherited the app's stylesheet — dark panels, hidden
// scroll regions, only the active tab mounted. Here the iframe contains nothing
// but the report, so what the user previewed is exactly what comes out.

import { printHTML } from '@/lib/printing';

import { pageRule } from './reportCss';
import type { Orientation, PaperSize } from './types';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Print the report.
 *
 * `root` is the element wrapping the rendered `.rpt-sheet` stack — its
 * `outerHTML` is copied verbatim, inline <style> included (ReportDocument
 * renders REPORT_CSS inside itself), so no stylesheet plumbing is needed here
 * beyond the paper rule.
 *
 * `filename` only *suggests* a name: Chrome's Save-as-PDF takes it from the
 * document title. We set it on both the iframe document and, transiently, the
 * parent — different Chrome versions have read different ones.
 */
export function printReport(opts: {
  root: HTMLElement;
  filename: string;
  paper: PaperSize;
  orientation: Orientation;
}): void {
  const { root, filename, paper, orientation } = opts;

  // The on-screen stack carries preview-only chrome (drop shadows, inter-sheet
  // gaps). Swapping the variant class drops it so sheets sit flush and one sheet
  // maps to exactly one printed page.
  const clone = root.cloneNode(true) as HTMLElement;
  clone.classList.remove('rpt-preview');
  clone.classList.add('rpt-print');

  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8" />
<title>${esc(filename)}</title>
<style>${pageRule(paper, orientation)}</style>
</head><body>${clone.outerHTML}</body></html>`;

  const prevTitle = document.title;
  document.title = filename;
  const restore = () => {
    document.title = prevTitle;
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  // afterprint does not fire in every browser/OS combination when the dialog is
  // dismissed, so restore on a timer too — otherwise the app tab keeps the
  // report's name forever.
  window.setTimeout(restore, 60_000);

  printHTML(doc);
}

/**
 * Fetch an image and inline it as a data URI.
 *
 * Needed for the cover logo: tenant logos are served through an authenticated
 * blob path, and neither a blob: URL nor a cookie-authed http URL resolves inside
 * an `srcdoc` iframe. Returns undefined on any failure — a missing logo must
 * never block an export.
 */
export async function toDataUri(url: string | undefined): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return undefined;
    const blob = await res.blob();
    return await new Promise<string | undefined>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () =>
        resolve(typeof reader.result === 'string' ? reader.result : undefined);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

/** `Sahan Cafe — Monthly P&L — 2026-06.pdf`-ish, safe for a filename. */
export function reportFilename(cafe: string, title: string, windowLabel?: string): string {
  const parts = [cafe, title, windowLabel].filter(Boolean).join(' — ');
  return parts.replace(/[/\\?%*:|"<>]/g, '-').slice(0, 120);
}
