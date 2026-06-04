import { useEffect, useRef, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useMe, useExchangeCode, can } from '@/lib/api';
import { RequirePermission, landingPath } from '@/lib/permissions';
import { useTenant } from '@/lib/tenant';

import { Login } from '@/pages/Login';
import { PickWorkspace } from '@/pages/PickWorkspace';
import { AdminShell } from '@/layout/AdminShell';
import { Dashboard } from '@/pages/admin/Dashboard';
import { MenuPage } from '@/pages/admin/MenuPage';
import { TablesPage } from '@/pages/admin/TablesPage';
import { FloorPage } from '@/pages/admin/FloorPage';
import { TabPage } from '@/pages/admin/TabPage';
import { OrderHistoryPage } from '@/pages/admin/OrderHistoryPage';
import { KitchenPage } from '@/pages/admin/KitchenPage';
import { InventoryPage } from '@/pages/admin/InventoryPage';
import { ExpensesPage } from '@/pages/admin/ExpensesPage';
import { ProfitabilityPage } from '@/pages/admin/ProfitabilityPage';
import { ShiftPage } from '@/pages/admin/ShiftPage';
import { SettingsPage } from '@/pages/admin/SettingsPage';
import { TeamPage } from '@/pages/admin/TeamPage';
import { StaffPage } from '@/pages/admin/StaffPage';
import { StaffDetailPage } from '@/pages/admin/StaffDetailPage';
import { RolesPage } from '@/pages/admin/RolesPage';
import { HouseTabsPage } from '@/pages/admin/HouseTabsPage';
import { AccountsPage } from '@/pages/admin/AccountsPage';
import { OwnersPage } from '@/pages/admin/OwnersPage';
import { ActivityPage } from '@/pages/admin/ActivityPage';
import { SitemapPage } from '@/pages/admin/SitemapPage';

// Public, code-split customer menu. Lazy so a guest scanning a QR downloads
// only the menu, not the entire staff app, and so the admin bundle isn't
// burdened by the public page's standalone stylesheet.
const MenuPublicPage = lazy(() => import('@/pages/MenuPublicPage'));

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Index />} />
      <Route path="/login" element={<Login />} />
      <Route path="/login/callback" element={<AuthCallback />} />
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
              <AdminShell />
            </RequireTenant>
          </RequireAuth>
        }
      >
        <Route index element={<Home />} />
        <Route path="floor" element={<RequirePermission perm="order:read"><FloorPage /></RequirePermission>} />
        <Route path="floor/:orderId" element={<RequirePermission perm="order:read"><TabPage /></RequirePermission>} />
        <Route path="history" element={<RequirePermission perm="order:read"><OrderHistoryPage /></RequirePermission>} />
        {/* Site map is open to every authenticated member — the list itself is
            permission-filtered, so a member only ever sees links they can use. */}
        <Route path="sitemap" element={<SitemapPage />} />
        <Route path="kitchen" element={<RequirePermission perm="kitchen:read"><KitchenPage /></RequirePermission>} />
        <Route path="shift" element={<RequirePermission perm="shift:read"><ShiftPage /></RequirePermission>} />
        <Route path="settings" element={<RequirePermission perm="tenant:update"><SettingsPage /></RequirePermission>} />
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
        <Route path="menu" element={<RequirePermission anyOf={['menu:create', 'menu:update', 'menu:delete']}><MenuPage /></RequirePermission>} />
        <Route path="tables" element={<RequirePermission anyOf={['table:create', 'table:update', 'table:delete']}><TablesPage /></RequirePermission>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
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
  if (me.isError) return <Navigate to="/login" replace />;
  if (!slug) return <Navigate to="/pick-workspace" replace />;
  return <Navigate to="/admin" replace />;
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
  if (me.isError) {
    return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  }
  return <>{children}</>;
}

function RequireTenant({ children }: { children: React.ReactNode }) {
  const { slug } = useTenant();
  if (!slug) return <Navigate to="/pick-workspace" replace />;
  return <>{children}</>;
}

// Re-export for routes that just need a layout wrapper.
export const _ = Outlet;
