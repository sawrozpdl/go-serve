import { useEffect, useState } from 'react';
import { Download, FileSpreadsheet, Printer, ShieldCheck, ShieldAlert } from 'lucide-react';
import type { FiscalRegisterTable } from '@cafe-mgmt/api-types';
import { PageShell } from '@/components/PageShell';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { formatNPR } from '@/components/Money';
import { downloadFiscalRegister, useAuditChain, useFiscalRegister, useFiscalRegisterList } from '@/lib/api';
import { useTenant } from '@/lib/tenant';
import { esc, printHTML } from '@/lib/printing';
import { toast } from '@/lib/toast';

// Reports → IRD registers. Every register IRD asks for (procedure 2082
// §6.1(छ)(घ), §6.3; Annex 5–6), on screen and as Excel / CSV / XML, plus a
// printable PDF of the same table. Periods are BS fiscal years and months.

const MONTHS = [
  [4, 'Shrawan'],
  [5, 'Bhadra'],
  [6, 'Ashwin'],
  [7, 'Kartik'],
  [8, 'Mangsir'],
  [9, 'Poush'],
  [10, 'Magh'],
  [11, 'Falgun'],
  [12, 'Chaitra'],
  [1, 'Baisakh'],
  [2, 'Jestha'],
  [3, 'Asar'],
] as const;

function fmt(kind: string, v: string | number | boolean | null): string {
  if (v === null || v === undefined) return '';
  if (kind === 'money' && typeof v === 'number') return formatNPR(v);
  if (kind === 'bool') return v ? 'Yes' : 'No';
  return String(v);
}

