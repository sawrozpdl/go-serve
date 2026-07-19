import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { ChevronUp, Bug, LifeBuoy, Shield, Map as MapIcon, LogOut } from 'lucide-react';
import { NavLink } from 'react-router-dom';

import { ThemeSwitcher } from '@/components/ThemeSwitcher';
import { CONTACT_EMAIL, CONTACT_PHONE } from '@/lib/features';

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

/**
 * Sidebar-footer account control. Collapses what used to be a tall stack of
 * footer buttons (theme, report-bug, super-admin, site-map, sign-out) into a
 * single trigger row that shows the operator's email + role, plus a popover
 * holding those actions.
 *
 * Hand-rolled popover (no headless-UI lib in the repo) mirroring the
 * click-outside + Escape + getBoundingClientRect pattern in InfoHint.tsx. The
 * popover is `position: fixed` and positioned from the trigger rect so it
 * escapes the sidebar's `overflow: hidden` — opening upward in the expanded
 * rail and flipping to the right of the collapsed icon rail.
 */
export function AccountMenu({
  email,
  roles,
  isPlatformAdmin,
  collapsed,
  onReportBug,
  onLogout,
}: Props) {
  const [open, setOpen] = useState(false);
  const [popStyle, setPopStyle] = useState<CSSProperties>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Anchor the fixed popover off the live trigger rect. Collapsed → to the
  // right of the rail (bottoms aligned); expanded/drawer → upward, matching
  // the trigger width.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setPopStyle(
      collapsed
        ? { left: r.right + 10, bottom: window.innerHeight - r.bottom, width: 220 }
        : { left: r.left, bottom: window.innerHeight - r.top + 8, width: r.width },
    );
  }, [open, collapsed]);

  const close = () => setOpen(false);
  const initial = (email?.trim()?.[0] ?? '?').toUpperCase();
  const roleLabel = roles.join('+');

  return (
    <div className={`account-menu${open ? ' open' : ''}`} ref={wrapRef}>
      <button
        type="button"
        ref={triggerRef}
        className="account-menu__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={email ? `Account: ${email}` : 'Account menu'}
        onClick={() => setOpen((v) => !v)}
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

      {open && (
        <div className="account-menu__pop" role="menu" style={popStyle}>
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
          <a
            role="menuitem"
            className="btn icon"
            href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('GoServe — support')}`}
            title={CONTACT_PHONE ? `${CONTACT_EMAIL} · ${CONTACT_PHONE}` : CONTACT_EMAIL}
            onClick={close}
          >
            <LifeBuoy size={14} strokeWidth={1.5} />
            <span>Contact us</span>
          </a>
          {isPlatformAdmin && (
            <NavLink to="/super" role="menuitem" className="btn icon" onClick={close}>
              <Shield size={14} strokeWidth={1.5} />
              <span>Super admin</span>
            </NavLink>
          )}
          <NavLink to="/admin/sitemap" role="menuitem" className="btn icon" onClick={close}>
            <MapIcon size={14} strokeWidth={1.5} />
            <span>Site map</span>
          </NavLink>
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
        </div>
      )}
    </div>
  );
}
