import { useNavigate, Navigate } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';

import { useMe } from '@/lib/api';
import { useTenant } from '@/lib/tenant';

export function PickWorkspace() {
  const me = useMe();
  const { setSlug } = useTenant();
  const nav = useNavigate();

  if (me.isPending) {
    return <div className="login-shell"><div className="empty-state">loading…</div></div>;
  }

  if (me.isError) {
    return <Navigate to="/login" replace />;
  }

  const memberships = me.data?.memberships ?? [];

  const choose = (slug: string) => {
    setSlug(slug);
    nav('/admin', { replace: true });
  };

  if (memberships.length === 0) {
    return (
      <div className="picker-shell">
        <div className="picker">
          <span className="greet">no workspaces.</span>
          <h1>access required.</h1>
          <p style={{ color: 'var(--ink-300)', fontSize: 13 }}>
            You're signed in as <strong style={{ color: 'var(--ink-50)' }}>{me.data?.email}</strong>{' '}
            but you're not a member of any cafe yet. Ask an owner to invite you, or contact support.
          </p>
        </div>
      </div>
    );
  }

  // Auto-pick if exactly one membership.
  if (memberships.length === 1) {
    setSlug(memberships[0]!.tenant_slug);
    return <Navigate to="/admin" replace />;
  }

  return (
    <div className="picker-shell">
      <div className="picker">
        <span className="greet">welcome back, {me.data?.name?.split(' ')[0] ?? 'there'}.</span>
        <h1>pick a workspace.</h1>
        <div className="picker-list">
          {memberships.map((m) => (
            <div key={m.tenant_slug} className="picker-row" onClick={() => choose(m.tenant_slug)}>
              <div>
                <div className="ttl">{m.tenant_name}</div>
                <div className="role">
                  {m.tenant_slug} · {m.role}
                </div>
              </div>
              <ArrowRight size={18} strokeWidth={1.5} color="var(--amber-500)" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
