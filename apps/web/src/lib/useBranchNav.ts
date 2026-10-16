import { useLocation, useNavigate } from 'react-router-dom';
import type { Branch, BusinessInfo } from '@cafe-mgmt/api-types';

import { useOverviewState } from './api';
import { switchTarget, useBranchScopeStore } from './branches';
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
  const st = useOverviewState();
  return {
    business: st.me.data?.business,
    branches: st.branchesQuery.data?.branches ?? st.me.data?.branches ?? [],
    available: st.available,
    active: st.active,
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
