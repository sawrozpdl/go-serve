// The report document — sheets, running chrome, cover page.
//
// Purely presentational: it receives already-paginated sheets (see useSheets) and
// draws them. Page numbers are rendered into each sheet's own footer rather than
// left to CSS, because Chrome does not support `@page` margin boxes — that is the
// specific reason the old export had no page numbers at all.

import { Block } from './blocks';
import { REPORT_CSS } from './reportCss';
import type { Sheet } from './paginate';
import { COVER_SECTION_ID, SHEET_FOOTER_MM, SHEET_HEADER_MM, SHEET_PAD_MM } from './types';
import { sheetSizeMm, type SheetGeometry } from './geometry';

/** Everything the letterhead and running chrome need. */
export type DocMeta = {
  cafeName: string;
  /** Multi-line address / PAN-VAT block, reusing the receipt header. */
  address?: string;
  /** Logo as a data URI — a blob URL will not survive into the print iframe. */
  logoDataUri?: string;
  title: string;
  /** The window the data actually covers, as echoed back by the API. */
  windowLabel?: string;
  /** What the user asked for, when it differs from the resolved window. */
  requestedLabel?: string;
  generatedAt: string;
  preparedBy?: string;
  timezone?: string;
  /** Section titles, in order, for the cover's table of contents. */
  contents: string[];
};

/**
 * Root wrapper. `variant` decides only the surrounding chrome — 'preview' adds
 * drop shadows and gaps between sheets, 'print' keeps them flush so one sheet
 * lands on exactly one page.
 */
export function ReportDocument({
  sheets,
  meta,
  geometry,
  variant = 'preview',
  includeStyles = true,
}: {
  sheets: Sheet[];
  meta: DocMeta;
  geometry: SheetGeometry;
  variant?: 'preview' | 'print';
  includeStyles?: boolean;
}) {
  const { w, h } = sheetSizeMm(geometry.paper, geometry.orientation);
  // The cover is sheet 1 when present, so it has to count toward "Page N of M".
  const total = sheets.length;

  return (
    <div className={`rpt ${geometry.density === 'compact' ? 'rpt--compact' : ''} rpt-${variant}`}>
      {includeStyles && <style dangerouslySetInnerHTML={{ __html: REPORT_CSS }} />}
      {sheets.map((sheet, i) => (
        <SheetView
          key={i}
          sheet={sheet}
          meta={meta}
          page={i + 1}
          total={total}
          widthMm={w}
          heightMm={h}
        />
      ))}
    </div>
  );
}

function SheetView({
  sheet,
  meta,
  page,
  total,
  widthMm,
  heightMm,
}: {
  sheet: Sheet;
  meta: DocMeta;
  page: number;
  total: number;
  widthMm: number;
  heightMm: number;
}) {
  const isCover = sheet.blocks.length === 1 && sheet.blocks[0]?.sectionId === COVER_SECTION_ID;

  return (
    <section
      className="rpt-sheet"
      style={{ width: `${widthMm}mm`, height: `${heightMm}mm`, padding: `${SHEET_PAD_MM}mm` }}
    >
      {isCover ? (
        <CoverBody meta={meta} />
      ) : (
        <>
          <header className="rpt-sheet__header" style={{ minHeight: `${SHEET_HEADER_MM}mm` }}>
            <span>
              <strong>{meta.cafeName}</strong> · {meta.title}
            </span>
            <span>{meta.windowLabel ?? meta.requestedLabel ?? ''}</span>
          </header>
          <div className="rpt-sheet__body">
            {sheet.blocks.map((b, i) => (
              <Block key={i} block={b.block} />
            ))}
          </div>
          <footer className="rpt-sheet__footer" style={{ minHeight: `${SHEET_FOOTER_MM}mm` }}>
            <span>Generated {meta.generatedAt}</span>
            <span className="rpt-sheet__page">
              Page {page} of {total}
            </span>
          </footer>
        </>
      )}
    </section>
  );
}

/** Full-bleed cover: letterhead, title, the window, provenance, contents. */
function CoverBody({ meta }: { meta: DocMeta }) {
  return (
    <div className="rpt-cover">
      <div className="rpt-cover__top">
        {meta.logoDataUri && <img className="rpt-cover__logo" src={meta.logoDataUri} alt="" />}
        <div>
          <div className="rpt-cover__cafe">{meta.cafeName}</div>
          {meta.address && <div className="rpt-cover__addr">{meta.address}</div>}
        </div>
      </div>

      <div className="rpt-cover__mid">
        <div className="rpt-cover__kicker">Report</div>
        <div className="rpt-cover__title">{meta.title}</div>
        {meta.windowLabel && <div className="rpt-cover__window">{meta.windowLabel}</div>}
        <div className="rpt-cover__rule" />
        <div className="rpt-cover__meta">
          <dl>
            {/* Only worth stating when it differs from the resolved window —
                otherwise it reads as the same fact twice. */}
            {meta.requestedLabel && meta.requestedLabel !== meta.windowLabel && (
              <>
                <dt>Period requested</dt>
                <dd>{meta.requestedLabel}</dd>
              </>
            )}
            <dt>Generated</dt>
            <dd>{meta.generatedAt}</dd>
            {meta.preparedBy && (
              <>
                <dt>Prepared by</dt>
                <dd>{meta.preparedBy}</dd>
              </>
            )}
            {meta.timezone && (
              <>
                <dt>Timezone</dt>
                <dd>{meta.timezone}</dd>
              </>
            )}
          </dl>
        </div>
      </div>

      {meta.contents.length > 0 && (
        <div className="rpt-cover__contents">
          <div className="rpt-cover__contents-h">Contents</div>
          <ol>
            {meta.contents.map((c, i) => (
              <li key={`${c}-${i}`}>{c}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
