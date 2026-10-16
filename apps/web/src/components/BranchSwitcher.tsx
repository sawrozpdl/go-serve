import { createPortal } from 'react-dom';
import { Check, ChevronsUpDown } from 'lucide-react';
import type { Me } from '@cafe-mgmt/api-types';

import { usePopover } from '@/components/usePopover';
import { branchColor, branchLabel, hasBranches } from '@/lib/branches';

type Props = {
  me: Me | undefined;
  slug: string | null;
  /** Called with the slug to switch to. */
  onSwitch: (slug: string) => void;
};

const POP_WIDTH = 260;

/**
 * Sidebar-head control for moving between branches of a business and between
 * unrelated workspaces. Replaces the old native <select>.
 *
 * Invisible until needed, like Stations: one membership → nothing renders, and
 * the sidebar head looks exactly as it always has.
 *
 * Portalled to <body> via usePopover for the same stacking-context reason as
 * AccountMenu (aside.side's z:1 would trap it under main).
 */
export function BranchSwitcher({ me, slug, onSwitch }: Props) {
  const pop = usePopover<HTMLButtonElement, HTMLDivElement>({ width: POP_WIDTH, gap: 6 });
  const { open, close } = pop;

  const multiBranch = hasBranches(me);
  const memberships = me?.memberships ?? [];
  if (!multiBranch && memberships.length <= 1) return null;

  const business = me?.business;
  const branches = multiBranch ? (me?.branches ?? []) : [];
  const branchSlugs = new Set(branches.map((b) => b.slug));
  const others = memberships.filter((m) => !branchSlugs.has(m.tenant_slug) && m.status === 'active');
  const active = branches.find((b) => b.slug === slug);
  const activeMembership = memberships.find((m) => m.tenant_slug === slug);

  const triggerLabel = active
    ? branchLabel(active.name, business?.name)
    : (activeMembership?.tenant_name ?? slug ?? 'Workspace');

  const pick = (next: string) => {
    close();
    if (next !== slug) onSwitch(next);
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
        {active && (
          <span className="branch-dot" style={{ background: branchColor(branches, active.slug) }} aria-hidden />
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
                {branches.map((b) => {
                  const current = b.slug === slug;
                  return (
                    <button
                      key={b.slug}
                      type="button"
                      role="menuitemradio"
                      aria-checked={current}
                      className={`branch-switch__item${current ? ' is-current' : ''}`}
                      onClick={() => pick(b.slug)}
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
                  const current = m.tenant_slug === slug;
                  return (
                    <button
                      key={m.tenant_slug}
                      type="button"
                      role="menuitemradio"
                      aria-checked={current}
                      className={`branch-switch__item${current ? ' is-current' : ''}`}
                      onClick={() => pick(m.tenant_slug)}
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
