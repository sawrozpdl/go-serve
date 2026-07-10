import { BarChart3, TrendingUp } from 'lucide-react';
import { Outlet } from 'react-router-dom';

import { useMe, hasFeature } from '@/lib/api';
import { SectionNavContext, SectionTabs, type SectionTabItem } from '@/layout/SectionNav';

// Profitability + Movers share one "Reports" sidebar entry. Movers is a
// premium feature, so its tab only shows when the plan includes it (the route
// stays reachable for direct links; the sidebar entry needs only report:read).
export function ReportsLayout() {
  const me = useMe();
  const items: SectionTabItem[] = [
    { to: '/admin/reports/profitability', label: 'Profitability', icon: <BarChart3 size={12} strokeWidth={1.6} /> },
  ];
  if (hasFeature(me.data, 'advanced_analytics'))
    items.push({ to: '/admin/reports/movers', label: 'Movers', icon: <TrendingUp size={12} strokeWidth={1.6} /> });

  return (
    <SectionNavContext.Provider value={<SectionTabs items={items} />}>
      <Outlet />
    </SectionNavContext.Provider>
  );
}
