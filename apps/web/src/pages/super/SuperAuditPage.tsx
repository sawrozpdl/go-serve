import { useAdminAudit } from '@/lib/api';
import { PageShell } from '@/components/PageShell';
import { QueryState } from '@/components/QueryState';
import { RefreshButton } from '@/components/RefreshButton';

function fmtDate(s: string) {
  return new Date(s).toLocaleString();
}

export function SuperAuditPage() {
  const q = useAdminAudit();
  const events = q.data?.events ?? [];

  return (
    <PageShell
      eyebrow="Activity"
      title="Platform audit"
      subtitle="Every cross-tenant action taken from this console"
      docTitle="Platform audit"
      actions={<RefreshButton onClick={() => q.refetch()} busy={q.isFetching} />}
    >
      <QueryState
        isPending={q.isPending}
        isError={q.isError}
        error={q.error}
        refetch={q.refetch}
        isEmpty={events.length === 0}
        errorTitle="Could not load the audit log"
        emptyTitle="No activity yet"
        emptyHint="Console actions — provisioning, plan changes, payments, purges — are recorded here."
      >
        <div className="table-scroll">
          <table className="t">
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Café</th><th>Summary</th></tr></thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i}>
                  <td className="muted">{fmtDate(e.created_at)}</td>
                  <td>{e.actor_email}</td>
                  <td><span className="pill">{e.action}</span></td>
                  <td>{e.tenant_slug ?? <span className="muted">—</span>}</td>
                  <td>{e.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
    </PageShell>
  );
}
