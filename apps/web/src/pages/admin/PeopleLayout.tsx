import { Users, IdCard, Shield } from 'lucide-react';
import { Navigate, Outlet } from 'react-router-dom';

import { useMe, can } from '@/lib/api';
import { SectionNavContext, SectionTabs, type SectionTabItem } from '@/layout/SectionNav';

// The three people/permissions pages (Members, Staff, Roles) live under one
// "People" sidebar entry. This layout publishes the sub-nav; each child page
// renders unchanged and picks it up via PageShell.
function peopleTabs(me: ReturnType<typeof useMe>['data']): SectionTabItem[] {
  const items: SectionTabItem[] = [];
  if (can(me, 'member:read'))
    items.push({ to: '/admin/people/members', label: 'Members', icon: <Users size={12} strokeWidth={1.6} /> });
  if (can(me, 'staff:read'))
    items.push({ to: '/admin/people/staff', label: 'Staff', icon: <IdCard size={12} strokeWidth={1.6} /> });
  if (can(me, 'role:read'))
    items.push({ to: '/admin/people/roles', label: 'Roles', icon: <Shield size={12} strokeWidth={1.6} /> });
  return items;
}

export function PeopleLayout() {
  const me = useMe();
  const nav = <SectionTabs items={peopleTabs(me.data)} />;
  return (
    <SectionNavContext.Provider value={nav}>
      <Outlet />
    </SectionNavContext.Provider>
  );
}

/** Index redirect for /admin/people → the first tab the member can see. */
export function PeopleIndex() {
  const me = useMe();
  const first = peopleTabs(me.data)[0]?.to ?? '/admin/people/members';
  return <Navigate to={first} replace />;
}
