import { useEffect, useRef, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useMe, useExchangeCode, can, isPlatformAdmin, type ApiError } from '@/lib/api';
import { RequirePermission, RequirePlatformAdmin, landingPath } from '@/lib/permissions';
import { useTenant } from '@/lib/tenant';

import { Login } from '@/pages/Login';
import { NotFound } from '@/pages/NotFound';
import { PickWorkspace } from '@/pages/PickWorkspace';
import { AdminShell } from '@/layout/AdminShell';
import { Dashboard } from '@/pages/admin/Dashboard';
import { MenuPage } from '@/pages/admin/MenuPage';
import { TablesPage } from '@/pages/admin/TablesPage';
import { OutletsPage } from '@/pages/admin/OutletsPage';
import { FloorPage } from '@/pages/admin/FloorPage';
import { TabPage } from '@/pages/admin/TabPage';
import { OrderHistoryPage } from '@/pages/admin/OrderHistoryPage';
import { KitchenPage } from '@/pages/admin/KitchenPage';
import { InventoryPage } from '@/pages/admin/InventoryPage';
import { ExpensesPage } from '@/pages/admin/ExpensesPage';
import { ProfitabilityPage } from '@/pages/admin/ProfitabilityPage';
import { ItemMoversPage } from '@/pages/admin/ItemMoversPage';
import { ShiftPage } from '@/pages/admin/ShiftPage';
import { SettingsPage } from '@/pages/admin/SettingsPage';
import { PlanPage } from '@/pages/admin/PlanPage';
import { TeamPage } from '@/pages/admin/TeamPage';
import { StaffPage } from '@/pages/admin/StaffPage';
import { StaffDetailPage } from '@/pages/admin/StaffDetailPage';
import { RolesPage } from '@/pages/admin/RolesPage';
import { HouseTabsPage } from '@/pages/admin/HouseTabsPage';
import { AccountsPage } from '@/pages/admin/AccountsPage';
import { OwnersPage } from '@/pages/admin/OwnersPage';
import { ActivityPage } from '@/pages/admin/ActivityPage';
import { SitemapPage } from '@/pages/admin/SitemapPage';
import { GuidePage } from '@/pages/admin/GuidePage';
import { MoneyFlowPage } from '@/pages/admin/MoneyFlowPage';
import { TourProvider } from '@/guide/tour/TourProvider';

