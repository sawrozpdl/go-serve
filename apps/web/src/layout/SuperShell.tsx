import { NavLink, Outlet, Link } from 'react-router-dom';
import { Shield, ArrowLeft } from 'lucide-react';

import { useMe, useAdminBugReports } from '@/lib/api';
import { Toasts } from '@/components/Toasts';

import { SUPER_NAV, SUPER_HOME } from './superNavConfig';

// Dedicated shell for the super-admin console. Deliberately separate from
// AdminShell: it is NOT tenant-scoped (no branding injection, no WebSocket, no
// shift pill). A `data-super` attribute tints the chrome so it's visually
// obvious you're in the cross-tenant control plane.
//
// The shell is a fixed-height flex column so pages can use <PageShell>, whose
// sticky header and internally-scrolling body need a bounded parent.
export function SuperShell() {
  const me = useMe();
  // Cheap shared query (cached by react-query) so the open-bug count rides
  // along on every super page without each page re-fetching it.
  const openBugs = useAdminBugReports({ status: 'open' }).data?.summary.open ?? 0;
  return (
    <div className="super-shell" data-super>
      <header className="super-bar">
        <Link to={`/super/${SUPER_HOME}`} className="super-brand">
          <span className="super-brand__mark">
            <Shield size={15} strokeWidth={2} />
          </span>
          <span className="super-brand__text">
            <span className="super-brand__name">Go Serve</span>
            <span className="super-badge">Platform Console</span>
          </span>
        </Link>
        <nav className="super-nav">
          {SUPER_NAV.map(({ path, label, icon: Icon, badge }) => (
            <NavLink
              key={path}
              to={`/super/${path}`}
              className={({ isActive }) => `super-nav-link${isActive ? ' active' : ''}`}
            >
              <Icon size={15} strokeWidth={1.7} />
              <span>{label}</span>
              {badge === 'bugs' && openBugs > 0 && <span className="super-nav-badge">{openBugs}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="super-bar-right">
          {/* Truncates when the nav crowds it out — keep the full address on hover. */}
          <span className="super-who" title={me.data?.email}>{me.data?.email}</span>
          <Link to="/admin" className="btn">
            <ArrowLeft size={14} strokeWidth={1.6} style={{ marginRight: 4 }} /> Back to app
          </Link>
        </div>
      </header>
      <main className="super-main">
        <Outlet />
      </main>
      {/* Mounted here as well as in AdminShell — the two shells never render
          together, and without this every console mutation committed silently. */}
      <Toasts />
    </div>
  );
}
