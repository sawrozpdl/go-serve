/* Single source of truth for the platform console's navigation.
 *
 * SuperShell renders the top bar from this list and SuperApp builds its
 * <Routes> from the same one, so a new console section can't ship as a route
 * with no way to reach it (or a nav link to a 404). Mirrors what
 * layout/navConfig.tsx does for the tenant admin app.
 */

import type { ComponentType } from 'react';
import { Building2, Inbox, Layers, Users, ScrollText, Bug, Contact, type LucideIcon } from 'lucide-react';

import { SuperTenantsPage } from '@/pages/super/SuperTenantsPage';
import { SuperTenantDetailPage } from '@/pages/super/SuperTenantDetailPage';
import { SuperRequestsPage } from '@/pages/super/SuperRequestsPage';
import { SuperPlansPage } from '@/pages/super/SuperPlansPage';
import { SuperAdminsPage } from '@/pages/super/SuperAdminsPage';
import { SuperAuditPage } from '@/pages/super/SuperAuditPage';
import { SuperBugReportsPage } from '@/pages/super/SuperBugReportsPage';
import { SuperPeoplePage } from '@/pages/super/SuperPeoplePage';

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
  {
    path: 'tenants',
    label: 'Cafés',
    icon: Building2,
    Page: SuperTenantsPage,
    children: [{ path: 'tenants/:id', Page: SuperTenantDetailPage }],
  },
  { path: 'people', label: 'People', icon: Contact, Page: SuperPeoplePage },
  { path: 'requests', label: 'Requests', icon: Inbox, Page: SuperRequestsPage },
  { path: 'bug-reports', label: 'Feedback', icon: Bug, Page: SuperBugReportsPage, badge: 'bugs' },
  { path: 'plans', label: 'Plans', icon: Layers, Page: SuperPlansPage },
  { path: 'admins', label: 'Admins', icon: Users, Page: SuperAdminsPage },
  { path: 'audit', label: 'Audit', icon: ScrollText, Page: SuperAuditPage },
];

/** Where /super lands. */
export const SUPER_HOME = 'tenants';
