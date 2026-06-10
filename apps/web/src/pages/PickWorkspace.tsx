import { useEffect, useRef } from 'react';
import { useNavigate, Navigate, Link } from 'react-router-dom';
import { ArrowRight, Mail } from 'lucide-react';

import { useMe, useLogout } from '@/lib/api';
import { useTenant } from '@/lib/tenant';

export function PickWorkspace() {
  const me = useMe();
  const { slug, setSlug } = useTenant();
  const nav = useNavigate();
  const logout = useLogout();

  const memberships = me.data?.memberships ?? [];

  // Once we know the user, treat a stored slug that points at a non-existent
  // membership as stale and drop it.
  const staleChecked = useRef(false);
  useEffect(() => {
    if (!me.data || staleChecked.current) return;
    staleChecked.current = true;
    if (slug && !memberships.some((m) => m.tenant_slug === slug)) {
      setSlug(null);
    }
  }, [me.data, slug, memberships, setSlug]);

  if (me.isPending) {
    return <div className="login-shell"><div className="empty-state">Loading…</div></div>;
  }
  if (me.isError) {
    return <Navigate to="/login" replace />;
  }

  const choose = (s: string) => {
    setSlug(s);
    nav('/admin', { replace: true });
  };

  const onLogout = async () => {
    try {
      await logout.mutateAsync();
    } finally {
      setSlug(null);
      nav('/login', { replace: true });
    }
  };

  return (
    <div className="picker-shell">
      <div className="picker">
        {memberships.length === 0 ? (
          // No workspace and no accepted invite. Workspaces are created by the
          // Sahan team — there is no self-serve creation. Point the user at the
          // request-access flow (or tell them an invite is on the way).
          <>
            <span className="greet">welcome, {me.data?.name?.split(' ')[0] ?? 'there'}.</span>
            <h1>No workspace yet</h1>
            <p style={{ color: 'var(--ink-300)', fontSize: 13, marginTop: -4 }}>
              You're signed in as <strong style={{ color: 'var(--ink-50)' }}>{me.data?.email}</strong>.
              If you were invited to a cafe, ask the owner to send the invite to this
              email — it'll appear here automatically. Otherwise, request access and
              we'll set you up.
            </p>
            <Link
              to="/request-access"
              className="btn primary"
              style={{ marginTop: 12, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
            >
              <Mail size={14} strokeWidth={1.5} />
              Request access
            </Link>
          </>
        ) : (
          <>
            <span className="greet">welcome back, {me.data?.name?.split(' ')[0] ?? 'there'}.</span>
            <h1>Pick a workspace</h1>
            <div className="picker-list">
              {memberships.map((m) => (
                <div key={m.tenant_slug} className="picker-row" onClick={() => choose(m.tenant_slug)}>
                  <div>
                    <div className="ttl">{m.tenant_name}</div>
                    <div className="role">{m.tenant_slug} · {m.roles.join('+')}</div>
                  </div>
                  <ArrowRight size={18} strokeWidth={1.5} color="var(--amber-fg)" />
                </div>
              ))}
            </div>
          </>
        )}

        <button
          type="button"
          onClick={onLogout}
          style={{
            marginTop: 12,
            background: 'transparent',
            border: 0,
            color: 'var(--ink-400)',
            font: 'inherit',
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            cursor: 'pointer',
            alignSelf: 'flex-start',
            padding: 0,
          }}
        >
          sign out
        </button>
      </div>
    </div>
  );
}