// Public, code-split customer menu. Lazy so a guest scanning a QR downloads
// only the menu, not the entire staff app, and so the admin bundle isn't
// burdened by the public page's standalone stylesheet.
const MenuPublicPage = lazy(() => import('@/pages/MenuPublicPage'));
// Public, code-split onboarding form for prospective cafes.
const RequestAccess = lazy(() => import('@/pages/RequestAccess'));
// Super-admin console — lazy so the cross-tenant control plane never weighs
// down the tenant app bundle.
const SuperApp = lazy(() => import('@/pages/super/SuperApp'));

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Index />} />
      <Route path="/login" element={<Login />} />
      <Route path="/login/callback" element={<AuthCallback />} />
      <Route
        path="/request-access"
        element={
          <Suspense fallback={<div className="login-shell"><div className="empty-state">Loading…</div></div>}>
            <RequestAccess />
          </Suspense>
        }
      />
      {/* Public menu reached by scanning a desk QR. No auth, no app chrome,
          and no links back into the staff app — a guest can only read it. */}
      <Route
        path="/menu/:slug"
        element={
          <Suspense fallback={<div className="login-shell"><div className="empty-state">Loading menu…</div></div>}>
            <MenuPublicPage />
          </Suspense>
        }
      />
      <Route
        path="/pick-workspace"
        element={
          <RequireAuth>
            <PickWorkspace />
          </RequireAuth>
        }
      />
      <Route
        path="/admin"
        element={
          <RequireAuth>
            <RequireTenant>
              <TourProvider>
                <AdminShell />
              </TourProvider>
            </RequireTenant>
          </RequireAuth>
        }
      >
        <Route index element={<Home />} />
        <Route path="floor" element={<RequirePermission perm="order:read"><FloorPage /></RequirePermission>} />
        {/* Draft tab — no order exists yet; the order row is created on the first
         * item add. Listed before the dynamic :orderId so the static segment wins. */}
        <Route path="floor/new" element={<RequirePermission perm="order:create"><TabPage /></RequirePermission>} />
        <Route path="floor/:orderId" element={<RequirePermission perm="order:read"><TabPage /></RequirePermission>} />
        <Route path="history" element={<RequirePermission perm="order:read"><OrderHistoryPage /></RequirePermission>} />
        {/* Site map is open to every authenticated member — the list itself is
            permission-filtered, so a member only ever sees links they can use. */}
        <Route path="sitemap" element={<SitemapPage />} />
        {/* GoServe Training — open to every authenticated member of any tenant,
            no permission gate (learning material, not data). */}
        <Route path="guide" element={<GuidePage />} />
        {/* Interactive money-flow sandbox — also ungated learning material. */}
        <Route path="money-flow" element={<MoneyFlowPage />} />
        <Route path="kitchen" element={<RequirePermission perm="kitchen:read"><KitchenPage /></RequirePermission>} />
        <Route path="shift" element={<RequirePermission perm="shift:read"><ShiftPage /></RequirePermission>} />
        <Route path="settings" element={<RequirePermission perm="tenant:update"><SettingsPage /></RequirePermission>} />
        <Route path="plan" element={<RequirePermission perm="tenant:update"><PlanPage /></RequirePermission>} />
        <Route path="team" element={<RequirePermission perm="member:read"><TeamPage /></RequirePermission>} />
        <Route path="staff" element={<RequirePermission perm="staff:read"><StaffPage /></RequirePermission>} />
        <Route path="staff/:id" element={<RequirePermission perm="staff:read"><StaffDetailPage /></RequirePermission>} />
        <Route path="roles" element={<RequirePermission perm="role:read"><RolesPage /></RequirePermission>} />
        <Route path="inventory" element={<RequirePermission perm="inventory:read"><InventoryPage /></RequirePermission>} />
        <Route path="expenses" element={<RequirePermission perm="expense:read"><ExpensesPage /></RequirePermission>} />
        <Route path="house-tabs" element={<RequirePermission perm="house_tab:read"><HouseTabsPage /></RequirePermission>} />
        <Route path="accounts" element={<RequirePermission perm="account:read"><AccountsPage /></RequirePermission>} />
        <Route path="owners" element={<RequirePermission perm="finance:read"><OwnersPage /></RequirePermission>} />
        <Route path="activity" element={<RequirePermission perm="audit:read"><ActivityPage /></RequirePermission>} />
        <Route path="reports/profitability" element={<RequirePermission perm="report:read"><ProfitabilityPage /></RequirePermission>} />
        <Route path="reports/movers" element={<RequirePermission perm="report:read"><ItemMoversPage /></RequirePermission>} />
        <Route path="menu" element={<RequirePermission anyOf={['menu:create', 'menu:update', 'menu:delete']}><MenuPage /></RequirePermission>} />
        <Route path="tables" element={<RequirePermission anyOf={['table:create', 'table:update', 'table:delete']}><TablesPage /></RequirePermission>} />
        <Route path="outlets" element={<RequirePermission anyOf={['outlet:create', 'outlet:update', 'outlet:delete']}><OutletsPage /></RequirePermission>} />
      </Route>
      {/* Super-admin console — platform admins only, NOT tenant-scoped. */}
      <Route
        path="/super/*"
        element={
          <RequireAuth>
            <RequirePlatformAdmin>
              <Suspense fallback={<div className="login-shell"><div className="empty-state">Loading…</div></div>}>
                <SuperApp />
              </Suspense>
            </RequirePlatformAdmin>
          </RequireAuth>
        }
      />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

