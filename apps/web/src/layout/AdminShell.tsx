import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { LayoutDashboard, Coffee, LayoutGrid, Receipt, Boxes, BarChart3, LogOut, ClipboardList, ChefHat, Banknote, KeyRound, Settings as SettingsIcon, Menu as MenuIcon, X as XIcon, Users, Bookmark, Wallet, History, PanelLeftClose, PanelLeftOpen } from 'lucide-react';

import { brandingToCss } from '@cafe-mgmt/design-tokens';

import { useMe, useLogout, useCurrentShift, useTenantSettings } from '@/lib/api';
import { useTenant } from '@/lib/tenant';
import { useRealtime } from '@/lib/ws';
import { PinModal } from '@/pages/admin/PinModal';
import { SteamingCup } from '@/components/SteamingCup';
import { Toasts } from '@/components/Toasts';
import { ThemeSwitcher } from '@/components/ThemeSwitcher';

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
  // Collapsed sidebar — persisted so the layout choice survives reloads.
  // Defaults to expanded (desktop industry default; users opt into the
  // dense rail when they want more horizontal real estate).
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('cafe-sidebar-collapsed') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('cafe-sidebar-collapsed', collapsed ? '1' : '0');
    } catch {
      /* private mode — ignore */
    }
  }, [collapsed]);

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
    <div
      className={`pos-shell${drawerOpen ? ' drawer-open' : ''}${collapsed ? ' collapsed' : ''}`}
    >
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
        {shift.data ? <span className="pill ok">Open</span> : <span className="pill">Closed</span>}
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
              className="side-workspace-select"
            >
              {me.data!.memberships.map((m) => (
                <option key={m.tenant_slug} value={m.tenant_slug}>
                  {m.tenant_name} · {m.roles.join('+')}
                </option>
              ))}
            </select>
          )}
        </div>

        <nav className="side-nav" aria-label="Sections">
          <div className="group">Operations</div>
          <NavLink to="/admin" end data-tip="Dashboard">
            <LayoutDashboard size={16} strokeWidth={1.5} />
            <span className="nav-label">Dashboard</span>
          </NavLink>
          <NavLink to="/admin/floor" data-tip="Floor">
            <ClipboardList size={16} strokeWidth={1.5} />
            <span className="nav-label">Floor</span>
          </NavLink>
          <NavLink to="/admin/kitchen" data-tip="Kitchen">
            <ChefHat size={16} strokeWidth={1.5} />
            <span className="nav-label">Kitchen</span>
          </NavLink>
          <NavLink to="/admin/shift" data-tip="Shift">
            <Banknote size={16} strokeWidth={1.5} />
            <span className="nav-label">Shift</span>
            <span className={`pill ${shift.data ? 'ok' : ''} nav-pill`}>
              {shift.data ? 'open' : 'closed'}
            </span>
          </NavLink>

          <div className="group">Catalog</div>
          <NavLink to="/admin/menu" data-tip="Menu">
            <Coffee size={16} strokeWidth={1.5} />
            <span className="nav-label">Menu</span>
          </NavLink>
          <NavLink to="/admin/tables" data-tip="Tables">
            <LayoutGrid size={16} strokeWidth={1.5} />
            <span className="nav-label">Tables</span>
          </NavLink>

          <div className="group">Admin</div>
          <NavLink to="/admin/inventory" data-tip="Inventory">
            <Boxes size={16} strokeWidth={1.5} />
            <span className="nav-label">Inventory</span>
          </NavLink>
          <NavLink to="/admin/expenses" data-tip="Expenses">
            <Receipt size={16} strokeWidth={1.5} />
            <span className="nav-label">Expenses</span>
          </NavLink>
          <NavLink to="/admin/house-tabs" data-tip="Tabs">
            <Bookmark size={16} strokeWidth={1.5} />
            <span className="nav-label">Tabs</span>
          </NavLink>
          <NavLink to="/admin/accounts" data-tip="Accounts">
            <Wallet size={16} strokeWidth={1.5} />
            <span className="nav-label">Accounts</span>
          </NavLink>
          <NavLink to="/admin/reports/profitability" data-tip="Profitability">
            <BarChart3 size={16} strokeWidth={1.5} />
            <span className="nav-label">Profitability</span>
          </NavLink>
          {isOwner && (
            <NavLink to="/admin/team" data-tip="Team">
              <Users size={16} strokeWidth={1.5} />
              <span className="nav-label">Team</span>
            </NavLink>
          )}
          {(isOwner || isManager) && (
            <NavLink to="/admin/activity" data-tip="Activity">
              <History size={16} strokeWidth={1.5} />
              <span className="nav-label">Activity</span>
            </NavLink>
          )}
          {isOwner && (
            <NavLink to="/admin/settings" data-tip="Settings">
              <SettingsIcon size={16} strokeWidth={1.5} />
              <span className="nav-label">Settings</span>
            </NavLink>
          )}
        </nav>

        <div className="footer-sm">
          <span className="nav-label">{me.data?.email}</span>
          {memberRoles.length > 0 && (
            <span className="nav-label" style={{ color: 'var(--amber-fg)' }}>
              {memberRoles.join('+')}
            </span>
          )}
          {(isOwner || isManager) && (
            <button
              type="button"
              className="btn icon"
              onClick={() => setShowPin(true)}
              data-tip="Approval PIN"
            >
              <KeyRound size={14} strokeWidth={1.5} />
              <span className="nav-label">Approval PIN</span>
            </button>
          )}
          <ThemeSwitcher compact={collapsed} />
          <button
            type="button"
            className="btn icon"
            onClick={onLogout}
            title="Sign out"
            data-tip="Sign out"
          >
            <LogOut size={14} strokeWidth={1.5} />
            <span className="nav-label">Sign out</span>
          </button>
          <button
            type="button"
            className="side-collapse"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            data-tip={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? (
              <PanelLeftOpen size={14} strokeWidth={1.5} />
            ) : (
              <PanelLeftClose size={14} strokeWidth={1.5} />
            )}
            <span className="nav-label">Collapse</span>
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
