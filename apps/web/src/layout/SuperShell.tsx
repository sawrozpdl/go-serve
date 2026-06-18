import { NavLink, Outlet, Link } from 'react-router-dom';
import { Shield, Building2, Inbox, Layers, Users, ScrollText, ArrowLeft, Bug } from 'lucide-react';

import { useMe, useAdminBugReports } from '@/lib/api';

// Dedicated shell for the super-admin console. Deliberately separate from
// AdminShell: it is NOT tenant-scoped (no branding injection, no WebSocket, no
// shift pill). A `data-super` attribute tints the chrome so it's visually
// obvious you're in the cross-tenant control plane.
const NAV = [
  { to: '/super/tenants', label: 'Tenants', icon: Building2 },
  { to: '/super/requests', label: 'Requests', icon: Inbox },
  { to: '/super/bug-reports', label: 'Bug reports', icon: Bug, badge: 'bugs' as const },
  { to: '/super/plans', label: 'Plans', icon: Layers },
  { to: '/super/admins', label: 'Admins', icon: Users },
  { to: '/super/audit', label: 'Audit', icon: ScrollText },
];

export function SuperShell() {
  const me = useMe();
  // Cheap shared query (cached by react-query) so the open-bug count rides
  // along on every super page without each page re-fetching it.
  const openBugs = useAdminBugReports({ status: 'open' }).data?.summary.open ?? 0;
  return (
    <div className="super-shell" data-super>
      <header className="super-bar">
        <Link to="/super/tenants" className="super-brand">
          <span className="super-brand__mark">
            <Shield size={17} strokeWidth={2} />
          </span>
          <span className="super-brand__text">
            <span className="super-brand__name">Go Serve</span>
            <span className="super-badge">Platform Console</span>
          </span>
        </Link>
        <nav className="super-nav">
          {NAV.map(({ to, label, icon: Icon, badge }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `super-nav-link${isActive ? ' active' : ''}`}>
              <Icon size={15} strokeWidth={1.7} />
              <span>{label}</span>
              {badge === 'bugs' && openBugs > 0 && <span className="super-nav-badge">{openBugs}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="super-bar-right">
          <span className="super-who">{me.data?.email}</span>
          <Link to="/admin" className="btn">
            <ArrowLeft size={14} strokeWidth={1.6} style={{ marginRight: 4 }} /> Back to app
          </Link>
        </div>
      </header>
      <main className="super-main">
        <Outlet />
      </main>
    </div>
  );
}
