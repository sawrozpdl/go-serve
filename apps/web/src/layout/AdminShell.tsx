import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { LayoutDashboard, Coffee, LayoutGrid, Receipt, Boxes, BarChart3, LogOut, ClipboardList, ChefHat, Banknote, KeyRound, Settings as SettingsIcon, Menu as MenuIcon, X as XIcon, Users, Bookmark, Wallet } from 'lucide-react';

import { brandingToCss } from '@cafe-mgmt/design-tokens';

import { useMe, useLogout, useCurrentShift, useTenantSettings } from '@/lib/api';
import { useTenant } from '@/lib/tenant';
import { useRealtime } from '@/lib/ws';
import { PinModal } from '@/pages/admin/PinModal';
import { SteamingCup } from '@/components/SteamingCup';
import { Toasts } from '@/components/Toasts';

export function AdminShell() {
  const me = useMe();
  const logout = useLogout();
  const { slug, setSlug } = useTenant();
  const nav = useNavigate();
  const location = useLocation();

  // Open the WebSocket once for the whole admin lifecycle.
  useRealtime();

  const shift = useCurrentShift();
  const tenantSettings = useTenantSettings();
  const [showPin, setShowPin] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Inject per-tenant CSS variable overrides on a <style id="tenant-branding">
  // tag in <head>. Updates whenever the branding object changes. The
  // typography mode rides as a `data-typography` attribute on <html> so
  // CSS can flip heading styles per tenant without re-rendering React.
  useEffect(() => {
    const id = 'tenant-branding';
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.appendChild(el);
    }
    el.textContent = brandingToCss(tenantSettings.data?.branding ?? null);
    const mode = tenantSettings.data?.branding?.typography ?? 'editorial';
    document.documentElement.setAttribute('data-typography', mode);
  }, [tenantSettings.data?.branding]);

  // Auto-close the mobile drawer on route change so it doesn't linger.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Lock body scroll while the drawer is open on narrow screens.
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  const onLogout = async () => {
    try {
      await logout.mutateAsync();
    } finally {
      setSlug(null);
      nav('/login', { replace: true });
    }
  };

  const branding = tenantSettings.data?.branding;
  const tenantName =
    branding?.cafeName ??
    tenantSettings.data?.name ??
    me.data?.memberships.find((m) => m.tenant_slug === slug)?.tenant_name ??
    slug ??
    'Workspace';
  const memberRoles = me.data?.memberships.find((m) => m.tenant_slug === slug)?.roles ?? [];
  const isOwner = memberRoles.includes('owner');
  const isManager = memberRoles.includes('manager');

  return (
    <div className={`pos-shell${drawerOpen ? ' drawer-open' : ''}`}>
      {/* Mobile topbar — visible at ≤1024px only via CSS. */}
      <header className="mobile-topbar">
        <button
          type="button"
          className="btn icon"
          onClick={() => setDrawerOpen((v) => !v)}
          aria-label={drawerOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={drawerOpen}
        >
          {drawerOpen ? <XIcon size={18} strokeWidth={1.5} /> : <MenuIcon size={18} strokeWidth={1.5} />}
        </button>
        <div className="mt-brand">
          {branding?.logoUrl && (
            <img src={branding.logoUrl} alt="" className="mt-logo" />
          )}
          <span className="mt-name">{tenantName}</span>
        </div>
        {shift.data ? <span className="pill ok">open</span> : <span className="pill">closed</span>}
      </header>

      {drawerOpen && <div className="drawer-scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />}

      <aside className="side" aria-label="Primary navigation">
        <div className="brand">
          <div className="brand-mark">
            {branding?.logoUrl ? (
              <img src={branding.logoUrl} alt="" />
            ) : (
              <SteamingCup size={32} emoji={branding?.accentEmoji} />
            )}
          </div>
          <span className="name">{tenantName}</span>
          <span className="sub">GoServe · {slug ?? '—'}</span>
          {(me.data?.memberships.length ?? 0) > 1 && (
            <select
              value={slug ?? ''}
              onChange={(e) => {
                const next = e.target.value;
                if (next && next !== slug) {
                  setSlug(next);
                  // Bounce to the dashboard so per-page queries re-fetch
                  // under the new tenant slug without surfacing stale data.
                  nav('/admin', { replace: true });
                }
              }}
              aria-label="Switch workspace"
              style={{
                marginTop: 8,
                width: '100%',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
              }}
            >
              {me.data!.memberships.map((m) => (
                <option key={m.tenant_slug} value={m.tenant_slug}>
                  {m.tenant_name} · {m.roles.join('+')}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="group">Operations</div>
        <NavLink to="/admin" end>
          <LayoutDashboard size={16} strokeWidth={1.5} /> Dashboard
        </NavLink>
        <NavLink to="/admin/floor">
          <ClipboardList size={16} strokeWidth={1.5} /> Floor
        </NavLink>
        <NavLink to="/admin/kitchen">
          <ChefHat size={16} strokeWidth={1.5} /> Kitchen
        </NavLink>
        <NavLink to="/admin/shift">
          <Banknote size={16} strokeWidth={1.5} /> Shift
          {shift.data ? (
            <span className="pill ok" style={{ marginLeft: 'auto' }}>open</span>
          ) : (
            <span className="pill" style={{ marginLeft: 'auto' }}>closed</span>
          )}
        </NavLink>

        <div className="group">Catalog</div>
        <NavLink to="/admin/menu">
          <Coffee size={16} strokeWidth={1.5} /> Menu
        </NavLink>
        <NavLink to="/admin/tables">
          <LayoutGrid size={16} strokeWidth={1.5} /> Tables
        </NavLink>

        <div className="group">Admin</div>
        <NavLink to="/admin/inventory">
          <Boxes size={16} strokeWidth={1.5} /> Inventory
        </NavLink>
        <NavLink to="/admin/expenses">
          <Receipt size={16} strokeWidth={1.5} /> Expenses
        </NavLink>
        <NavLink to="/admin/house-tabs">
          <Bookmark size={16} strokeWidth={1.5} /> Tabs
        </NavLink>
        <NavLink to="/admin/accounts">
          <Wallet size={16} strokeWidth={1.5} /> Accounts
        </NavLink>
        <NavLink to="/admin/reports/profitability">
          <BarChart3 size={16} strokeWidth={1.5} /> Profitability
        </NavLink>
        {isOwner && (
          <NavLink to="/admin/team">
            <Users size={16} strokeWidth={1.5} /> Team
          </NavLink>
        )}
        {isOwner && (
          <NavLink to="/admin/settings">
            <SettingsIcon size={16} strokeWidth={1.5} /> Settings
          </NavLink>
        )}

        <div className="footer-sm">
          <span>{me.data?.email}</span>
          {memberRoles.length > 0 && (
            <span style={{ color: 'var(--amber-500)' }}>{memberRoles.join('+')}</span>
          )}
          {(isOwner || isManager) && (
            <button type="button" className="btn icon" onClick={() => setShowPin(true)}>
              <KeyRound size={14} strokeWidth={1.5} /> Approval PIN
            </button>
          )}
          <button type="button" className="btn icon" onClick={onLogout} title="Sign out">
            <LogOut size={14} strokeWidth={1.5} /> Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        <Outlet />
      </main>

      <PinModal open={showPin} onClose={() => setShowPin(false)} />
      <Toasts />
    </div>
  );
}
