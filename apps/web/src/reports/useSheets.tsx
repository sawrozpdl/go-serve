// Real-DOM measurement, then pagination.
//
// paginate() is pure and needs heights in millimetres. Getting them means
// actually rendering the blocks once, offscreen, at exactly the width they will
// occupy on the sheet — a table's height depends on how its text wraps, which no
// formula can predict. So:
//
//   1. Render every block into a hidden probe container sized to the sheet's
//      content width, plus two calibration probes (a 100mm ruler and a sample
//      table) so px→mm and per-row height are measured rather than assumed.
//   2. Read the heights, build an identity Map, hand it to paginate().
//   3. Render the resulting sheets.
//
// Fonts matter: measuring before the webfonts land gives fallback-metric heights
// and every sheet comes out slightly wrong, so the pass waits on
// `document.fonts.ready` and re-runs.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { Block } from './blocks';
import { paginate, type Sheet, type TableMetrics } from './paginate';
import { REPORT_CSS } from './reportCss';
import { sheetSizeMm } from './geometry';
import { SHEET_FOOTER_MM, SHEET_HEADER_MM, SHEET_PAD_MM, contentBoxMm } from './types';
import type { Density, Orientation, PaperSize, ReportBlock, TaggedBlock } from './types';

export type UseSheetsResult = {
  sheets: Sheet[];
  /** Blocks too tall for any sheet — the builder warns about these. */
  oversized: number;
  /** True until the first measurement pass has completed. */
  measuring: boolean;
  /** Render this in the tree; it is invisible and drives the measurement. */
  probe: React.ReactNode;
};