function moneyPlain(cents: number): string {
  return (cents / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A4 landscape print of the register (the PDF export, via the browser). */
function registerHTML(t: FiscalRegisterTable): string {
  const head = t.columns.map((c) => `<th>${esc(c.label)}</th>`).join('');
  const body = t.rows
    .map(
      (r) =>
        `<tr>${t.columns
          .map((c, i) => {
            const v = r[i];
            const txt = c.kind === 'money' && typeof v === 'number' ? moneyPlain(v) : fmt(c.kind, v ?? null);
            return `<td class="${c.kind === 'money' ? 'n' : ''}">${esc(txt)}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  const totals = t.totals
    ? `<tr class="tot">${t.columns
        .map((c, i) =>
          i === 0
            ? '<td>Total</td>'
            : `<td class="n">${c.kind === 'money' ? esc(moneyPlain(t.totals?.[c.key] ?? 0)) : ''}</td>`,
        )
        .join('')}</tr>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(t.title)}</title><style>
    @page { size: A4 landscape; margin: 10mm; }
    body { font: 10px system-ui, sans-serif; color: #000; }
    h1 { font-size: 14px; margin: 0 0 4px; }
    .meta { margin-bottom: 8px; } .meta span { margin-right: 14px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #555; padding: 2px 4px; vertical-align: top; }
    th { background: #eee; text-align: left; }
    td.n { text-align: right; white-space: nowrap; }
    tr.tot td { font-weight: 700; }
  </style></head><body>
    <h1>${esc(t.title)}${t.title_ne ? ` / ${esc(t.title_ne)}` : ''}</h1>
    <div class="meta">${t.header.map(([k, v]) => `<span><b>${esc(k)}:</b> ${esc(v)}</span>`).join('')}</div>
    <table><thead><tr>${head}</tr></thead><tbody>${body}${totals}</tbody></table>
  </body></html>`;
}

export function IrdRegistersPage() {
  const { slug } = useTenant();
  const list = useFiscalRegisterList();
  const [kind, setKind] = useState('materialized_view');
  const [fy, setFy] = useState('');
  const [month, setMonth] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (list.data && !fy) setFy(list.data.current_fiscal_year);
  }, [list.data, fy]);

  const table = useFiscalRegister(kind, fy, month, !!fy);
  const chain = useAuditChain(kind === 'audit_trail');

  const download = async (format: 'csv' | 'xlsx' | 'xml') => {
    if (!slug) return;
    setBusy(format);
    try {
      await downloadFiscalRegister(slug, kind, fy, month, format);
    } catch (e: unknown) {
      toast.error('Download failed', (e as { message?: string }).message ?? '');
    } finally {
      setBusy(null);
    }
  };

  const t = table.data;
  return (
    <PageShell eyebrow="reports" title="IRD registers">
      {list.isError && <ErrorState onRetry={() => list.refetch()} />}

      <div className="filter-row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        {(list.data?.registers ?? []).map((r) => (
          <button key={r.kind} type="button" className={`chip ${kind === r.kind ? 'active' : ''}`} onClick={() => setKind(r.kind)}>
            {r.title}
          </button>
        ))}
      </div>

      <div className="filter-row" style={{ marginBottom: 12, gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div className="field" style={{ margin: 0 }}>
          <label>Fiscal year</label>
          <input value={fy} onChange={(e) => setFy(e.target.value)} placeholder="2083/84" style={{ width: 100 }} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label>Month</label>
          <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
            <option value={0}>Whole year</option>
            {MONTHS.map(([m, name]) => (
              <option key={m} value={m}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" className="btn" disabled={!t || !!busy} onClick={() => download('xlsx')}>
            <FileSpreadsheet size={14} strokeWidth={1.5} /> Excel
          </button>
          <button type="button" className="btn" disabled={!t || !!busy} onClick={() => download('csv')}>
            <Download size={14} strokeWidth={1.5} /> CSV
          </button>
          <button type="button" className="btn" disabled={!t || !!busy} onClick={() => download('xml')}>
            <Download size={14} strokeWidth={1.5} /> XML
          </button>
          <button type="button" className="btn" disabled={!t} onClick={() => t && printHTML(registerHTML(t))}>
            <Printer size={14} strokeWidth={1.5} /> PDF
          </button>
        </div>
      </div>

      {kind === 'audit_trail' && chain.data && (
        <div className={chain.data.ok ? 'banner-info' : 'banner-error'} style={{ marginBottom: 12 }} role="status">
          {chain.data.ok ? <ShieldCheck size={14} strokeWidth={1.8} /> : <ShieldAlert size={14} strokeWidth={1.8} />}{' '}
          {chain.data.ok
            ? chain.data.rows_checked === 0
              ? 'Activity log chaining is on; no chained entries yet.'
              : `Activity log intact: ${chain.data.rows_checked} chained entries verified.`
            : `Activity log altered at entry #${chain.data.first_bad_seq} — report this.`}
        </div>
      )}

      {/* isLoading, not isPending: the query is disabled until the FY is known. */}
      {table.isLoading && <LoadingState />}
      {table.isError && <ErrorState onRetry={() => table.refetch()} />}
      {t && (
        <div className="panel">
          <div className="panel-head">
            <h3>
              {t.title}
              {t.title_ne ? <span className="meta"> · {t.title_ne}</span> : null}
            </h3>
            <span className="meta">{t.rows.length} rows</span>
          </div>
          {t.rows.length === 0 ? (
            <div className="empty-state">Nothing in this period.</div>
          ) : (
            <div className="table-scroll">
              <table className="t">
                <thead>
                  <tr>
                    {t.columns.map((c) => (
                      <th key={c.key} style={c.kind === 'money' ? { textAlign: 'right' } : undefined}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {t.rows.map((r, i) => (
                    <tr key={i}>
                      {t.columns.map((c, j) => (
                        <td key={c.key} style={c.kind === 'money' ? { textAlign: 'right', whiteSpace: 'nowrap' } : undefined}>
                          {fmt(c.kind, r[j] ?? null)}
                        </td>
                      ))}
                    </tr>
                  ))}
                  {t.totals && (
                    <tr className="total-row">
                      {t.columns.map((c, j) => (
                        <td key={c.key} style={c.kind === 'money' ? { textAlign: 'right', fontWeight: 700 } : { fontWeight: 700 }}>
                          {j === 0 ? 'Total' : c.kind === 'money' ? formatNPR(t.totals?.[c.key] ?? 0) : ''}
                        </td>
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}