// AuthCallback lands here after Google OAuth: the API redirected to
// /login/callback?code=<one-time>. (Not /auth/* — that prefix is proxied to
// the API by the dev Vite server.) We exchange the code for tokens, then route
// into the app. Guarded so React StrictMode's double-effect doesn't redeem the
// single-use code twice.
function AuthCallback() {
  const exchange = useExchangeCode();
  const nav = useNavigate();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const code = new URLSearchParams(window.location.search).get('code');
    if (!code) {
      nav('/login', { replace: true });
      return;
    }
    exchange
      .mutateAsync({ code })
      .then(() => nav('/pick-workspace', { replace: true }))
      .catch(() => nav('/login', { replace: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="login-shell">
      <div className="empty-state">Signing you in…</div>
    </div>
  );
}

function Index() {
  const me = useMe({ retry: false });
  const { slug } = useTenant();

  // After Google OAuth the API redirects to POST_LOGIN_REDIRECT_URL with a
  // one-time ?code=. If that's configured as the SPA root (rather than
  // /login/callback) we still catch the code here and hand it to the callback
  // route, preserving the query — so login works regardless of the exact
  // redirect target.
  if (new URLSearchParams(window.location.search).has('code')) {
    return <Navigate to={`/login/callback${window.location.search}`} replace />;
  }

  if (me.isPending) {
    return (
      <div className="login-shell">
        <div className="empty-state">Loading…</div>
      </div>
    );
  }
  // Only a real auth rejection goes to /login. A network failure (status 0)
  // with a cached session keeps the user in the app — offline POS must not
  // bounce a logged-in cashier to a login form they can't submit.
  if (me.isError && !me.data) {
    if ((me.error as ApiError | undefined)?.status === 0) return <OfflineNoSession />;
    return <Navigate to="/login" replace />;
  }
  // A persisted slug is only trustworthy if it still maps to one of the user's
  // ACTIVE memberships. A stale slug — a workspace the user left, or a tenant a
  // platform admin merely inspected in /super — must NOT route to /admin: that
  // flashes the "no access" screen and the first tenant-scoped request 403s,
  // hard-bouncing the user to the picker. Hand any uncertain case to the picker
  // instead; it auto-enters a sole workspace, clears a stale slug, or shows the
  // empty state. A platform admin with no workspace belongs in /super.
  const memberships = me.data?.memberships ?? [];
  const onActiveMembership =
    !!slug && memberships.some((m) => m.tenant_slug === slug && m.status === 'active');
  if (onActiveMembership) return <Navigate to="/admin" replace />;
  if (memberships.length === 0 && isPlatformAdmin(me.data)) {
    return <Navigate to="/super" replace />;
  }
  return <Navigate to="/pick-workspace" replace />;
}

// The /admin index. The dashboard needs `report:read` (owner/manager), so a
// member without it (e.g. a waiter or kitchen role) is routed to the first
// section they can actually reach instead of landing on a 403'ing dashboard.
function Home() {
  const me = useMe();
  if (me.isPending) {
    return (
      <div className="login-shell">
        <div className="empty-state">Loading…</div>
      </div>
    );
  }
  if (can(me.data, 'report:read')) return <Dashboard />;
  const dest = landingPath(me.data);
  if (dest) return <Navigate to={dest} replace />;
  // A platform admin with no section access on this tenant belongs in the
  // super console, not staring at a dead-end "ask your owner" message.
  if (isPlatformAdmin(me.data)) return <Navigate to="/super" replace />;
  return (
    <div className="empty-state">
      You don't have access to any section yet.
      <br />
      Ask a workspace owner to grant your role access.
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const me = useMe({ retry: false });
  const loc = useLocation();

  if (me.isPending) {
    return (
      <div className="login-shell">
        <div className="empty-state">Loading…</div>
      </div>
    );
  }
  // Cached identity (from the persisted query cache) keeps the app usable
  // even when the refetch errored; only a genuine rejection redirects. A
  // status-0 error means the network is down — with no cached session we
  // can't do anything useful, so explain rather than show a dead login form.
  if (me.isError && !me.data) {
    if ((me.error as ApiError | undefined)?.status === 0) return <OfflineNoSession />;
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  }
  return <>{children}</>;
}

function OfflineNoSession() {
  return (
    <div className="login-shell">
      <div className="login-card" role="alert">
        <h1>You're offline</h1>
        <p className="sub">and there's no saved session on this device</p>
        <p className="hint">
          Reconnect to the internet to sign in. If you were signed in before, reopening the app
          once online will restore your session.
        </p>
        <div className="modal-actions" style={{ marginTop: 16 }}>
          <button type="button" className="btn primary" onClick={() => location.reload()}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}

function RequireTenant({ children }: { children: React.ReactNode }) {
  const { slug } = useTenant();
  if (!slug) return <Navigate to="/pick-workspace" replace />;
  return <>{children}</>;
}

// Re-export for routes that just need a layout wrapper.
export const _ = Outlet;
