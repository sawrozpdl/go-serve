import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Bug, Inbox, ShieldAlert, MailCheck, ArrowRight } from 'lucide-react';

import {
  useAdminTenants,
  useAdminUsage,
  useAdminStatement,
  useAdminCash,
  useAdminBugReports,
  useAdminLeads,
  useAdminAccuracyCheck,
  useAdminJobStatus,
  useAdminPeople,
  type AdminTenant,
  type TenantUsage,
} from '@/lib/api';
import {
  LEAD_STAGE_META,
  OPEN_LEAD_STAGES,
  USAGE_STATUS_LABEL,
  type LeadStage,
  type UsageStatus,
} from '@cafe-mgmt/api-types';
import { PageShell } from '@/components/PageShell';
import { QueryState } from '@/components/QueryState';
import { formatNPR } from '@/components/Money';
import { fmtDayWithRelative, todayIso } from '@/lib/dates';
import { buildAttentionQueue, REASON_LABEL, reasonTone, type AttentionItem } from '@/lib/superAttention';

/* Where /super lands. One question: what needs me today?
 *
 * The attention queue is the page — everything else is context for it. The
 * charts are CSS bars rather than a charting dependency, matching the rest of
 * the app (which has none). */
export function SuperOverviewPage() {
  const tenantsQ = useAdminTenants();
  const usageQ = useAdminUsage();
  const monthStart = todayIso().slice(0, 8) + '01';
  const statementQ = useAdminStatement({ from: monthStart, to: todayIso() });
  const cashQ = useAdminCash();
  const bugsQ = useAdminBugReports({ status: 'open' });
  // Leads the pipeline is late on. Deliberately NOT folded into the attention
  // queue: that queue ranks cafés, and a lead isn't one — merging them would
  // mean inventing a fake tenant for every row.
  const dueQ = useAdminLeads({ due: 'today' });
  const pipelineQ = useAdminLeads({});
  const accuracyQ = useAdminAccuracyCheck();
  const jobQ = useAdminJobStatus();
  const peopleQ = useAdminPeople();

  const usageById = useMemo(() => {
    const m = new Map<string, TenantUsage>();
    for (const u of usageQ.data?.usage ?? []) m.set(u.tenant_id, u);
    return m;
  }, [usageQ.data]);

  // Memoised: `?? []` builds a fresh array every render, which would defeat the
  // queue's own useMemo and re-rank several thousand cafés on every keystroke
  // elsewhere on the page.
  const tenants = useMemo(() => tenantsQ.data?.tenants ?? [], [tenantsQ.data]);
  const queue = useMemo(() => buildAttentionQueue(tenants, usageById), [tenants, usageById]);
  const summary = tenantsQ.data?.summary;

  return (
    <PageShell
      eyebrow="Platform"
      title="Overview"
      subtitle={fmtDayWithRelative(new Date().toISOString(), '')}
      docTitle="Overview"
    >
      <div className="kpis">
        <div className="kpi">
          <span className="label">Active cafés</span>
          <span className="value">{summary?.active ?? '—'}</span>
        </div>
        <div className="kpi">
          <span className="label">Needs attention</span>
          <span className="value">{queue.length}</span>
        </div>
        <div className="kpi">
          <span className="label">Revenue this month</span>
          <span className="value">{formatNPR(statementQ.data?.revenue_cents ?? 0)}</span>
        </div>
        <div className="kpi">
          <span className="label">Net this month</span>
          <span className="value">{formatNPR(statementQ.data?.net_cents ?? 0)}</span>
        </div>
        <div className="kpi">
          <span className="label">Cash in hands</span>
          <span className="value">{formatNPR(cashQ.data?.total_held_cents ?? 0)}</span>
        </div>
      </div>

      <div className="overview-grid">
        <section className="panel overview-queue">
          <div className="panel-head">
            <h3>Needs attention</h3>
            <Link className="panel-link" to="/super/tenants">All cafés <ArrowRight size={12} strokeWidth={1.8} /></Link>
          </div>
          <QueryState
            isPending={tenantsQ.isPending}
            isError={tenantsQ.isError}
            error={tenantsQ.error}
            refetch={tenantsQ.refetch}
            isEmpty={queue.length === 0}
            errorTitle="Could not load cafés"
            emptyTitle="Nothing needs you"
            emptyHint="Every café is paid up, trading, and has someone looking after it."
            compact
          >
            <ul className="attention-list">
              {queue.slice(0, 12).map((item) => (
                <AttentionRow key={item.tenant.tenant_id} item={item} />
              ))}
            </ul>
            {queue.length > 12 && (
              // Never truncate silently — say what's below the fold.
              <p className="hint">
                …and {queue.length - 12} more. <Link to="/super/tenants">See every café</Link>.
              </p>
            )}
          </QueryState>
        </section>

        <div className="overview-side">
          <section className="panel">
            <div className="panel-head"><h3>Usage mix</h3></div>
            <UsageMix byStatus={usageQ.data?.by_status ?? {}} total={tenants.length} />
          </section>

          <section className="panel">
            <div className="panel-head"><h3>Waiting on us</h3></div>
            <ul className="overview-tiles">
              <Tile
                icon={<Inbox size={14} strokeWidth={1.7} />}
                to="/super/leads?due=today"
                label="Follow-ups due"
                value={dueQ.data?.leads.length ?? 0}
                tone={(dueQ.data?.leads.length ?? 0) > 0 ? 'warn' : undefined}
              />
              <Tile
                icon={<Bug size={14} strokeWidth={1.7} />}
                to="/super/bug-reports"
                label="Open feedback"
                value={bugsQ.data?.summary.open ?? 0}
              />
              <Tile
                icon={<ShieldAlert size={14} strokeWidth={1.7} />}
                to="/super/tenants"
                label="Accuracy violations"
                value={accuracyViolationCount(accuracyQ.data)}
                tone={accuracyViolationCount(accuracyQ.data) > 0 ? 'warn' : undefined}
              />
              <li className="overview-tile">
                <span className="overview-tile__icon"><MailCheck size={14} strokeWidth={1.7} /></span>
                <span className="overview-tile__label">Last digest</span>
                <span className="overview-tile__value overview-tile__value--text">
                  {jobQ.data?.last_sent_at
                    ? fmtDayWithRelative(jobQ.data.last_sent_at)
                    : <span className="muted">never sent</span>}
                </span>
              </li>
            </ul>
          </section>
        </div>

        <section className="panel">
          <div className="panel-head">
            <h3>Pipeline</h3>
            <Link className="panel-link" to="/super/leads">All leads <ArrowRight size={12} strokeWidth={1.8} /></Link>
          </div>
          <QueryState
            isPending={pipelineQ.isPending}
            isError={pipelineQ.isError}
            error={pipelineQ.error}
            refetch={pipelineQ.refetch}
            isEmpty={(pipelineQ.data?.leads.length ?? 0) === 0}
            errorTitle="Could not load the pipeline"
            emptyTitle="No open leads"
            emptyHint="Add the cafés you're in conversation with."
            compact
          >
            <PipelineStrip counts={pipelineQ.data?.counts} />
          </QueryState>
        </section>

        <section className="panel">
          <div className="panel-head"><h3>Signups</h3><span className="meta">last 12 months</span></div>
          <MonthlyBars series={signupsByMonth(tenants)} format={(n) => String(n)} />
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>Managers</h3>
            <Link className="panel-link" to="/super/people">People <ArrowRight size={12} strokeWidth={1.8} /></Link>
          </div>
          <QueryState
            isPending={peopleQ.isPending}
            isError={peopleQ.isError}
            error={peopleQ.error}
            refetch={peopleQ.refetch}
            isEmpty={(peopleQ.data?.people.length ?? 0) === 0}
            errorTitle="Could not load people"
            emptyTitle="Nobody in the registry"
            compact
          >
            <ManagerTable tenants={tenants} usageById={usageById} people={peopleQ.data?.people ?? []} />
          </QueryState>
        </section>
      </div>
    </PageShell>
  );
}

