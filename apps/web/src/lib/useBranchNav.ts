import { useLocation, useNavigate } from 'react-router-dom';
import type { Branch, BusinessInfo } from '@cafe-mgmt/api-types';

import { useBusinessBranches, useMe } from './api';
import { hasBranches, switchTarget, useBranchScopeStore } from './branches';
import { useTenant } from './tenant';

/** The business, its branches, and whether "All branches" is available and on.
 *
 *  Available = the user can read reports in at least two branches (loaded per
 *  branch, so a custom role is exact). While that list is still loading, a
 *  remembered "all" stays on, so an owner doesn't see one branch flash first. */
export function useOverview(): {
  business: BusinessInfo | undefined;
  branches: Branch[];
  available: boolean;
  active: boolean;
} {
  const me = useMe();
  const multi = hasBranches(me.data);
  const q = useBusinessBranches(multi);
  const all = useBranchScopeStore((s) => s.all);
  const branches = q.data?.branches ?? me.data?.branches ?? [];
  const readable = (q.data?.branches ?? []).filter((b) => b.can?.report_read).length;
  const available = multi && readable > 1;
  return {
    business: me.data?.business,
    branches,
    available,
    active: multi && all && (q.isPending || available),
  };
}

/** Moves between branches and in/out of overview mode, keeping the page and
 *  its filters where that makes sense. */
export function useBranchNav() {
  const { slug, setSlug } = useTenant();
  const setAll = useBranchScopeStore((s) => s.setAll);
  const nav = useNavigate();
  const loc = useLocation();

  /** Work in one branch. `path` overrides where to land. */
  const goToBranch = (next: string, path?: string) => {
    setAll(false);
    if (next !== slug) setSlug(next);
    nav(path ?? switchTarget(loc.pathname, loc.search), { replace: true });
  };

  /** Look at every branch: the dashboard, keeping its period if already there. */
  const goToOverview = () => {
    setAll(true);
    const onDash = loc.pathname === '/admin' || loc.pathname === '/admin/';
    nav(onDash ? `/admin${loc.search}` : '/admin', { replace: true });
  };

  return { goToBranch, goToOverview };
}
