/* Single source of truth for the platform console's navigation.
 *
 * SuperShell renders the top bar from this list and SuperApp builds its
 * <Routes> from the same one, so a new console section can't ship as a route
 * with no way to reach it (or a nav link to a 404). Mirrors what
 * layout/navConfig.tsx does for the tenant admin app.
 */

import type { ComponentType } from 'react';
import { Building2, Inbox, Layers, Users, ScrollText, Bug, Contact, Wallet, LayoutDashboard, type LucideIcon } from 'lucide-react';

import { SuperTenantsPage } from '@/pages/super/SuperTenantsPage';
import { SuperTenantDetailPage } from '@/pages/super/SuperTenantDetailPage';
import { SuperLeadsPage } from '@/pages/super/SuperLeadsPage';
import { SuperLeadDetailPage } from '@/pages/super/SuperLeadDetailPage';
import { SuperPlansPage } from '@/pages/super/SuperPlansPage';
import { SuperAdminsPage } from '@/pages/super/SuperAdminsPage';
import { SuperAuditPage } from '@/pages/super/SuperAuditPage';
import { SuperBugReportsPage } from '@/pages/super/SuperBugReportsPage';
import { SuperPeoplePage } from '@/pages/super/SuperPeoplePage';
import { SuperMoneyPage } from '@/pages/super/SuperMoneyPage';
import { SuperOverviewPage } from '@/pages/super/SuperOverviewPage';

export type SuperNavEntry = {
  /** Path relative to /super, e.g. "tenants". */
  path: string;
  label: string;
  icon: LucideIcon;
  Page: ComponentType;
  /** A live count rendered as a nav badge. Only 'bugs' is wired today. */
  badge?: 'bugs';
  /** Child routes that belong to this section but get no nav entry of their own. */
  children?: { path: string; Page: ComponentType }[];
};

export const SUPER_NAV: SuperNavEntry[] = [
  { path: 'overview', label: 'Overview', icon: LayoutDashboard, Page: SuperOverviewPage },
  {
    path: 'tenants',
    label: 'Cafés',
    icon: Building2,
    Page: SuperTenantsPage,
    children: [{ path: 'tenants/:id', Page: SuperTenantDetailPage }],
  },
  { path: 'money', label: 'Money', icon: Wallet, Page: SuperMoneyPage },
  { path: 'people', label: 'People', icon: Contact, Page: SuperPeoplePage },
  // Replaced the old "Requests" queue in 0061 — inbound form submissions are
  // just leads with source='request_access', so they share this board.
  {
    path: 'leads',
    label: 'Leads',
    icon: Inbox,
    Page: SuperLeadsPage,
    children: [{ path: 'leads/:id', Page: SuperLeadDetailPage }],
  },
  { path: 'bug-reports', label: 'Feedback', icon: Bug, Page: SuperBugReportsPage, badge: 'bugs' },
  { path: 'plans', label: 'Plans', icon: Layers, Page: SuperPlansPage },
  { path: 'admins', label: 'Admins', icon: Users, Page: SuperAdminsPage },
  { path: 'audit', label: 'Audit', icon: ScrollText, Page: SuperAuditPage },
];

/** Where /super lands. The overview answers "what needs me today?", which is
 *  the question an admin actually opens the console with. */
export const SUPER_HOME = 'overview';
