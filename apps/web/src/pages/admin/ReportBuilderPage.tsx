import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  FileText,
  Loader2,
  Printer,
  Save,
  Trash2,
} from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

import { useMe, useTenantSettings, useUpdateTenant } from '@/lib/api';
import { DatePicker } from '@/components/DatePicker';
import { PageShell } from '@/components/PageShell';
import { todayIso } from '@/lib/dates';

import { ReportDocument, type DocMeta } from '@/reports/ReportDocument';
import { coverBlock, defaultTitle, filtersBlocks, methodologyBlocks } from '@/reports/framing';
import { generatedStamp } from '@/reports/format';
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

/**
 * The report builder.
 *
 * Two panes: compose on the left, see the actual document on the right. The
 * preview is not an approximation — it is the same paginated DOM that gets
 * serialized into the print iframe, so the page count and every break shown here
 * is what comes out of the printer.
 *
 * That is the whole point of the rework. The old export printed the live app
 * screen, so what you got was a surprise: cut-off tables, missing tabs, and
 * whatever a server LIMIT happened to have returned.
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
  const savePreset = () => {
    const name = window.prompt('Save this report layout as:', spec.title);
    if (!name?.trim()) return;
    const next = [...saved.filter((p) => p.name !== name.trim()), toSavedPreset(name.trim(), spec)];
    savePrefs.mutate({ preferences: { reportPresets: next } });
  };
  const deletePreset = (name: string) =>
    savePrefs.mutate({ preferences: { reportPresets: saved.filter((p) => p.name !== name) } });

  return (
    <PageShell
      eyebrow="report builder"
      title="Build a report"
      subtitle="Choose what goes in, see the exact pages, then save as PDF."
      actions={
        <div className="rb-actions">
          <button
            type="button"
            className="btn"
            onClick={savePreset}
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
          <RailGroup title="Start from">
            <div className="rb-templates">
              {TEMPLATES.map((t) => (
                <button
                  type="button"
                  key={t.key}
                  className={`rb-template ${templateKey === t.key ? 'active' : ''}`}
                  onClick={() => applyTemplate(t.key)}
                >
                  <span className="rb-template__name">{t.name}</span>
                  <span className="rb-template__desc">{t.description}</span>
                </button>
              ))}
            </div>
            {saved.length > 0 && (
              <div className="rb-saved">
                <div className="rb-sub">Your saved layouts</div>
                {saved.map((p) => (
                  <div className="rb-saved__row" key={p.name}>
                    <button
                      type="button"
                      className="rb-saved__use"
                      onClick={() => {
                        setTemplateKey('custom');
                        setSpec(fromSavedPreset(p, spec.range));
                      }}
                    >
                      <FileText size={12} strokeWidth={1.6} /> {p.name}
                    </button>
                    <button
                      type="button"
                      className="btn icon"
                      aria-label={`Delete ${p.name}`}
                      onClick={() => deletePreset(p.name)}
                    >
                      <Trash2 size={12} strokeWidth={1.6} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </RailGroup>

          <RailGroup title="Period">
            <RangeControl range={spec.range} onChange={(range) => patch({ range })} />
            {!rangeReady(spec.range) && (
              <div className="rb-hint warn">Pick both dates to build the report.</div>
            )}
          </RailGroup>

          <RailGroup title={`Sections (${sections.length})`}>
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

          <RailGroup title="Page setup">
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
        <div className="rb-preview">
          <div className="rb-preview__bar">
            <span className="rb-preview__count">
              {measuring || report.isLoading ? (
                <>
                  <Loader2 size={12} className="spin" /> Building
                  {report.totalCount > 0 &&
                    ` — ${report.loadedCount} of ${report.totalCount} sections`}
                </>
              ) : (
                <>
                  <strong>{sheets.length}</strong> {sheets.length === 1 ? 'page' : 'pages'} ·{' '}
                  {PAPER_MM[spec.paper].label} {spec.orientation}
                </>
              )}
            </span>
            {windowLabel && <span className="rb-preview__window">{windowLabel}</span>}
          </div>

          {report.errors.length > 0 && (
            <div className="rb-errors">
              <AlertTriangle size={13} strokeWidth={1.6} />
              <span>
                {report.errors.length} section{report.errors.length === 1 ? '' : 's'} failed to load
                and {report.errors.length === 1 ? 'is' : 'are'} marked in the document:{' '}
                {report.errors.map((e) => e.label).join(', ')}.
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

          {sections.length === 0 ? (
            <div className="rb-empty">
              <FileText size={22} strokeWidth={1.4} />
              <p>Pick a template on the left, or choose sections to build your own report.</p>
            </div>
          ) : (
            <div className="rb-sheets" ref={docRef}>
              <ReportDocument sheets={sheets} meta={meta} geometry={spec} variant="preview" />
            </div>
          )}
        </div>
      </div>

      {/* Offscreen measuring pass — invisible, drives pagination. */}
      {probe}
    </PageShell>
  );
}

// ---------------------------------------------------------------------------

function RailGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rb-group">
      <h3 className="rb-group__h">{title}</h3>
      {children}
    </section>
  );
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
// Range control — one control for all the shapes a report period can take.
// ---------------------------------------------------------------------------

function RangeControl({
  range,
  onChange,
}: {
  range: ReportRange;
  onChange: (r: ReportRange) => void;
}) {
  const months = useMemo(() => recentMonths(12), []);
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
        <select
          value={range.kind === 'month' ? range.month : ''}
          onChange={(e) => e.target.value && onChange({ kind: 'month', month: e.target.value })}
        >
          <option value="">choose a month…</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {monthLabel(m)}
            </option>
          ))}
        </select>
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
                        <label className="rb-topn">
                          <span>rows</span>
                          <input
                            type="number"
                            min={1}
                            max={5000}
                            value={entry.sel.topN}
                            onChange={(e) => onTopN(s.id, Math.max(1, Number(e.target.value) || 1))}
                          />
                        </label>
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
