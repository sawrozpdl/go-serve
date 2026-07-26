import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileText,
  LayoutTemplate,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  Printer,
  Save,
  Trash2,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

import { useMe, useTenantSettings, useUpdateTenant } from '@/lib/api';
import { DatePicker } from '@/components/DatePicker';
import { Modal } from '@/components/Modal';
import { PageShell } from '@/components/PageShell';
import { SearchSelect } from '@/components/SearchSelect';
import { todayIso } from '@/lib/dates';

import { ReportDocument, type DocMeta } from '@/reports/ReportDocument';
import { coverBlock, defaultTitle, filtersBlocks, methodologyBlocks } from '@/reports/framing';
import { generatedStamp } from '@/reports/format';
import { sheetSizeMm } from '@/reports/geometry';
import { printReport, reportFilename, toDataUri } from '@/reports/print';
import {
  DEFAULT_TOP_N,
  TEMPLATES,
  fromSavedPreset,
  specFromTemplate,
  toSavedPreset,
  type SavedPreset,
} from '@/reports/presets';
import {
  RANGE_PRESETS,
  parseRange,
  rangeLabel,
  rangeReady,
  recentMonths,
  monthLabel,
  resolvedWindowLabel,
  type ReportRange,
} from '@/reports/range';
import { ALL_SECTIONS } from '@/reports/registry';
import { SECTION_GROUPS, visibleSections, type AnySection } from '@/reports/section';
import { PAPER_MM, type DetailLevel, type ReportSpec, type TaggedBlock } from '@/reports/types';
import { selectedSections, useReportData } from '@/reports/useReportData';
import { useSheets } from '@/reports/useSheets';
import { MAX_ZOOM, MIN_ZOOM, fitZoom, stepZoom, zoomLabel } from '@/reports/zoom';

/**
 * The report builder.
 *
 * Two panes: compose on the left, see the actual document on the right. The
 * preview is not an approximation — it is the same paginated DOM that gets
 * serialized into the print iframe, so the page count and every break shown here
 * is what comes out of the printer.
 *
 * Layout: the shell opts into `page-shell--fill`, so the page body does NOT
 * scroll. The rail and the document each own their scroll instead. Before that,
 * a 2,100px rail dragged the whole body into one long scroll and the preview
 * pane — pinned short by `align-items: start` — slid out of view the moment you
 * touched a control, with a second scroller nested inside it fighting for the
 * wheel. Both panes are now always on screen, and the rail's groups collapse so
 * it stays short enough to take in at a glance.
 */