/** Where the open deals sit. Counts only — the pipeline's own page is one click
 *  away, and a second ranked list here would compete with the attention queue
 *  for the "what do I do first" job the page exists to answer. */
function PipelineStrip({ counts }: { counts?: Record<LeadStage, number> }) {
  const open = OPEN_LEAD_STAGES;
  const total = open.reduce((n, s) => n + (counts?.[s] ?? 0), 0);
  return (
    <ul className="pipeline-strip">
      {open.map((s) => {
        const n = counts?.[s] ?? 0;
        return (
          <li key={s}>
            <Link to={`/super/leads?stage=${s}`}>
              <span className="pipeline-strip__value">{n}</span>
              <span className="pipeline-strip__label">{LEAD_STAGE_META[s].label}</span>
              <span
                className="pipeline-strip__bar"
                style={{ width: total > 0 ? `${(n / total) * 100}%` : 0 }}
              />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** The violations array is capped server-side at 500 rows; the per-check
 *  summary counts every one. Reading the array length would under-report
 *  exactly when the number matters most. */
function accuracyViolationCount(data?: { summary: { count: number }[] }): number {
  return (data?.summary ?? []).reduce((n, s) => n + s.count, 0);
}

function AttentionRow({ item }: { item: AttentionItem }) {
  const top = item.reasons[0]!;
  return (
    <li className={`attention-row attention-row--${reasonTone(top)}`}>
      <Link to={`/super/tenants/${item.tenant.tenant_id}?tab=${item.tab}`}>
        <span className="attention-row__name">{item.tenant.name}</span>
        <span className="attention-row__why">{item.detail}</span>
      </Link>
      <span className="attention-row__tags">
        {item.reasons.map((r) => (
          <span key={r} className={`pill ${reasonTone(r) === 'critical' ? 'bad' : 'warn'}`}>
            {REASON_LABEL[r]}
          </span>
        ))}
        {/* The "No manager" pill already says this — repeating it as a
            trailing label just makes the row noisier. */}
        {item.tenant.relationship_manager_name && (
          <span className="muted attention-row__rm">{item.tenant.relationship_manager_name}</span>
        )}
      </span>
    </li>
  );
}

/** A single stacked bar. More legible than a donut at this size, and it makes
 *  "most cafés are dormant" impossible to miss. */
function UsageMix({ byStatus, total }: { byStatus: Partial<Record<UsageStatus, number>>; total: number }) {
  const order: UsageStatus[] = ['healthy', 'onboarding', 'watch', 'at_risk', 'dormant'];
  const counted = order.reduce((n, s) => n + (byStatus[s] ?? 0), 0);
  if (counted === 0) return <p className="muted">No usage data yet.</p>;

  return (
    <>
      <div className="usage-mix" role="img" aria-label="Cafés by usage status">
        {order.map((s) => {
          const n = byStatus[s] ?? 0;
          if (n === 0) return null;
          return (
            <span
              key={s}
              className={`usage-mix__seg usage-mix__seg--${s}`}
              style={{ flexGrow: n }}
              title={`${USAGE_STATUS_LABEL[s]}: ${n}`}
            />
          );
        })}
      </div>
      <ul className="usage-mix__legend">
        {order.map((s) => {
          const n = byStatus[s] ?? 0;
          if (n === 0) return null;
          return (
            <li key={s}>
              <span className={`usage-mix__dot usage-mix__seg--${s}`} />
              {USAGE_STATUS_LABEL[s]} <strong>{n}</strong>
            </li>
          );
        })}
      </ul>
      {counted < total && (
        <p className="hint">{total - counted} café{total - counted === 1 ? '' : 's'} still loading.</p>
      )}
    </>
  );
}

/** Signups per month for the last 12, oldest first. */
function signupsByMonth(tenants: AdminTenant[]): { key: string; label: string; value: number }[] {
  const months: { key: string; label: string; value: number }[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString(undefined, { month: 'short' }),
      value: 0,
    });
  }
  const index = new Map(months.map((m, i) => [m.key, i]));
  for (const t of tenants) {
    const k = t.created_at.slice(0, 7);
    const i = index.get(k);
    if (i !== undefined) months[i]!.value++;
  }
  return months;
}

function MonthlyBars({
  series,
  format,
}: {
  series: { key: string; label: string; value: number }[];
  format: (n: number) => string;
}) {
  const peak = Math.max(1, ...series.map((s) => s.value));
  return (
    <div className="chart chart--months">
      {series.map((s) => (
        <div key={s.key} className="chart__col" title={`${s.label}: ${format(s.value)}`}>
          <div
            className={s.value === 0 ? 'bar is-zero' : 'bar'}
            style={{ height: `${Math.max(2, (s.value / peak) * 100)}%` }}
          />
          <span className="chart__x">{s.label}</span>
        </div>
      ))}
    </div>
  );
}

/** Who looks after what, and how it's going. The healthy-% is the point:
 *  a manager with twenty cafés and three healthy ones needs help. */
function ManagerTable({
  tenants,
  usageById,
  people,
}: {
  tenants: AdminTenant[];
  usageById: Map<string, TenantUsage>;
  people: { id: string; name: string }[];
}) {
  const rows = useMemo(() => {
    const byPerson = new Map<string, { name: string; total: number; healthy: number; attention: number }>();
    for (const p of people) byPerson.set(p.id, { name: p.name, total: 0, healthy: 0, attention: 0 });

    for (const t of tenants) {
      if (!t.relationship_manager_id) continue;
      const row = byPerson.get(t.relationship_manager_id);
      if (!row) continue;
      row.total++;
      const s = usageById.get(t.tenant_id)?.status;
      if (s === 'healthy' || s === 'onboarding') row.healthy++;
      if (s === 'at_risk' || s === 'dormant') row.attention++;
    }
    return [...byPerson.values()].filter((r) => r.total > 0).sort((a, b) => b.total - a.total);
  }, [tenants, usageById, people]);

  if (rows.length === 0) {
    return <p className="muted">No cafés have a manager assigned yet.</p>;
  }
  return (
    <div className="table-scroll">
      <table className="t">
        <thead>
          <tr><th>Manager</th><th className="num">Cafés</th><th className="num">Healthy</th><th className="num">Needs work</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td>{r.name}</td>
              <td className="num">{r.total}</td>
              <td className="num">{Math.round((r.healthy / r.total) * 100)}%</td>
              <td className={`num ${r.attention > 0 ? 'usage-warn' : ''}`}>{r.attention || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tile({
  icon, to, label, value, tone,
}: {
  icon: React.ReactNode;
  to: string;
  label: string;
  value: number;
  tone?: 'warn';
}) {
  return (
    <li className="overview-tile">
      <span className="overview-tile__icon">{icon}</span>
      <Link className="overview-tile__label" to={to}>{label}</Link>
      <span className={`overview-tile__value${tone === 'warn' && value > 0 ? ' usage-warn' : ''}`}>
        {value}
      </span>
    </li>
  );
}
