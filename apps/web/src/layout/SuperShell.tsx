import { NavLink, Outlet, Link } from 'react-router-dom';
import { Shield, Building2, Inbox, Layers, Users, ScrollText, ArrowLeft } from 'lucide-react';

import { useMe } from '@/lib/api';

// Dedicated shell for the super-admin console. Deliberately separate from
// AdminShell: it is NOT tenant-scoped (no branding injection, no WebSocket, no
// shift pill). A `data-super` attribute tints the chrome so it's visually
// obvious you're in the cross-tenant control plane.
const NAV = [
  { to: '/super/tenants', label: 'Tenants', icon: Building2 },
  { to: '/super/requests', label: 'Requests', icon: Inbox },
  { to: '/super/plans', label: 'Plans', icon: Layers },
  { to: '/super/admins', label: 'Admins', icon: Users },
  { to: '/super/audit', label: 'Audit', icon: ScrollText },
];

export function SuperShell() {
  const me = useMe();
  return (
    <div className="super-shell" data-super>
      <header className="super-bar">
        <div className="super-brand">
          <Shield size={18} strokeWidth={1.8} />
          <span>Super Admin</span>
        </div>
        <nav className="super-nav">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `super-nav-link${isActive ? ' active' : ''}`}>
              <Icon size={15} strokeWidth={1.7} />
              <span>{label}</span>
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
