import { useAdminAudit } from '@/lib/api';

function fmtDate(s: string) {
  return new Date(s).toLocaleString();
}

export function SuperAuditPage() {
  const q = useAdminAudit();
  const events = q.data?.events ?? [];

  return (
    <div className="super-page">
      <div className="super-page-head"><h1>Platform audit</h1></div>
      {q.isError && <div className="banner-error">{q.error?.message ?? 'Failed to load audit log'}</div>}
      <div className="table-scroll">
        <table className="t">
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Tenant</th><th>Summary</th></tr></thead>
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
            {!q.isPending && events.length === 0 && (
              <tr><td colSpan={5} className="muted" style={{ textAlign: 'center', padding: 24 }}>No activity yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
