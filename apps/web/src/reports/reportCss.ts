// The report document's stylesheet, as a string.
//
// Why a string and not a .css file: the printed output is produced by
// serializing the preview DOM into a hidden iframe (see print.ts), so the exact
// same rules have to be available both to React (as a <style> tag inside the
// preview) and to the iframe's srcdoc. Two sources would drift, and the whole
// point of this design is that the preview IS the output. `lib/printing.ts`
// makes the same trade for thermal slips.
//
// Everything is scoped under `.rpt` and uses hardcoded print-safe values rather
// than the app's design tokens. That is deliberate: the old export inherited
// `var(--surface-card)` and friends from a dark theme, so panels printed as grey
// slabs and coloured figures came out near-invisible on white. A report is a
// document, not a screenshot of the UI — it gets document colours.

/** Colours are fixed, print-first: near-black on white with muted greys. */
export const REPORT_CSS = `
.rpt {
  --rpt-ink: #111418;
  --rpt-ink-soft: #4a5058;
  --rpt-ink-faint: #7a828c;
  --rpt-rule: #d4d8dd;
  --rpt-rule-strong: #111418;
  --rpt-zebra: #f7f8f9;
  --rpt-good: #1a6b3c;
  --rpt-warn: #8a5a08;
  --rpt-bad: #a32020;
  --rpt-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --rpt-num: "SFMono-Regular", ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace;
  --rpt-fs: 9.2pt;
  --rpt-lh: 1.35;
  --rpt-row-pad: 1.6mm;
  color: var(--rpt-ink);
  font-family: var(--rpt-sans);
  font-size: var(--rpt-fs);
  line-height: var(--rpt-lh);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.rpt--compact {
  --rpt-fs: 8.2pt;
  --rpt-lh: 1.25;
  --rpt-row-pad: 1.0mm;
}
.rpt *, .rpt *::before, .rpt *::after { box-sizing: border-box; }
/* Reset the UA margins on bare text elements only.
 *
 * :where() contributes zero specificity, so the block rules below (which are
 * single classes) still win. Written the obvious way, as ".rpt p, .rpt div",
 * the reset is a class+type selector and OUT-specifies ".rpt-table-wrap" —
 * which silently zeroed the margin on every block in the document. The report
 * had no vertical rhythm at all, and the measured block heights disagreed with
 * the rendered ones. A div is not in the list: it has no UA margin to reset. */
.rpt :where(p, h1, h2, h3, h4, table, dl, dd, ol, ul) { margin: 0; padding: 0; }

/* -- Sheet ------------------------------------------------------------- */
/* One .rpt-sheet == exactly one printed page. The fixed height plus
 * overflow:hidden is what stops Chrome inventing its own page breaks. */
.rpt-sheet {
  position: relative;
  background: #fff;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  break-after: page;
  page-break-after: always;
  break-inside: avoid;
}
.rpt-sheet:last-child { break-after: auto; page-break-after: auto; }
.rpt-sheet__header {
  flex: 0 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 4mm;
  border-bottom: 0.3mm solid var(--rpt-rule);
  padding-bottom: 1.6mm;
  font-size: 7.4pt;
  color: var(--rpt-ink-faint);
  letter-spacing: 0.02em;
}
.rpt-sheet__header strong { color: var(--rpt-ink); font-weight: 600; }
.rpt-sheet__body { flex: 1 1 auto; padding-top: 3mm; }
.rpt-sheet__footer {
  flex: 0 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 4mm;
  border-top: 0.3mm solid var(--rpt-rule);
  padding-top: 1.4mm;
  font-size: 7pt;
  color: var(--rpt-ink-faint);
}
.rpt-sheet__page { font-family: var(--rpt-num); white-space: nowrap; }

/* -- Cover ------------------------------------------------------------- */
.rpt-cover { display: flex; flex-direction: column; height: 100%; }
.rpt-cover__top { flex: 0 0 auto; display: flex; align-items: flex-start; gap: 5mm; }
.rpt-cover__logo { width: 22mm; height: 22mm; object-fit: contain; }
.rpt-cover__cafe { font-size: 17pt; font-weight: 700; letter-spacing: -0.01em; }
.rpt-cover__addr { font-size: 8.4pt; color: var(--rpt-ink-soft); white-space: pre-line; margin-top: 1mm; }
.rpt-cover__mid { flex: 1 1 auto; display: flex; flex-direction: column; justify-content: center; }
.rpt-cover__kicker {
  font-size: 7.6pt; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--rpt-ink-faint); margin-bottom: 2mm;
}
.rpt-cover__title { font-size: 26pt; font-weight: 700; line-height: 1.1; letter-spacing: -0.02em; }
.rpt-cover__window { font-size: 12pt; margin-top: 3mm; color: var(--rpt-ink); }
.rpt-cover__rule { height: 0.6mm; background: var(--rpt-rule-strong); width: 30mm; margin: 5mm 0; }
.rpt-cover__meta { font-size: 8.4pt; color: var(--rpt-ink-soft); }
.rpt-cover__meta dl { display: grid; grid-template-columns: 34mm 1fr; row-gap: 1.2mm; column-gap: 3mm; }
.rpt-cover__meta dt { color: var(--rpt-ink-faint); }
.rpt-cover__meta dd { color: var(--rpt-ink); }
.rpt-cover__contents { flex: 0 0 auto; font-size: 8.4pt; border-top: 0.3mm solid var(--rpt-rule); padding-top: 3mm; }
.rpt-cover__contents-h {
  font-size: 7.4pt; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--rpt-ink-faint); margin-bottom: 1.6mm;
}
.rpt-cover__contents ol { margin: 0; padding-left: 6mm; columns: 2; column-gap: 8mm; }
.rpt-cover__contents li { margin-bottom: 0.8mm; break-inside: avoid; }

/* -- Headings ---------------------------------------------------------- */
.rpt-h1 {
  font-size: 13pt; font-weight: 700; letter-spacing: -0.01em;
  padding-bottom: 1.4mm; border-bottom: 0.5mm solid var(--rpt-rule-strong);
  margin-bottom: 2.4mm;
}
.rpt-h2 { font-size: 10.4pt; font-weight: 650; margin-bottom: 1.8mm; }
.rpt-h__sub { font-size: 8pt; font-weight: 400; color: var(--rpt-ink-faint); margin-top: 0.6mm; }

/* -- KPI grid ---------------------------------------------------------- */
.rpt-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(34mm, 1fr));
  gap: 2mm;
  margin-bottom: 3mm;
}
.rpt-kpi { border: 0.3mm solid var(--rpt-rule); padding: 2mm 2.4mm; break-inside: avoid; }
.rpt-kpi__label {
  font-size: 7pt; letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--rpt-ink-faint); margin-bottom: 1mm;
}
.rpt-kpi__value { font-family: var(--rpt-num); font-size: 12pt; font-weight: 600; }
.rpt-kpi__note { font-size: 7.2pt; color: var(--rpt-ink-soft); margin-top: 0.8mm; }
.rpt-tone-good { color: var(--rpt-good); }
.rpt-tone-warn { color: var(--rpt-warn); }
.rpt-tone-bad { color: var(--rpt-bad); }

/* -- Table ------------------------------------------------------------- */
.rpt-table-wrap { margin-bottom: 3mm; }
.rpt-caption { font-size: 7.6pt; color: var(--rpt-ink-soft); margin-bottom: 1.2mm; font-style: italic; }
.rpt-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.rpt-table th {
  text-align: left;
  font-size: 7.2pt;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--rpt-ink-soft);
  font-weight: 600;
  padding: 0 1.6mm var(--rpt-row-pad);
  border-bottom: 0.4mm solid var(--rpt-rule-strong);
  white-space: nowrap;
}
.rpt-table td {
  padding: var(--rpt-row-pad) 1.6mm;
  border-bottom: 0.2mm solid var(--rpt-rule);
  vertical-align: top;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.rpt-table tbody tr:nth-child(even) td { background: var(--rpt-zebra); }
.rpt-table .rpt-num { font-family: var(--rpt-num); text-align: right; white-space: nowrap; }
.rpt-table th.rpt-num { text-align: right; }
.rpt-table tr.rpt-total td {
  font-weight: 700;
  border-top: 0.4mm solid var(--rpt-rule-strong);
  border-bottom: none;
  background: #fff !important;
}
.rpt-table tr.rpt-muted td { color: var(--rpt-ink-faint); }
.rpt-table__empty { font-style: italic; color: var(--rpt-ink-faint); padding: 2mm 0; }

/* -- Label/value rows (the P&L bridge) --------------------------------- */
.rpt-rows { margin-bottom: 3mm; }
.rpt-row {
  display: flex; justify-content: space-between; gap: 4mm;
  padding: 1mm 0; border-bottom: 0.2mm solid var(--rpt-rule);
}
.rpt-row__v { font-family: var(--rpt-num); white-space: nowrap; }
.rpt-row.rpt-total {
  font-weight: 700; border-bottom: none;
  border-top: 0.4mm solid var(--rpt-rule-strong); margin-top: 0.6mm;
}

/* -- Bars -------------------------------------------------------------- */
.rpt-bars { margin-bottom: 3mm; }
.rpt-bar-row { display: flex; align-items: center; gap: 3mm; padding: 0.8mm 0; break-inside: avoid; }
.rpt-bar-row__l { flex: 0 0 40mm; font-size: 8.4pt; }
.rpt-bar-row__t { flex: 1 1 auto; display: flex; flex-direction: column; gap: 0.6mm; }
.rpt-bar { height: 1.4mm; min-width: 0.3mm; }
.rpt-bar--rev { background: #2f6f4f; }
.rpt-bar--cost { background: #b07d17; }
.rpt-bar-row__n { flex: 0 0 auto; font-family: var(--rpt-num); font-size: 7.6pt; color: var(--rpt-ink-soft); }

/* -- Notes / prose ----------------------------------------------------- */
.rpt-note {
  border-left: 0.7mm solid var(--rpt-rule-strong);
  padding: 1.2mm 0 1.2mm 2.4mm;
  font-size: 8.2pt;
  color: var(--rpt-ink-soft);
  margin-bottom: 2.4mm;
  break-inside: avoid;
}
.rpt-note--warn { border-left-color: var(--rpt-warn); color: var(--rpt-warn); }
.rpt-prose { margin-bottom: 2.4mm; }
.rpt-prose p { margin-bottom: 1.4mm; color: var(--rpt-ink-soft); }
.rpt-prose p:last-child { margin-bottom: 0; }

/* -- Preview-only chrome (never printed) ------------------------------- */
.rpt-preview { display: flex; flex-direction: column; align-items: center; gap: 6mm; }
.rpt-preview .rpt-sheet {
  box-shadow: 0 1px 3px rgba(0,0,0,0.18), 0 6px 18px rgba(0,0,0,0.12);
  outline: 1px solid rgba(0,0,0,0.08);
}
`;

/**
 * The `@page` rule for a given paper choice. Emitted separately from REPORT_CSS
 * because it depends on the spec, and because Chrome needs `margin: 0` here —
 * the sheet supplies its own padding, so a UA page margin would push each sheet
 * onto two pages.
 */
export function pageRule(
  paper: 'a4' | 'letter' | 'legal',
  orientation: 'portrait' | 'landscape',
): string {
  return `@page { size: ${paper.toUpperCase()} ${orientation}; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }`;
}
