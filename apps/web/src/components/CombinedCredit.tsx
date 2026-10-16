import { useMemo } from 'react';
import { ArrowUpRight } from 'lucide-react';

import { PageShell } from '@/components/PageShell';
import { CoverageNote } from '@/components/CoverageNote';
import { Kpi } from '@/components/Kpi';
import { formatNPR } from '@/components/Money';
import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { useBusinessCredit } from '@/lib/api';
import { branchColor, branchLabel } from '@/lib/branches';
import { useBranchNav, useOverview } from '@/lib/useBranchNav';

/**
 * Credit, all branches. One row per customer — the same person's accounts at
 * different branches are linked by phone — with what each branch is owed.
 * Payments are still taken at the branch that's owed, so each part opens that
 * branch's account; nothing moves between branches' books.
 */
export function CombinedCredit() {
  const q = useBusinessCredit();
  const { business, branches } = useOverview();
  const { goToBranch } = useBranchNav();
  const label = (n: string) => branchLabel(n, business?.name);
  const customers = useMemo(() => (q.data?.customers ?? []).filter((c) => c.balance_cents !== 0), [q.data]);
  const shared = customers.filter((c) => c.accounts.length > 1).length;

  return (
    <PageShell eyebrow="running ledgers" title="Credit" subtitle={`All branches · ${business?.name ?? ''}`}>
      {q.isPending && <LoadingState />}
      {q.isError && !q.data && <ErrorState onRetry={() => q.refetch()} />}
      {q.data && (
        <>
          <CoverageNote statuses={q.data.branches} />
          <div className="kpis">
            <Kpi label="Owed to the business" cents={q.data.total_owed_cents} />
            <Kpi label="Customers owing" raw={customers.length} />
            <Kpi label="Owe at more than one branch" raw={shared} />
          </div>
          <section className="panel" style={{ marginTop: 16 }}>
            {customers.length === 0 ? (
              <div className="empty-state">Nobody owes anything right now.</div>
            ) : (
              <div className="bo-compare__scroll">
                <table className="t">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Owed at</th>
                      <th className="num" style={{ textAlign: 'right' }}>
                        Total
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {customers.map((c) => (
                      <tr key={c.key}>
                        <td>
                          <div className="cc-name">{c.name}</div>
                          {c.phone && <div className="cc-phone">{c.phone}</div>}
                        </td>
                        <td>
                          <div className="cc-accounts">
                            {c.accounts
                              .filter((a) => a.balance_cents !== 0)
                              .map((a) => (
                                <button
                                  key={a.house_tab_id}
                                  type="button"
                                  className="cc-account"
                                  title={`Open ${a.name} at ${label(a.branch_name)} to take a payment`}
                                  onClick={() => goToBranch(a.branch_slug, `/admin/house-tabs?open=${a.house_tab_id}`)}
                                >
                                  <span className="branch-dot" style={{ background: branchColor(branches, a.branch_slug) }} aria-hidden />
                                  {label(a.branch_name)}
                                  <span className="cc-amt">{formatNPR(a.balance_cents)}</span>
                                  <ArrowUpRight size={12} strokeWidth={1.6} aria-hidden />
                                </button>
                              ))}
                          </div>
                        </td>
                        <td className="num" style={{ textAlign: 'right' }}>
                          <strong>{formatNPR(c.balance_cents)}</strong>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="field-hint" style={{ marginTop: 8 }}>
              Accounts are linked across branches by phone number; one without a phone stays on its own. A payment is taken
              at the branch that's owed — open that branch's part to settle it.
            </p>
          </section>
        </>
      )}
    </PageShell>
  );
}

/** Inside one branch's account: what the same customer owes elsewhere. */
export function OwedElsewhere({ phone }: { phone: string }) {
  const { business, branches } = useOverview();
  const multi = branches.length > 1;
  const q = useBusinessCredit(phone, multi && !!phone.trim());
  const { goToBranch } = useBranchNav();
  const elsewhere = (q.data?.customers ?? [])
    .flatMap((c) => c.accounts)
    .filter((a) => !branches.find((b) => b.slug === a.branch_slug)?.is_active && a.balance_cents > 0);
  if (!multi || elsewhere.length === 0) return null;
  return (
    <div className="cc-elsewhere" role="note">
      Also owes{' '}
      {elsewhere.map((a, i) => (
        <span key={a.house_tab_id}>
          {i > 0 && ', '}
          <button type="button" className="link-btn" onClick={() => goToBranch(a.branch_slug, `/admin/house-tabs?open=${a.house_tab_id}`)}>
            {formatNPR(a.balance_cents)} at {branchLabel(a.branch_name, business?.name)}
          </button>
        </span>
      ))}
      . Settle that at that branch.
    </div>
  );
}
