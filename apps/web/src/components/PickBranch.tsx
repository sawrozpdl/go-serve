import { useLocation } from 'react-router-dom';
import { Layers } from 'lucide-react';

import { PageShell } from '@/components/PageShell';
import { NAV_SECTIONS } from '@/layout/navConfig';
import { branchColor, branchLabel, switchTarget } from '@/lib/branches';
import { useBranchNav, useOverview } from '@/lib/useBranchNav';

/**
 * Shown in place of a one-branch page while "All branches" is on. Floor,
 * Kitchen, Shift, Menu… each act on exactly one branch, so instead of quietly
 * showing whichever branch happens to be active, we ask — one tap, and you're
 * on this same page in that branch.
 */
export function PickBranch() {
  const { business, branches } = useOverview();
  const { goToBranch, goToOverview } = useBranchNav();
  const loc = useLocation();
  const target = switchTarget(loc.pathname, loc.search);
  // Name the page being opened ("Floor works on one branch at a time") from
  // the same nav list the sidebar renders — longest matching route wins.
  const page = NAV_SECTIONS.flatMap((g) => g.items)
    .filter((i) => i.to !== '/admin' && (loc.pathname === i.to || loc.pathname.startsWith(i.to + '/')))
    .sort((a, b) => b.to.length - a.to.length)[0]?.label;

  return (
    <PageShell eyebrow="All branches" title="Which branch?" docTitle="Pick a branch">
      <div className="pick-branch">
        <p className="pick-branch__lede">
          {page ?? 'This page'} works on one branch at a time. Pick one to open it there.
        </p>
        <div className="pick-branch__grid">
          {branches.map((b) => (
            <button key={b.slug} type="button" className="pick-branch__card" onClick={() => goToBranch(b.slug, target)}>
              <span className="branch-dot" style={{ background: branchColor(branches, b.slug) }} aria-hidden />
              <span className="pick-branch__name">{branchLabel(b.name, business?.name)}</span>
              <span className="pick-branch__role">{b.roles.join('+')}</span>
            </button>
          ))}
        </div>
        <button type="button" className="btn ghost small pick-branch__back" onClick={goToOverview}>
          <Layers size={14} strokeWidth={1.6} /> Back to the all-branches dashboard
        </button>
      </div>
    </PageShell>
  );
}
