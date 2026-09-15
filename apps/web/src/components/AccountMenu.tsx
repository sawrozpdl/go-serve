import { createPortal } from 'react-dom';
import { ChevronUp, Bug, Shield, LogOut } from 'lucide-react';
import { NavLink } from 'react-router-dom';

import { ThemeSwitcher } from '@/components/ThemeSwitcher';
import { usePopover } from '@/components/usePopover';

type Props = {
  email?: string;
  /** Roles on the active tenant, e.g. ['owner', 'admin']. */
  roles: string[];
  isPlatformAdmin: boolean;
  /** Sidebar is in the 72px icon-rail mode — show only the avatar. */
  collapsed: boolean;
  onReportBug: () => void;
  onLogout: () => void;
};

/** Matches `.account-menu__pop { width }` in admin.css — used to place the
 *  popover before it has been measured. */
const POP_WIDTH = 220;

/**
 * Sidebar-footer account control: the operator's email + role as a trigger row,
 * with a popover holding the theme switch, report-a-bug, super-admin and
 * sign-out actions.
 *
 * The popover is PORTALLED TO <body> via usePopover, and that is the whole
 * point of this component's shape. It used to render in place, `position:
 * fixed` with `z-index: 60`, as a DOM descendant of `aside.side` — which sets
 * `z-index: 1` and so opens a stacking context. `main.main` is a later sibling
 * at the same `z-index: 1`, so main paints on top of the entire sidebar
 * subtree, the popover's own 60 only ordering it against its siblings INSIDE
 * the aside. Fixed positioning escaped the sidebar's `overflow: hidden` but
 * never its stacking context, and in the collapsed rail the menu is placed
 * deliberately out over `main` — so it rendered behind page content and the
 * content swallowed its clicks. "Report a bug" was unreachable.
 *
 * Portalling is the fix the rest of the app already adopted for exactly this
 * class of bug (DatePicker, SearchSelect — see usePopover's header). As a child
 * of <body> the menu is no longer inside anyone's stacking context, and its
 * z-index is finally comparable with the rest of the scale.
 */
export function AccountMenu({
  email,
  roles,
  isPlatformAdmin,
  collapsed,
  onReportBug,
  onLogout,
}: Props) {
  // The trigger sits at the bottom of the sidebar, so placePopover flips the
  // menu above it in both rail states. In the collapsed rail that also moves it
  // clear of the connectivity pill, which is pinned to the bottom-left gutter
  // just right of the 72px rail — the other half of why the buttons could not
  // be clicked.
  const pop = usePopover<HTMLButtonElement, HTMLDivElement>({ width: POP_WIDTH, gap: 8 });
  const { open, close } = pop;

  const initial = (email?.trim()?.[0] ?? '?').toUpperCase();
  const roleLabel = roles.join('+');

  return (
    <div className={`account-menu${open ? ' open' : ''}`}>
      <button
        type="button"
        ref={pop.triggerRef}
        className="account-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={email ? `Account: ${email}` : 'Account menu'}
        onClick={pop.toggle}
      >
        <span className="account-menu__avatar" aria-hidden>
          {initial}
        </span>
        {!collapsed && (
          <span className="account-menu__id">
            <span className="account-menu__email" title={email}>
              {email ?? '—'}
            </span>
            {roleLabel && <span className="account-menu__role">{roleLabel}</span>}
          </span>
        )}
        {!collapsed && (
          <ChevronUp
            size={14}
            strokeWidth={1.5}
            className="account-menu__chevron"
            aria-hidden
          />
        )}
      </button>

      {open &&
        createPortal(
          <div ref={pop.popRef} className="account-menu__pop" role="menu" style={pop.style}>
            <ThemeSwitcher />
            <button
              type="button"
              role="menuitem"
              className="btn icon"
              onClick={() => {
                onReportBug();
                close();
              }}
            >
              <Bug size={14} strokeWidth={1.5} />
              <span>Report a bug</span>
            </button>
            {isPlatformAdmin && (
              <NavLink to="/super" role="menuitem" className="btn icon" onClick={close}>
                <Shield size={14} strokeWidth={1.5} />
                <span>Super admin</span>
              </NavLink>
            )}
            <button
              type="button"
              role="menuitem"
              className="btn icon"
              onClick={() => {
                onLogout();
                close();
              }}
            >
              <LogOut size={14} strokeWidth={1.5} />
              <span>Sign out</span>
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}
