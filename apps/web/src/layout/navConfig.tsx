import {
  LayoutDashboard,
  ClipboardList,
  ChefHat,
  ScrollText,
  Banknote,
  Coffee,
  LayoutGrid,
  Store,
  Boxes,
  Receipt,
  Bookmark,
  Wallet,
  Crown,
  BarChart3,
  TrendingUp,
  Users,
  IdCard,
  Shield,
  History,
  Gauge,
  Settings as SettingsIcon,
  GraduationCap,
  Coins,
  type LucideIcon,
} from 'lucide-react';
import type { Permission } from '@cafe-mgmt/rbac';

import { can, canAny, hasFeature, type Me } from '@/lib/api';

// =========================================================================
// Single source of truth for admin navigation.
//
// Both the sidebar (AdminShell) and the Site map page render from this list,
// so the two can never drift. Each item declares the permission(s) that gate
// it; `visibleSections` filters the tree down to what a given member may see
// and drops any group left empty. Descriptions are written for the Site map —
// one short line explaining what each section is for.
// =========================================================================

export type NavItem = {
  to: string;
  label: string;
  icon: LucideIcon;
  description: string;
  /** Exact-match route (used by the Dashboard "/admin" index). */
  end?: boolean;
  /** Single permission gate. */
  perm?: Permission;
  /** Visible if the member holds ANY of these (management pages). */
  anyOf?: Permission[];
  /** Plan-feature gate (key from billing.Registry). Hidden unless the tenant's
   *  plan includes it — stacks with any perm/anyOf gate. */
  feature?: string;
  /** Sidebar-only render hook (e.g. the Shift open/closed pill). */
  badge?: 'shift';
};

export type NavGroup = { title: string; items: NavItem[] };

export const NAV_SECTIONS: NavGroup[] = [
  {
    title: 'Operations',
    items: [
      {
        to: '/admin',
        label: 'Dashboard',
        icon: LayoutDashboard,
        description: 'At-a-glance sales, cafe balance and alerts.',
        end: true,
        perm: 'report:read',
      },
      {
        to: '/admin/floor',
        label: 'Floor',
        icon: ClipboardList,
        description: 'Open tabs and the live service floor.',
        perm: 'order:read',
      },
      {
        to: '/admin/kitchen',
        label: 'Kitchen',
        icon: ChefHat,
        description: 'Kitchen display of pending tickets.',
        perm: 'kitchen:read',
      },
      {
        to: '/admin/history',
        label: 'History',
        icon: ScrollText,
        description: 'Closed serves day-by-day, with each day’s sales total and cash/online split.',
        perm: 'order:read',
      },
      {
        to: '/admin/shift',
        label: 'Shift',
        icon: Banknote,
        description: 'Open or close the till and reconcile the cash drawer.',
        perm: 'shift:read',
        badge: 'shift',
      },
    ],
  },
  {
    title: 'Catalog',
    items: [
      {
        to: '/admin/menu',
        label: 'Menu',
        icon: Coffee,
        description: 'Items, categories, pricing and cost.',
        anyOf: ['menu:create', 'menu:update', 'menu:delete'],
      },
      {
        to: '/admin/tables',
        label: 'Tables',
        icon: LayoutGrid,
        description: 'Service tables and floor layout.',
        anyOf: ['table:create', 'table:update', 'table:delete'],
      },
      {
        to: '/admin/outlets',
        label: 'Outlets',
        icon: Store,
        description: 'Prep stations (Kitchen, Bar) and their printers.',
        anyOf: ['outlet:create', 'outlet:update', 'outlet:delete'],
      },
    ],
  },
  {
    title: 'Admin',
    items: [
      {
        to: '/admin/inventory',
        label: 'Inventory',
        icon: Boxes,
        description: 'Stock levels and low-stock alerts.',
        perm: 'inventory:read',
      },
      {
        to: '/admin/expenses',
        label: 'Expenses',
        icon: Receipt,
        description: 'Record and review spending.',
        perm: 'expense:read',
      },
      {
        to: '/admin/house-tabs',
        label: 'Tabs',
        icon: Bookmark,
        description: 'Stakeholder house tabs and their balances.',
        perm: 'house_tab:read',
      },
      {
        to: '/admin/accounts',
        label: 'Cafe balance',
        icon: Wallet,
        description: 'Cash drawer, bank and online balances, with transfers.',
        perm: 'account:read',
      },
      {
        to: '/admin/owners',
        label: 'Owners',
        icon: Crown,
        description: 'Ownership, equity, investments and loans.',
        perm: 'finance:read',
      },
      {
        to: '/admin/reports/profitability',
        label: 'Profitability',
        icon: BarChart3,
        description: 'Revenue, cost and gross margin by category, over any range.',
        perm: 'report:read',
      },
      {
        to: '/admin/reports/movers',
        label: 'Movers',
        icon: TrendingUp,
        description: 'Every item ranked by sales, with filters and per-item trends.',
        perm: 'report:read',
        feature: 'advanced_analytics',
      },
      {
        to: '/admin/team',
        label: 'Team',
        icon: Users,
        description: 'Members and the roles assigned to them.',
        perm: 'member:read',
      },
      {
        to: '/admin/staff',
        label: 'Staff',
        icon: IdCard,
        description: 'Employee profiles and their personal documents.',
        perm: 'staff:read',
      },
      {
        to: '/admin/roles',
        label: 'Roles',
        icon: Shield,
        description: 'Custom roles and their permissions.',
        perm: 'role:read',
      },
      {
        to: '/admin/activity',
        label: 'Activity',
        icon: History,
        description: 'Audit timeline of who changed what, when.',
        perm: 'audit:read',
        feature: 'audit_logs',
      },
      {
        to: '/admin/plan',
        label: 'Plan & usage',
        icon: Gauge,
        description: 'Your subscription plan, seat usage and trial status.',
        perm: 'tenant:update',
      },
      {
        to: '/admin/settings',
        label: 'Settings',
        icon: SettingsIcon,
        description: 'Workspace branding, preferences and integrations.',
        perm: 'tenant:update',
      },
    ],
  },
  {
    title: 'Learn',
    items: [
      {
        to: '/admin/guide',
        label: 'GoServe Training',
        icon: GraduationCap,
        // No perm — learning material is open to every member of any tenant.
        description: 'Guides, walkthroughs, and how every number is calculated.',
      },
      {
        to: '/admin/money-flow',
        label: 'Money flow (demo)',
        icon: Coins,
        // No perm — a learning sandbox, open to everyone.
        description: 'An interactive practice sandbox for how cash moves and what counts toward the balance. Made-up numbers — never touches real data.',
      },
    ],
  },
];

function itemVisible(me: Me | undefined, item: NavItem): boolean {
  if (item.feature && !hasFeature(me, item.feature)) return false;
  if (item.anyOf) return canAny(me, ...item.anyOf);
  if (item.perm) return can(me, item.perm);
  return true;
}

/**
 * Filter the nav tree to the sections/items the member may see, dropping any
 * group left with no visible items. Used by both the sidebar and the Site map.
 */
export function visibleSections(me: Me | undefined): NavGroup[] {
  return NAV_SECTIONS.map((g) => ({
    ...g,
    items: g.items.filter((it) => itemVisible(me, it)),
  })).filter((g) => g.items.length > 0);
}
