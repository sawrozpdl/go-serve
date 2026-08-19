import { BarChart3, Gamepad2, Ticket, Users } from 'lucide-react';
import { Navigate, Outlet } from 'react-router-dom';

import { FeatureGate } from '@/components/FeatureGate';
import { SectionNavContext, SectionTabs, type SectionTabItem } from '@/layout/SectionNav';
import { can, useMe } from '@/lib/api';

// The four Engage pages under one sidebar entry, publishing their sub-nav the
// same way People and Reports do. Contacts is behind its own permission on
// purpose: seeing that a campaign works and exporting every guest's phone
// number are different privileges.
function engageTabs(me: ReturnType<typeof useMe>['data']): SectionTabItem[] {
  const items: SectionTabItem[] = [];
  if (can(me, 'engage:read')) {
    items.push({ to: '/admin/engage/campaign', label: 'Campaign', icon: <Gamepad2 size={12} strokeWidth={1.6} /> });
    items.push({ to: '/admin/engage/rewards', label: 'Rewards', icon: <Ticket size={12} strokeWidth={1.6} /> });
    items.push({ to: '/admin/engage/results', label: 'Results', icon: <BarChart3 size={12} strokeWidth={1.6} /> });
  }
  if (can(me, 'engage:contacts_read'))
    items.push({ to: '/admin/engage/contacts', label: 'Contacts', icon: <Users size={12} strokeWidth={1.6} /> });
  return items;
}

export function EngageLayout() {
  const me = useMe();
  const nav = <SectionTabs items={engageTabs(me.data)} />;
  return (
    // Gated here rather than per page: a direct URL on a café without the
    // feature gets the upgrade prompt, not a bare 403.
    <FeatureGate feature="qr_rewards">
      <SectionNavContext.Provider value={nav}>
        <Outlet />
      </SectionNavContext.Provider>
    </FeatureGate>
  );
}

export function EngageIndex() {
  const me = useMe();
  const first = engageTabs(me.data)[0]?.to ?? '/admin/engage/campaign';
  return <Navigate to={first} replace />;
}
