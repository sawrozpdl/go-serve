import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';

import { useMe } from '@/lib/api';
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
import { HouseTabsPage } from '@/pages/admin/HouseTabsPage';
import { AccountsPage } from '@/pages/admin/AccountsPage';
import { OwnersPage } from '@/pages/admin/OwnersPage';
import { ActivityPage } from '@/pages/admin/ActivityPage';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Index />} />
      <Route path="/login" element={<Login />} />
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