export function ReportBuilderPage() {
  const [params, setParams] = useSearchParams();
  const me = useMe();
  const tenant = useTenantSettings();
  const savePrefs = useUpdateTenant();

  const allowed = useMemo(() => visibleSections(me.data, ALL_SECTIONS), [me.data]);

  // Deep links from a report page arrive as ?template=…&range=…&from=&to=.
  const [templateKey, setTemplateKey] = useState(() => params.get('template') || 'monthly_pl');
  const [spec, setSpec] = useState<ReportSpec>(() => {
    const t =
      TEMPLATES.find((x) => x.key === (params.get('template') || 'monthly_pl')) ?? TEMPLATES[0]!;
    const deepRange = params.has('range') || params.has('from') ? parseRange(params) : undefined;
    return specFromTemplate(t, deepRange);
  });

  // Drop the query string once consumed so a later edit isn't re-overwritten by
  // a stale deep link on re-render.
  useEffect(() => {
    if (params.has('template') || params.has('range') || params.has('from'))
      setParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sections = useMemo(() => selectedSections(spec, allowed), [spec, allowed]);
  const report = useReportData(spec, sections);

  const cafeName = tenant.data?.branding?.cafeName || tenant.data?.name || 'GoServe';
  const [logo, setLogo] = useState<string | undefined>();
  useEffect(() => {
    let live = true;
    // Must be a data URI: the print iframe is a separate document and cannot
    // resolve a blob: or cookie-authed URL from this one.
    toDataUri(tenant.data?.branding?.logoUrl).then((d) => {
      if (live) setLogo(d);
    });
    return () => {
      live = false;
    };
  }, [tenant.data?.branding?.logoUrl]);

  // The tenant timezone is required: the analytics endpoints return tenant-local
  // midnights as UTC instants, so the calendar day has to be read in that zone.
  const reportTz = report.window.timezone ?? tenant.data?.timezone;
  const windowLabel = resolvedWindowLabel(report.window.from, report.window.to, reportTz);
  const meta: DocMeta = {
    cafeName,
    address: tenant.data?.preferences?.receiptHeader || undefined,
    logoDataUri: logo,
    title: spec.title,
    windowLabel,
    requestedLabel: rangeLabel(spec.range),
    generatedAt: generatedStamp(),
    preparedBy: me.data?.email,
    timezone: reportTz,
    contents: sections.map((s) => s.label),
  };

  // Assemble the full block list: cover, disclosure, sections, methodology.
  const blocks: TaggedBlock[] = useMemo(() => {
    const out: TaggedBlock[] = [];
    if (spec.cover) {
      out.push(coverBlock());
      out.push({ sectionId: '__about__', block: { kind: 'pagebreak' } });
    }
    if (sections.length > 0) {
      for (const b of filtersBlocks({
        spec,
        sections,
        resolvedFrom: report.window.from,
        resolvedTo: report.window.to,
        timezone: meta.timezone,
      })) {
        out.push({ sectionId: '__about__', block: b });
      }
      out.push({ sectionId: '__about__', block: { kind: 'pagebreak' } });
    }
    out.push(...report.blocks);
    if (spec.methodology) {
      for (const b of methodologyBlocks(sections)) out.push({ sectionId: '__method__', block: b });
    }
    return out;
  }, [spec, sections, report.blocks, report.window.from, report.window.to, meta.timezone]);

  const { sheets, oversized, measuring, probe } = useSheets(blocks, {
    paper: spec.paper,
    orientation: spec.orientation,
    density: spec.density,
  });

  const docRef = useRef<HTMLDivElement>(null);
  const ready = rangeReady(spec.range) && sections.length > 0 && !report.isLoading && !measuring;

  const onPrint = () => {
    const root = docRef.current?.querySelector<HTMLElement>('.rpt');
    if (!root) return;
    printReport({
      root,
      filename: reportFilename(cafeName, spec.title, windowLabel ?? rangeLabel(spec.range)),
      paper: spec.paper,
      orientation: spec.orientation,
    });
  };

  const applyTemplate = (key: string) => {
    const t = TEMPLATES.find((x) => x.key === key);
    if (!t) return;
    setTemplateKey(key);
    // Keep the range the user already picked — switching template shouldn't
    // silently move them back to last month.
    setSpec(specFromTemplate(t, t.range ?? spec.range));
  };

  const patch = (p: Partial<ReportSpec>) => setSpec((s) => ({ ...s, ...p }));

  const toggleSection = (id: string) => {
    setSpec((s) => {
      const has = s.sections.some((x) => x.id === id);
      if (has) return { ...s, sections: s.sections.filter((x) => x.id !== id) };
      const section = allowed.find((x) => x.id === id);
      return {
        ...s,
        sections: [
          ...s.sections,
          { id, detail: section?.defaultDetail ?? 'full', topN: DEFAULT_TOP_N },
        ],
      };
    });
  };

  const moveSection = (id: string, delta: -1 | 1) => {
    setSpec((s) => {
      const i = s.sections.findIndex((x) => x.id === id);
      const j = i + delta;
      if (i < 0 || j < 0 || j >= s.sections.length) return s;
      const next = [...s.sections];
      const a = next[i]!;
      next[i] = next[j]!;
      next[j] = a;
      return { ...s, sections: next };
    });
  };

  const setDetail = (id: string, detail: DetailLevel) =>
    setSpec((s) => ({
      ...s,
      sections: s.sections.map((x) => (x.id === id ? { ...x, detail } : x)),
    }));

  const setTopN = (id: string, topN: number) =>
    setSpec((s) => ({
      ...s,
      sections: s.sections.map((x) => (x.id === id ? { ...x, topN } : x)),
    }));

  // Saved presets live in the tenant preferences blob — no migration needed.
  const saved: SavedPreset[] = (tenant.data?.preferences?.reportPresets ?? []) as SavedPreset[];
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);

  const commitPreset = (name: string) => {
    const clean = name.trim();
    if (!clean) return;
    const next = [...saved.filter((p) => p.name !== clean), toSavedPreset(clean, spec)];
    savePrefs.mutate({ preferences: { reportPresets: next } });
    setSaveOpen(false);
  };
  const deletePreset = (name: string) =>
    savePrefs.mutate({ preferences: { reportPresets: saved.filter((p) => p.name !== name) } });

  const activeTemplate = TEMPLATES.find((t) => t.key === templateKey);
  const templateName = activeTemplate?.name ?? 'Custom layout';

  // One rail group open at a time: the whole point is that the rail stays short.
  // Period first — it's the control most likely to be wrong on arrival.
  const [openGroup, setOpenGroup] = useState<RailGroupId>('period');
  const toggleGroup = (id: RailGroupId) => setOpenGroup((cur) => (cur === id ? null : id));

  return (
    <PageShell
      className="page-shell--fill rb-shell"
      eyebrow="report builder"
      title="Build a report"
      subtitle="Choose what goes in, see the exact pages, then save as PDF."
      actions={
        <div className="rb-actions">
          <button
            type="button"
            className="btn"
            onClick={() => setSaveOpen(true)}
            disabled={sections.length === 0}
          >
            <Save size={14} strokeWidth={1.6} /> Save layout
          </button>
          <button type="button" className="btn primary" onClick={onPrint} disabled={!ready}>
            {ready ? (
              <Printer size={14} strokeWidth={1.6} />
            ) : (
              <Loader2 size={14} className="spin" />
            )}
            Export PDF
          </button>
        </div>
      }
    >
      <div className="rb">
        {/* ---------------- left rail: compose ---------------- */}
        <div className="rb-rail">
          {/* The template used to be nine 68px cards pinned open — a third of the
              rail before you reached anything you'd actually change. */}
          <div className="rb-template-row">
            <span className="rb-template-row__meta">
              <span className="rb-template-row__label">Template</span>
              <span className="rb-template-row__name">{templateName}</span>
            </span>
            <button type="button" className="btn" onClick={() => setPickerOpen(true)}>
              <LayoutTemplate size={13} strokeWidth={1.6} /> Change
            </button>
          </div>

          <RailGroup
            id="period"
            title="Period"
            summary={rangeLabel(spec.range)}
            open={openGroup === 'period'}
            onToggle={toggleGroup}
          >
            <RangeControl range={spec.range} onChange={(range) => patch({ range })} />
            {!rangeReady(spec.range) && (
              <div className="rb-hint warn">Pick both dates to build the report.</div>
            )}
          </RailGroup>

          <RailGroup
            id="sections"
            title="Sections"
            summary={`${sections.length} selected`}
            open={openGroup === 'sections'}
            onToggle={toggleGroup}
          >
            <SectionPicker
              allowed={allowed}
              spec={spec}
              results={report.results}
              onToggle={toggleSection}
              onMove={moveSection}
              onDetail={setDetail}
              onTopN={setTopN}
            />
          </RailGroup>

          <RailGroup
            id="setup"
            title="Page setup"
            summary={`${PAPER_MM[spec.paper].label} ${spec.orientation} · ${spec.density}`}
            open={openGroup === 'setup'}
            onToggle={toggleGroup}
          >
            <div className="rb-field">
              <span>Report title</span>
              <input
                value={spec.title}
                onChange={(e) => patch({ title: e.target.value })}
                placeholder={defaultTitle(spec.range)}
              />
            </div>
            <div className="rb-field">
              <span>Paper</span>
              <div className="rb-segment">
                {(['a4', 'letter', 'legal'] as const).map((p) => (
                  <button
                    type="button"
                    key={p}
                    className={spec.paper === p ? 'active' : ''}
                    onClick={() => patch({ paper: p })}
                  >
                    {PAPER_MM[p].label}
                  </button>
                ))}
              </div>
            </div>
            <div className="rb-field">
              <span>Orientation</span>
              <div className="rb-segment">
                {(['portrait', 'landscape'] as const).map((o) => (
                  <button
                    type="button"
                    key={o}
                    className={spec.orientation === o ? 'active' : ''}
                    onClick={() => patch({ orientation: o })}
                  >
                    {o === 'portrait' ? 'Portrait' : 'Landscape'}
                  </button>
                ))}
              </div>
            </div>
            <div className="rb-field">
              <span>Density</span>
              <div className="rb-segment">
                {(['comfortable', 'compact'] as const).map((d) => (
                  <button
                    type="button"
                    key={d}
                    className={spec.density === d ? 'active' : ''}
                    onClick={() => patch({ density: d })}
                  >
                    {d === 'comfortable' ? 'Comfortable' : 'Compact'}
                  </button>
                ))}
              </div>
            </div>
          </RailGroup>

          <RailGroup
            id="include"
            title="Include"
            summary={includeSummary(spec)}
            open={openGroup === 'include'}
            onToggle={toggleGroup}
          >
            <Check
              label="Cover page"
              hint="Letterhead, period and contents on page 1."
              checked={spec.cover}
              onChange={(v) => patch({ cover: v })}
            />
            <Check
              label="Compare with previous period"
              hint="Adds a change column wherever a section supports it."
              checked={spec.compare}
              onChange={(v) => patch({ compare: v })}
            />
            <Check
              label="Explain the numbers"
              hint="Appendix defining every figure used."
              checked={spec.methodology}
              onChange={(v) => patch({ methodology: v })}
            />
            <Check
              label="Keep empty sections"
              hint="Otherwise a section with no data is left out."
              checked={spec.includeEmpty}
              onChange={(v) => patch({ includeEmpty: v })}
            />
          </RailGroup>
        </div>

        {/* ---------------- right pane: the document ---------------- */}
        <PreviewPane
          docRef={docRef}
          sheetCount={sheets.length}
          paperLabel={PAPER_MM[spec.paper].label}
          orientation={spec.orientation}
          sheetWidthMm={sheetSizeMm(spec.paper, spec.orientation).w}
          windowLabel={windowLabel}
          busy={measuring || report.isLoading}
          loadedCount={report.loadedCount}
          totalCount={report.totalCount}
          errors={report.errors}
          oversized={oversized}
          empty={sections.length === 0}
        >
          <ReportDocument sheets={sheets} meta={meta} geometry={spec} variant="preview" />
        </PreviewPane>
      </div>

      <TemplatePickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        activeKey={templateKey}
        saved={saved}
        onPick={(key) => {
          applyTemplate(key);
          setPickerOpen(false);
        }}
        onUseSaved={(p) => {
          setTemplateKey('custom');
          setSpec(fromSavedPreset(p, spec.range));
          setPickerOpen(false);
        }}
        onDeleteSaved={deletePreset}
      />

      <SaveLayoutModal
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        defaultName={spec.title}
        existing={saved.map((p) => p.name)}
        onSave={commitPreset}
      />

      {/* Offscreen measuring pass — invisible, drives pagination. */}
      {probe}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------
// Preview pane — the document, plus the chrome for reading it.
// ---------------------------------------------------------------------------

function PreviewPane({
  docRef,
  sheetCount,
  paperLabel,
  orientation,
  sheetWidthMm,
  windowLabel,
  busy,
  loadedCount,
  totalCount,
  errors,
  oversized,
  empty,
  children,
}: {
  docRef: React.RefObject<HTMLDivElement>;
  sheetCount: number;
  paperLabel: string;
  orientation: string;
  sheetWidthMm: number;
  windowLabel?: string;
  busy: boolean;
  loadedCount: number;
  totalCount: number;
  errors: { label: string }[];
  oversized: number;
  empty: boolean;
  children: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0.8);
  const [page, setPage] = useState(1);

  const fit = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Leave the gutter the sheet stack's own padding occupies, or "fit" would
    // put the page flush against the scrollbar.
    setZoom(fitZoom(el.clientWidth - 32, sheetWidthMm));
  }, [sheetWidthMm]);

  // Fit once the pane has a width, and again whenever the paper geometry changes
  // — switching to landscape at 100% would otherwise leave the page half
  // off-screen with no hint that zooming out is what's needed.
  useLayoutEffect(() => {
    fit();
  }, [fit]);

  // Track which sheet is in view so the page counter means something on a
  // 10-page document. Cheap: one observer over the sheets, rooted on the
  // scroller, no scroll handler.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || empty) return;
    const sheetEls = root.querySelectorAll<HTMLElement>('.rpt-sheet');
    if (sheetEls.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        // The topmost sheet with any meaningful visibility wins; comparing
        // intersectionRatio alone flickers between two half-visible pages.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0]?.target as HTMLElement | undefined;
        if (!first) return;
        const idx = [...sheetEls].indexOf(first);
        if (idx >= 0) setPage(idx + 1);
      },
      { root, threshold: [0.1, 0.5] },
    );
    sheetEls.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [sheetCount, empty, zoom]);

  const goToPage = (n: number) => {
    const root = scrollRef.current;
    if (!root) return;
    const target = root.querySelectorAll<HTMLElement>('.rpt-sheet')[n - 1];
    if (!target) return;
    target.scrollIntoView({ block: 'start', behavior: 'smooth' });
    setPage(n);
  };

  return (
    <div className="rb-preview">
      <div className="rb-preview__bar">
        <span className="rb-preview__count">
          {busy ? (
            <>
              <Loader2 size={12} className="spin" /> Building
              {totalCount > 0 && ` — ${loadedCount} of ${totalCount} sections`}
            </>
          ) : (
            <>
              <strong>{sheetCount}</strong> {sheetCount === 1 ? 'page' : 'pages'} · {paperLabel}{' '}
              {orientation}
            </>
          )}
        </span>

        {!empty && (
          <div className="rb-preview__tools">
            <div className="rb-zoomctl" role="group" aria-label="Zoom">
              <button
                type="button"
                aria-label="Zoom out"
                disabled={zoom <= MIN_ZOOM}
                onClick={() => setZoom((z) => stepZoom(z, -1))}
              >
                <Minus size={12} strokeWidth={1.8} />
              </button>
              <span className="rb-zoomctl__val">{zoomLabel(zoom)}</span>
              <button
                type="button"
                aria-label="Zoom in"
                disabled={zoom >= MAX_ZOOM}
                onClick={() => setZoom((z) => stepZoom(z, 1))}
              >
                <Plus size={12} strokeWidth={1.8} />
              </button>
              <button type="button" aria-label="Fit page to width" onClick={fit}>
                <Maximize2 size={12} strokeWidth={1.7} />
              </button>
            </div>

            <div className="rb-pagenav" role="group" aria-label="Pages">
              <button
                type="button"
                aria-label="Previous page"
                disabled={page <= 1}
                onClick={() => goToPage(page - 1)}
              >
                <ChevronLeft size={13} strokeWidth={1.8} />
              </button>
              <span className="rb-pagenav__val">
                {page} / {sheetCount || 1}
              </span>
              <button
                type="button"
                aria-label="Next page"
                disabled={page >= sheetCount}
                onClick={() => goToPage(page + 1)}
              >
                <ChevronRight size={13} strokeWidth={1.8} />
              </button>
            </div>
          </div>
        )}

        {windowLabel && <span className="rb-preview__window">{windowLabel}</span>}
      </div>

      {(errors.length > 0 || oversized > 0) && (
        <div className="rb-preview__alerts">
          {errors.length > 0 && (
            <div className="rb-errors">
              <AlertTriangle size={13} strokeWidth={1.6} />
              <span>
                {errors.length} section{errors.length === 1 ? '' : 's'} failed to load and{' '}
                {errors.length === 1 ? 'is' : 'are'} marked in the document:{' '}
                {errors.map((e) => e.label).join(', ')}.
              </span>
            </div>
          )}
          {oversized > 0 && (
            <div className="rb-errors">
              <AlertTriangle size={13} strokeWidth={1.6} />
              <span>
                {oversized} block{oversized === 1 ? '' : 's'} {oversized === 1 ? 'is' : 'are'}{' '}
                taller than one page and may be clipped. Try landscape or compact density.
              </span>
            </div>
          )}
        </div>
      )}

      {empty ? (
        <div className="rb-empty">
          <FileText size={22} strokeWidth={1.4} />
          <p>Pick a template on the left, or choose sections to build your own report.</p>
        </div>
      ) : (
        <div className="rb-doc" ref={scrollRef}>
          {/* The zoom lives HERE, on a wrapper outside `.rpt`. printReport()
              clones `.rpt` and serializes its outerHTML, so a scale set on the
              document itself would follow it into the print iframe and shrink
              the actual PDF. `zoom` rather than `transform` because it
              participates in layout — a transform leaves the scroll container
              measuring the unscaled box, which is what made this pane feel
              broken before. */}
          <div className="rb-zoom" style={{ zoom }} ref={docRef}>
            {children}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rail scaffolding
// ---------------------------------------------------------------------------

type RailGroupId = 'period' | 'sections' | 'setup' | 'include' | null;

/** A collapsible rail group. Controlled rather than using the shared
 *  <Collapsible>, which only takes `defaultOpen` — single-open accordion
 *  behaviour needs the parent to own which one is expanded. */
function RailGroup({
  id,
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  id: Exclude<RailGroupId, null>;
  title: string;
  /** Shown in the header while collapsed, so the rail is readable closed. */
  summary?: string;
  open: boolean;
  onToggle: (id: Exclude<RailGroupId, null>) => void;
  children: React.ReactNode;
}) {
  return (
    <section className={`rb-group ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="rb-group__h"
        aria-expanded={open}
        onClick={() => onToggle(id)}
      >
        <ChevronRight size={13} strokeWidth={1.9} className="rb-group__chev" aria-hidden />
        <span className="rb-group__title">{title}</span>
        {summary && <span className="rb-group__sum">{summary}</span>}
      </button>
      {open && <div className="rb-group__body">{children}</div>}
    </section>
  );
}

function includeSummary(spec: ReportSpec): string {
  const on = [
    spec.cover && 'cover',
    spec.compare && 'comparison',
    spec.methodology && 'definitions',
    spec.includeEmpty && 'empty sections',
  ].filter(Boolean) as string[];
  return on.length ? on.join(', ') : 'nothing extra';
}

function Check({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="rb-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="rb-check__l">{label}</span>
        {hint && <span className="rb-check__h">{hint}</span>}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function TemplatePickerModal({
  open,
  onClose,
  activeKey,
  saved,
  onPick,
  onUseSaved,
  onDeleteSaved,
}: {
  open: boolean;
  onClose: () => void;
  activeKey: string;
  saved: SavedPreset[];
  onPick: (key: string) => void;
  onUseSaved: (p: SavedPreset) => void;
  onDeleteSaved: (name: string) => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="wide"
      title="Start from a template"
      subtitle="A template picks the sections and their order. You can change anything afterwards."
    >
      <div className="rb-tplgrid">
        {TEMPLATES.map((t) => (
          <button
            type="button"
            key={t.key}
            className={`rb-template ${activeKey === t.key ? 'active' : ''}`}
            onClick={() => onPick(t.key)}
          >
            <span className="rb-template__name">{t.name}</span>
            <span className="rb-template__desc">{t.description}</span>
          </button>
        ))}
      </div>

      {saved.length > 0 && (
        <>
          <div className="rb-sub">Your saved layouts</div>
          <div className="rb-saved">
            {saved.map((p) => (
              <div className="rb-saved__row" key={p.name}>
                <button type="button" className="rb-saved__use" onClick={() => onUseSaved(p)}>
                  <FileText size={12} strokeWidth={1.6} /> {p.name}
                </button>
                <button
                  type="button"
                  className="btn icon"
                  aria-label={`Delete ${p.name}`}
                  onClick={() => onDeleteSaved(p.name)}
                >
                  <Trash2 size={12} strokeWidth={1.6} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}

/** Naming a saved layout. Was a `window.prompt`, which is unstyled, unthemed and
 *  can't warn that a name is about to overwrite an existing layout. */
function SaveLayoutModal({
  open,
  onClose,
  defaultName,
  existing,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  defaultName: string;
  existing: string[];
  onSave: (name: string) => void;
}) {
  const [name, setName] = useState(defaultName);
  // Reopening with a different report should offer that report's title, not
  // whatever was typed last time.
  useEffect(() => {
    if (open) setName(defaultName);
  }, [open, defaultName]);

  const clean = name.trim();
  const overwrites = existing.includes(clean);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save this layout"
      subtitle="Saved layouts appear in the template picker."
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!clean}
            onClick={() => onSave(clean)}
          >
            <Save size={14} strokeWidth={1.6} /> {overwrites ? 'Replace' : 'Save'}
          </button>
        </>
      }
    >
      <form
        className="rb-field"
        onSubmit={(e) => {
          e.preventDefault();
          if (clean) onSave(clean);
        }}
      >
        <span>Layout name</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Monthly board pack"
        />
        {overwrites && (
          <span className="rb-hint warn">A layout called “{clean}” will be replaced.</span>
        )}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Range control — one control for all the shapes a report period can take.
// ---------------------------------------------------------------------------

function RangeControl({
  range,
  onChange,
}: {
  range: ReportRange;
  onChange: (r: ReportRange) => void;
}) {
  // SearchSelect rather than a native <select>: the global
  // `select option { padding }` rule inflates the OS-drawn popup into something
  // enormous, and it can't be themed. This is the same combo-box Settings,
  // History and the discount/void modals already use.
  const monthOptions = useMemo(
    () => recentMonths(12).map((m) => ({ value: m, label: monthLabel(m) })),
    [],
  );
  return (
    <>
      <div className="rb-chips">
        {RANGE_PRESETS.map((p) => (
          <button
            type="button"
            key={p.value}
            className={`chip ${range.kind === 'preset' && range.preset === p.value ? 'active' : ''}`}
            onClick={() => onChange({ kind: 'preset', preset: p.value })}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="rb-field">
        <span>Whole month</span>
        <SearchSelect
          options={monthOptions}
          value={range.kind === 'month' ? range.month : ''}
          placeholder="choose a month…"
          onChange={(month) => month && onChange({ kind: 'month', month })}
        />
      </div>
      <div className="rb-field">
        <span>Exact dates</span>
        <div className="rb-dates">
          <DatePicker
            value={range.kind === 'custom' ? range.from : ''}
            max={range.kind === 'custom' && range.to ? range.to : todayIso()}
            onChange={(from) =>
              onChange({ kind: 'custom', from, to: range.kind === 'custom' ? range.to : from })
            }
          />
          <span className="rb-dates__sep">to</span>
          <DatePicker
            value={range.kind === 'custom' ? range.to : ''}
            min={range.kind === 'custom' ? range.from : undefined}
            max={todayIso()}
            onChange={(to) =>
              onChange({ kind: 'custom', from: range.kind === 'custom' ? range.from : to, to })
            }
          />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Section picker
// ---------------------------------------------------------------------------

const DETAIL_LABELS: Record<DetailLevel, string> = {
  summary: 'Summary',
  topN: 'Top rows',
  full: 'Everything',
};

const TOP_N_MIN = 1;
const TOP_N_MAX = 5000;

/** Row-count stepper. A bare `type="number"` renders a different spinner in every
 *  browser and is fiddly at this size; explicit −/+ buttons are predictable, and
 *  the text input still allows typing a big number directly. */
function RowCount({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const clamp = (n: number) => Math.min(TOP_N_MAX, Math.max(TOP_N_MIN, n));
  const bump = (delta: number) => onChange(clamp(value + delta));
  return (
    <div className="rb-topn">
      <span>rows</span>
      <div className="rb-stepper">
        <button
          type="button"
          aria-label="Fewer rows"
          disabled={value <= TOP_N_MIN}
          onClick={() => bump(-5)}
        >
          <Minus size={11} strokeWidth={2} />
        </button>
        <input
          type="text"
          inputMode="numeric"
          aria-label="Rows to include"
          value={value}
          onChange={(e) => {
            const digits = e.target.value.replace(/[^0-9]/g, '');
            onChange(digits ? clamp(Number(digits)) : TOP_N_MIN);
          }}
        />
        <button
          type="button"
          aria-label="More rows"
          disabled={value >= TOP_N_MAX}
          onClick={() => bump(5)}
        >
          <Plus size={11} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

function SectionPicker({
  allowed,
  spec,
  results,
  onToggle,
  onMove,
  onDetail,
  onTopN,
}: {
  allowed: AnySection[];
  spec: ReportSpec;
  results: { section: AnySection; rowCount: number; isLoading: boolean; error?: Error }[];
  onToggle: (id: string) => void;
  onMove: (id: string, delta: -1 | 1) => void;
  onDetail: (id: string, detail: DetailLevel) => void;
  onTopN: (id: string, n: number) => void;
}) {
  const resultById = new Map(results.map((r) => [r.section.id, r]));
  const chosen = new Map(spec.sections.map((s, i) => [s.id, { sel: s, order: i }]));

  return (
    <div className="rb-sections">
      {SECTION_GROUPS.map((group) => {
        const inGroup = allowed.filter((s) => s.group === group);
        if (inGroup.length === 0) return null;
        return (
          <div className="rb-secgroup" key={group}>
            <div className="rb-sub">{group}</div>
            {inGroup.map((s) => {
              const entry = chosen.get(s.id);
              const on = !!entry;
              const res = resultById.get(s.id);
              return (
                <div className={`rb-sec ${on ? 'on' : ''}`} key={s.id}>
                  <label className="rb-sec__head">
                    <input type="checkbox" checked={on} onChange={() => onToggle(s.id)} />
                    <span className="rb-sec__body">
                      <span className="rb-sec__name">
                        {s.label}
                        {!s.needsRange && <span className="rb-tag">snapshot</span>}
                        {s.prefersLandscape && <span className="rb-tag">wide</span>}
                      </span>
                      <span className="rb-sec__desc">{s.description}</span>
                      {on && res && (
                        <span className="rb-sec__meta">
                          {res.isLoading
                            ? 'loading…'
                            : res.error
                              ? `failed: ${res.error.message}`
                              : `${res.rowCount.toLocaleString('en-IN')} row${res.rowCount === 1 ? '' : 's'}`}
                        </span>
                      )}
                    </span>
                  </label>

                  {on && entry && (
                    <div className="rb-sec__ctl">
                      {/* Reordering, because the document order is the reading
                          order and a P&L wants its summary first. */}
                      <div className="rb-order">
                        <button
                          type="button"
                          className="btn icon"
                          aria-label={`Move ${s.label} earlier`}
                          disabled={entry.order === 0}
                          onClick={() => onMove(s.id, -1)}
                        >
                          <ChevronUp size={12} strokeWidth={1.6} />
                        </button>
                        <button
                          type="button"
                          className="btn icon"
                          aria-label={`Move ${s.label} later`}
                          disabled={entry.order === spec.sections.length - 1}
                          onClick={() => onMove(s.id, 1)}
                        >
                          <ChevronDown size={12} strokeWidth={1.6} />
                        </button>
                      </div>

                      {s.detailLevels.length > 1 && (
                        <div className="rb-segment small">
                          {s.detailLevels.map((d) => (
                            <button
                              type="button"
                              key={d}
                              className={entry.sel.detail === d ? 'active' : ''}
                              onClick={() => onDetail(s.id, d)}
                            >
                              {DETAIL_LABELS[d]}
                            </button>
                          ))}
                        </div>
                      )}

                      {entry.sel.detail === 'topN' && (
                        <RowCount value={entry.sel.topN} onChange={(n) => onTopN(s.id, n)} />
                      )}

                      {/* The honest warning: how long this actually gets. A
                          4,000-row table is ~80 pages and the user should learn
                          that here, not from the print dialog. */}
                      {res &&
                        !res.isLoading &&
                        entry.sel.detail === 'full' &&
                        res.rowCount > 400 && (
                          <span className="rb-hint warn">
                            {res.rowCount.toLocaleString('en-IN')} rows — roughly{' '}
                            {Math.max(1, Math.ceil(res.rowCount / 45))} pages. Consider “Top rows”.
                          </span>
                        )}
                      {res &&
                        !res.isLoading &&
                        entry.sel.detail === 'topN' &&
                        res.rowCount > entry.sel.topN && (
                          <span className="rb-hint">
                            {(res.rowCount - entry.sel.topN).toLocaleString('en-IN')} rows will be
                            left out — the report says so on the page.
                          </span>
                        )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
