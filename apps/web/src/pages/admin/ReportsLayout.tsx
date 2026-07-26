import { BarChart3, FileText, TrendingUp } from 'lucide-react';
import { Outlet } from 'react-router-dom';

import { useMe, hasFeature } from '@/lib/api';
import { SectionNavContext, SectionTabs, type SectionTabItem } from '@/layout/SectionNav';

// Profitability + Movers + the report builder share one "Reports" sidebar
// entry. Movers is a premium feature, so its tab only shows when the plan
// includes it (the route stays reachable for direct links; the sidebar entry
// needs only report:read).
//
// The builder tab is always shown: it composes whatever sections the member's
// role and plan allow, so it is useful on every tier — it just offers fewer
// sections on a smaller plan.
export function ReportsLayout() {
  const me = useMe();
  const items: SectionTabItem[] = [];
  if (hasFeature(me.data, 'profitability'))
    items.push({ to: '/admin/reports/profitability', label: 'Profitability', icon: <BarChart3 size={12} strokeWidth={1.6} /> });
  if (hasFeature(me.data, 'advanced_analytics'))
    items.push({ to: '/admin/reports/movers', label: 'Movers', icon: <TrendingUp size={12} strokeWidth={1.6} /> });
  items.push({ to: '/admin/reports/builder', label: 'Build a PDF', icon: <FileText size={12} strokeWidth={1.6} /> });

  return (
    <SectionNavContext.Provider value={<SectionTabs items={items} />}>
      <Outlet />
    </SectionNavContext.Provider>
  );
}
