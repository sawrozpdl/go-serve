import { CheckCircle2, Circle, AlertCircle, MinusCircle, type LucideIcon } from 'lucide-react';

import { useAdminTenantUsage, type UsageSignal, type SignalGrade } from '@/lib/api';
import { QueryState } from '@/components/QueryState';
import { UsageChip, OrderSparkline } from '@/components/super/UsageChip';
import { formatNPR } from '@/components/Money';
import { fmtDayLong, fmtRelative } from '@/lib/dates';

const SIGNAL_TITLE: Record<UsageSignal['key'], string> = {
  shift_discipline: 'Shift discipline',
  volume: 'Order volume',
  engagement: 'Who’s using it',
};

const GRADE_ICON: Record<SignalGrade, LucideIcon> = {
  good: CheckCircle2,
  warn: AlertCircle,
  bad: AlertCircle,
  na: MinusCircle,
};

/** Why this café's usage status is what it is — the numbers, the trend, and
 *  the raw shift log, so a red chip is never just an assertion. */
export function UsageTab({ id }: { id: string }) {
  const q = useAdminTenantUsage(id);
  const u = q.data?.usage;

  return (
    <QueryState
      isPending={q.isPending}
      isError={q.isError}
      error={q.error}
      refetch={q.refetch}
      errorTitle="Could not load usage"
    >
      {u && (
        <div className="usage-layout">
          <section className="panel">
            <div className="panel-head">
              <h3>Usage</h3>
              <span className="meta"><UsageChip usage={u} /></span>
            </div>
            <p className="hint">
              How much this café actually runs on the app. Separate from billing — a paying
              workspace can still be dormant, and a trialling one can be thriving.
            </p>

            <div className="usage-signals">
              {u.signals.map((s) => {
                const Icon = GRADE_ICON[s.grade];
                return (
                  <div key={s.key} className={`usage-signal usage-signal--${s.grade}`}>
                    <Icon size={15} strokeWidth={1.8} />
                    <div>
                      <strong>{SIGNAL_TITLE[s.key]}</strong>
                      <span>{s.detail}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            <dl className="super-dl" style={{ marginTop: 'var(--space-4)' }}>
              <dt>Orders this week</dt>
              <dd>{u.orders_7d} <span className="muted">({formatNPR(u.gross_7d_cents)} net)</span></dd>
              <dt>Trading days</dt>
              <dd>{u.operating_days_7d} of the last 7</dd>
              <dt>Shifts closed</dt><dd>{u.shift_closed_days_7d} of those days</dd>
              <dt>Last order</dt>
              <dd>
                {u.last_order_closed_at
                  ? <>{fmtDayLong(u.last_order_closed_at)} <span className="muted">{fmtRelative(u.last_order_closed_at)}</span></>
                  : <span className="muted">never</span>}
              </dd>
              <dt>Last shift close</dt>
              <dd>
                {u.last_shift_closed_at
                  ? <>{fmtDayLong(u.last_shift_closed_at)} <span className="muted">{fmtRelative(u.last_shift_closed_at)}</span></>
                  : <span className="muted">never</span>}
              </dd>
              {u.open_shift_since && (
                <>
                  <dt>Shift open since</dt>
                  <dd className="usage-warn">
                    {fmtDayLong(u.open_shift_since)} <span className="muted">{fmtRelative(u.open_shift_since)}</span>
                  </dd>
                </>
              )}
              <dt>People this week</dt><dd>{u.active_members_7d}</dd>
            </dl>
          </section>

          <section className="panel">
            <div className="panel-head"><h3>Setup</h3></div>
            <p className="hint">
              What they’ve switched on. Not a health signal — a café that doesn’t need stock
              tracking isn’t doing anything wrong — but it shows where onboarding stopped.
            </p>
            <ul className="usage-adoption">
              <AdoptionRow done={u.menu_item_count >= 10} label={`Menu built out (${u.menu_item_count} items)`} />
              <AdoptionRow done={u.adoption.inventory} label="Inventory tracked" />
              <AdoptionRow done={u.adoption.expenses} label="Expenses recorded" />
              <AdoptionRow done={u.adoption.credit} label="Customer credit used" />
              <AdoptionRow done={u.adoption.staff > 0} label={`Staff records (${u.adoption.staff})`} />
              <AdoptionRow done={u.adoption.outlets > 1} label={`Multiple outlets (${u.adoption.outlets})`} />
            </ul>

            {(q.data?.trend.length ?? 0) > 0 && (
              <>
                <div className="panel-head" style={{ marginTop: 'var(--space-5)' }}>
                  <h3>Last 28 days</h3>
                </div>
                <OrderSparkline points={q.data!.trend} />
              </>
            )}
          </section>

          <section className="panel" style={{ gridColumn: '1 / -1' }}>
            <div className="panel-head"><h3>Shift log</h3><span className="meta">last 14 days</span></div>
            {q.data!.shifts.length === 0 ? (
              <p className="muted">No shifts opened in the last two weeks.</p>
            ) : (
              <div className="table-scroll">
                <table className="t">
                  <thead>
                    <tr><th>Opened</th><th>Closed</th><th>Closed by</th><th className="num">Variance</th></tr>
                  </thead>
                  <tbody>
                    {q.data!.shifts.map((s) => (
                      <tr key={s.id} className={s.closed_at ? undefined : 'row-warn'}>
                        <td>{fmtDayLong(s.opened_at)}</td>
                        <td>
                          {s.closed_at
                            ? fmtDayLong(s.closed_at)
                            : <span className="usage-warn">still open · {fmtRelative(s.opened_at)}</span>}
                        </td>
                        <td>{s.closed_by_name ?? <span className="muted">—</span>}</td>
                        <td className="num">
                          {s.variance_cents == null
                            ? <span className="muted">—</span>
                            : <span className={s.variance_cents < 0 ? 'usage-warn' : undefined}>
                                {formatNPR(s.variance_cents)}
                              </span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </QueryState>
  );
}

function AdoptionRow({ done, label }: { done: boolean; label: string }) {
  return (
    <li className={done ? 'is-done' : undefined}>
      {done ? <CheckCircle2 size={14} strokeWidth={1.8} /> : <Circle size={14} strokeWidth={1.6} />}
      {label}
    </li>
  );
}
