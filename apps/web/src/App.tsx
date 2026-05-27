import { useEffect, useRef } from 'react';
import { Routes, Route, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useMe, useExchangeCode } from '@/lib/api';
import { useTenant } from '@/lib/tenant';

import { Login } from '@/pages/Login';
import { PickWorkspace } from '@/pages/PickWorkspace';
import { AdminShell } from '@/layout/AdminShell';
import { Dashboard } from '@/pages/admin/Dashboard';
import { MenuPage } from '@/pages/admin/MenuPage';
import { TablesPage } from '@/pages/admin/TablesPage';
import { FloorPage } from '@/pages/admin/FloorPage';
import { TabPage } from '@/pages/admin/TabPage';
import { KitchenPage } from '@/pages/admin/KitchenPage';
import { InventoryPage } from '@/pages/admin/InventoryPage';
import { ExpensesPage } from '@/pages/admin/ExpensesPage';
import { ProfitabilityPage } from '@/pages/admin/ProfitabilityPage';
import { ShiftPage } from '@/pages/admin/ShiftPage';
import { SettingsPage } from '@/pages/admin/SettingsPage';
import { TeamPage } from '@/pages/admin/TeamPage';
import { RolesPage } from '@/pages/admin/RolesPage';
import { HouseTabsPage } from '@/pages/admin/HouseTabsPage';
import { AccountsPage } from '@/pages/admin/AccountsPage';
import { OwnersPage } from '@/pages/admin/OwnersPage';
import { ActivityPage } from '@/pages/admin/ActivityPage';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Index />} />
      <Route path="/login" element={<Login />} />
      <Route path="/login/callback" element={<AuthCallback />} />
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
        <Route index element={<Dashboard />} />
        <Route path="floor" element={<FloorPage />} />
        <Route path="floor/:orderId" element={<TabPage />} />
        <Route path="kitchen" element={<KitchenPage />} />
        <Route path="shift" element={<ShiftPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="team" element={<TeamPage />} />
        <Route path="roles" element={<RolesPage />} />
        <Route path="inventory" element={<InventoryPage />} />
        <Route path="expenses" element={<ExpensesPage />} />
        <Route path="house-tabs" element={<HouseTabsPage />} />
        <Route path="accounts" element={<AccountsPage />} />
        <Route path="owners" element={<OwnersPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="reports/profitability" element={<ProfitabilityPage />} />
        <Route path="menu" element={<MenuPage />} />
        <Route path="tables" element={<TablesPage />} />
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
