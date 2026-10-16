import { createPortal } from 'react-dom';
import { Check, ChevronsUpDown, Layers } from 'lucide-react';
import type { Me } from '@cafe-mgmt/api-types';

import { usePopover } from '@/components/usePopover';
import { branchColor, branchLabel, hasBranches } from '@/lib/branches';
import { useBranchNav, useOverview } from '@/lib/useBranchNav';

type Props = {
  me: Me | undefined;
  slug: string | null;
};

const POP_WIDTH = 260;

/**
 * Sidebar-head control for moving between branches of a business — or looking
 * at all of them at once — and between unrelated workspaces. Replaces the old
 * native <select>.
 *
 * One control for both questions a multi-branch owner asks: "where am I
 * working?" (a branch) and "what am I looking at?" (one branch, or All
 * branches on the dashboard).
 *
 * Invisible until needed, like Stations: one membership → nothing renders, and
 * the sidebar head looks exactly as it always has.
 *
 * Portalled to <body> via usePopover for the same stacking-context reason as
 * AccountMenu (aside.side's z:1 would trap it under main).
 */
export function BranchSwitcher({ me, slug }: Props) {
  const pop = usePopover<HTMLButtonElement, HTMLDivElement>({ width: POP_WIDTH, gap: 6 });
  const { open, close } = pop;
  const overview = useOverview();
  const { goToBranch, goToOverview } = useBranchNav();

  const multiBranch = hasBranches(me);
  const memberships = me?.memberships ?? [];
  if (!multiBranch && memberships.length <= 1) return null;

  const business = me?.business;
  const branches = multiBranch ? (me?.branches ?? []) : [];
  const branchSlugs = new Set(branches.map((b) => b.slug));
  const others = memberships.filter((m) => !branchSlugs.has(m.tenant_slug) && m.status === 'active');
  const active = branches.find((b) => b.slug === slug);
  const activeMembership = memberships.find((m) => m.tenant_slug === slug);

  const triggerLabel = overview.active
    ? 'All branches'
    : active
      ? branchLabel(active.name, business?.name)
      : (activeMembership?.tenant_name ?? slug ?? 'Workspace');

  const pickBranch = (next: string) => {
    close();
    if (next !== slug || overview.active) goToBranch(next);
  };

  return (
    <div className={`branch-switch${open ? ' open' : ''}`}>
      <button
        type="button"
        ref={pop.triggerRef}
        className="branch-switch__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${multiBranch ? 'Branch' : 'Workspace'}: ${triggerLabel}. Switch`}
        onClick={pop.toggle}
      >
        {overview.active ? (
          <Layers size={13} strokeWidth={1.6} className="branch-switch__all-icon" aria-hidden />
        ) : (
          active && <span className="branch-dot" style={{ background: branchColor(branches, active.slug) }} aria-hidden />
        )}
        <span className="branch-switch__label">{triggerLabel}</span>
        <ChevronsUpDown size={13} strokeWidth={1.5} className="branch-switch__chevron" aria-hidden />
      </button>

      {open &&
        createPortal(
          <div ref={pop.popRef} className="branch-switch__pop" role="menu" style={pop.style}>
            {multiBranch && (
              <>
                <div className="branch-switch__heading">{business?.name ?? 'Branches'}</div>
                {overview.available && (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={overview.active}
                    className={`branch-switch__item branch-switch__item--all${overview.active ? ' is-current' : ''}`}
                    onClick={() => {
                      close();
                      goToOverview();
                    }}
                  >
                    <Layers size={14} strokeWidth={1.6} className="branch-switch__all-icon" aria-hidden />
                    <span className="branch-switch__name">All branches</span>
                    <span className="branch-switch__role">{branches.length}</span>
                    {overview.active && <Check size={14} strokeWidth={1.75} className="branch-switch__check" aria-hidden />}
                  </button>
                )}
                {branches.map((b) => {
                  const current = !overview.active && b.slug === slug;
                  return (
                    <button
                      key={b.slug}
                      type="button"
                      role="menuitemradio"
                      aria-checked={current}
                      className={`branch-switch__item${current ? ' is-current' : ''}`}
                      onClick={() => pickBranch(b.slug)}
                    >
                      <span className="branch-dot" style={{ background: branchColor(branches, b.slug) }} aria-hidden />
                      <span className="branch-switch__name">{branchLabel(b.name, business?.name)}</span>
                      <span className="branch-switch__role">{b.roles.join('+')}</span>
                      {current && <Check size={14} strokeWidth={1.75} className="branch-switch__check" aria-hidden />}
                    </button>
                  );
                })}
              </>
            )}
            {others.length > 0 && (
              <>
                <div className="branch-switch__heading">{multiBranch ? 'Other workspaces' : 'Workspaces'}</div>
                {others.map((m) => {
                  const current = !overview.active && m.tenant_slug === slug;
                  return (
                    <button
                      key={m.tenant_slug}
                      type="button"
                      role="menuitemradio"
                      aria-checked={current}
                      className={`branch-switch__item${current ? ' is-current' : ''}`}
                      onClick={() => pickBranch(m.tenant_slug)}
                    >
                      <span className="branch-switch__name">{m.tenant_name}</span>
                      <span className="branch-switch__role">{m.roles.join('+')}</span>
                      {current && <Check size={14} strokeWidth={1.75} className="branch-switch__check" aria-hidden />}
                    </button>
                  );
                })}
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