export function useSheets(
  blocks: TaggedBlock[],
  geometry: { paper: PaperSize; orientation: Orientation; density: Density },
): UseSheetsResult {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [oversized, setOversized] = useState(0);
  const [measuring, setMeasuring] = useState(true);
  const [fontsReady, setFontsReady] = useState(false);

  useEffect(() => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) {
      setFontsReady(true);
      return;
    }
    let live = true;
    fonts.ready.then(() => {
      if (live) setFontsReady(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const { w: contentW, h: contentH } = contentBoxMm(geometry.paper, geometry.orientation);
  const { w: sheetW, h: sheetH } = sheetSizeMm(geometry.paper, geometry.orientation);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (blocks.length === 0) {
      setSheets([]);
      setOversized(0);
      setMeasuring(false);
      return;
    }

    const ruler = host.querySelector<HTMLElement>('[data-rpt-ruler]');
    const probeBody = host.querySelector<HTMLElement>('[data-rpt-probe-sheet] .rpt-sheet__body');
    const blockNodes = host.querySelectorAll<HTMLElement>('[data-rpt-block]');
    if (!ruler || !probeBody || blockNodes.length !== blocks.length) return;

    // px per mm, measured rather than assumed at 96dpi — browser zoom and
    // fractional device pixel ratios both move this number.
    const rulerPx = ruler.getBoundingClientRect().height;
    if (rulerPx <= 0) return;
    const mmPerPx = 100 / rulerPx;

    // Available block height, measured from an empty sheet rather than computed
    // from the padding/header/footer constants. Those constants are nominal: the
    // real header and footer also carry their own padding and hairline borders,
    // so arithmetic over-budgets by a millimetre or two — enough for the last
    // block on a sheet to run past the bottom edge.
    //
    // clientHeight INCLUDES the body's own padding, which blocks cannot occupy,
    // so subtract it. Budgeting the padded height over-packs every sheet by
    // exactly that padding.
    const bodyStyle = window.getComputedStyle(probeBody);
    const bodyPadPx =
      (Number.parseFloat(bodyStyle.paddingTop) || 0) +
      (Number.parseFloat(bodyStyle.paddingBottom) || 0);
    // Keep a small reserve. Every height here is a sub-pixel measurement scaled
    // to mm, and a sheet that overflows by a rounding error clips real content
    // with nothing on the page to say so. A couple of millimetres of white space
    // is a much better trade.
    const SAFETY_MM = 2;
    const bodyMm = (probeBody.clientHeight - bodyPadPx) * mmPerPx - SAFETY_MM;
    const contentHeightMm = bodyMm > 10 ? bodyMm : contentH;

    const heights = new Map<ReportBlock, number>();
    const tables = new Map<ReportBlock, TableMetrics>();

    blockNodes.forEach((node, i) => {
      const tagged = blocks[i];
      if (!tagged) return;
      heights.set(tagged.block, node.getBoundingClientRect().height * mmPerPx);

      // Tables get per-row geometry, read off the rows we just rendered. A
      // uniform "representative row" underestimates wrapped cells (expense
      // notes, long vendor names) and overfills the sheet.
      if (tagged.block.kind !== 'table') return;
      const wrap = node.querySelector<HTMLElement>('.rpt-table-wrap');
      const thead = node.querySelector<HTMLElement>('thead');
      const caption = node.querySelector<HTMLElement>('.rpt-caption');
      const rows = node.querySelectorAll<HTMLElement>('tbody tr');
      // The wrapper's own bottom margin is per-chunk overhead: every continuation
      // renders its own wrapper. Leaving it out under-counts each table on a
      // sheet by ~3mm, which is exactly enough for two tables to push the last
      // rows off the bottom of the page.
      const wrapMarginPx = wrap
        ? Number.parseFloat(window.getComputedStyle(wrap).marginBottom) || 0
        : 0;
      tables.set(tagged.block, {
        headerMm:
          ((thead?.getBoundingClientRect().height ?? 0) +
            (caption?.getBoundingClientRect().height ?? 0) +
            wrapMarginPx) *
          mmPerPx,
        rowsMm: Array.from(rows, (r) => r.getBoundingClientRect().height * mmPerPx),
      });
    });

    const result = paginate(blocks, {
      contentHeightMm,
      // A block absent from the map cannot happen (we just filled it for every
      // entry), but falling back to a whole sheet is the safe direction: it
      // errs toward more pages, never toward clipped content.
      measure: (b) => heights.get(b) ?? contentHeightMm,
      tableMetrics: (b) =>
        tables.get(b) ?? {
          headerMm: 0,
          rowsMm: b.kind === 'table' ? b.rows.map(() => contentHeightMm) : [],
        },
    });

    setSheets(result.sheets);
    setOversized(result.oversized);
    setMeasuring(false);
  }, [blocks, contentH, contentW, geometry.density, fontsReady]);

  const probe = (
    <div
      ref={hostRef}
      aria-hidden="true"
      className={`rpt ${geometry.density === 'compact' ? 'rpt--compact' : ''}`}
      style={{
        position: 'absolute',
        top: 0,
        left: '-10000px',
        width: `${contentW}mm`,
        visibility: 'hidden',
        pointerEvents: 'none',
        contain: 'layout size',
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: REPORT_CSS }} />
      <div data-rpt-ruler style={{ height: '100mm' }} />
      {/* An empty sheet with real chrome. Its body's client height IS the space
          a page has for content, whatever the header/footer end up costing. */}
      <section
        className="rpt-sheet"
        data-rpt-probe-sheet
        style={{ width: `${sheetW}mm`, height: `${sheetH}mm`, padding: `${SHEET_PAD_MM}mm` }}
      >
        <header className="rpt-sheet__header" style={{ minHeight: `${SHEET_HEADER_MM}mm` }}>
          <span>
            <strong>probe</strong> · probe
          </span>
          <span>probe</span>
        </header>
        <div className="rpt-sheet__body" />
        <footer className="rpt-sheet__footer" style={{ minHeight: `${SHEET_FOOTER_MM}mm` }}>
          <span>probe</span>
          <span className="rpt-sheet__page">Page 1 of 1</span>
        </footer>
      </section>
      {blocks.map((b, i) => (
        // `flow-root` makes the wrapper a block-formatting context, so its
        // measured height CONTAINS the block's bottom margin. Without it
        // getBoundingClientRect excludes margins, every block measures a few mm
        // short, and the error accumulates until the last block on a sheet runs
        // past the bottom edge.
        <div data-rpt-block key={i} style={{ display: 'flow-root' }}>
          <Block block={b.block} />
        </div>
      ))}
    </div>
  );

  return { sheets, oversized, measuring, probe };
}
