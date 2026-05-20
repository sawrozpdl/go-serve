import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { ArrowRight, Plus } from 'lucide-react';

import { useMe, useCreateTenant, useLogout } from '@/lib/api';
import { useTenant } from '@/lib/tenant';

export function PickWorkspace() {
  const me = useMe();
  const { slug, setSlug } = useTenant();
  const nav = useNavigate();
  const create = useCreateTenant();
  const logout = useLogout();

  const memberships = me.data?.memberships ?? [];

  // Once we know the user, treat a stored slug that points at a non-existent
  // membership as stale and drop it. One-shot on first /me arrival; we don't
  // want this to fire again after the create flow set a slug whose membership
  // hasn't been refetched into /me yet.
  const staleChecked = useRef(false);
  useEffect(() => {
    if (!me.data || staleChecked.current) return;
    staleChecked.current = true;
    if (slug && !memberships.some((m) => m.tenant_slug === slug)) {
      setSlug(null);
    }
  }, [me.data, slug, memberships, setSlug]);

  // Show the create form by default when the user has nowhere to go.
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [customSlug, setCustomSlug] = useState('');

  useEffect(() => {
    if (me.data && memberships.length === 0) setShowCreate(true);
  }, [me.data, memberships.length]);

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

  const onCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const t = await create.mutateAsync({
        name: name.trim(),
        slug: customSlug.trim() || undefined,
      });
      setSlug(t.slug);
      // /me will refetch via onSuccess invalidation; nav before refetch
      // resolves is fine because AdminShell pulls /me again with the new
      // X-Tenant-ID header.
      nav('/admin', { replace: true });
    } catch {
      /* surfaced via create.error */
    }
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
          <>
            <span className="greet">welcome, {me.data?.name?.split(' ')[0] ?? 'there'}.</span>
            <h1>Create your first workspace</h1>
            <p style={{ color: 'var(--ink-300)', fontSize: 13, marginTop: -4 }}>
              You're signed in as <strong style={{ color: 'var(--ink-50)' }}>{me.data?.email}</strong>.
              Spin up a cafe below — you'll be the owner.
            </p>
          </>
        ) : (
          <>
            <span className="greet">welcome back, {me.data?.name?.split(' ')[0] ?? 'there'}.</span>
            <h1>Pick a workspace</h1>
          </>
        )}

        {memberships.length > 0 && (
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
        )}

        {!showCreate && (
          <button
            type="button"
            className="btn"
            onClick={() => setShowCreate(true)}
            style={{ marginTop: 12, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
          >
            <Plus size={14} strokeWidth={1.5} />
            new workspace
          </button>
        )}

        {showCreate && (
          <form
            onSubmit={onCreate}
            className="login-card"
            style={{ width: 'auto', padding: 20, marginTop: memberships.length > 0 ? 8 : 0 }}
          >
            {create.isError && (
              <div className="banner-error">
                {create.error?.message ?? 'Could not create workspace'}
              </div>
            )}
            <label>Cafe name</label>
            <input
              type="text"
              value={name}
              placeholder="e.g. Sahan Cafe"
              onChange={(e) => {
                setName(e.target.value);
                if (!customSlug) {
                  // live preview
                }
              }}
              autoFocus
              required
            />
            <label>URL slug (optional)</label>
            <input
              type="text"
              value={customSlug}
              placeholder={defaultSlug(name) || 'sahan-cafe'}
              onChange={(e) => setCustomSlug(e.target.value)}
            />
            <p className="hint" style={{ marginTop: -4 }}>
              Lowercase letters, numbers, and dashes. Used as the workspace handle.
            </p>
            <button
              type="submit"
              className="btn primary"
              disabled={create.isPending || !name.trim()}
              style={{ width: '100%' }}
            >
              {create.isPending ? 'Creating…' : 'Create workspace'}
            </button>
            {memberships.length > 0 && (
              <button
                type="button"
                className="btn"
                onClick={() => setShowCreate(false)}
                style={{ width: '100%', marginTop: 8 }}
              >
                cancel
              </button>
            )}
          </form>
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

function defaultSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}
