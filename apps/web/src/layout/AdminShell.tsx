import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Fragment, useEffect, useState } from 'react';
import { Menu as MenuIcon, X as XIcon, PanelLeftClose, PanelLeftOpen, LifeBuoy } from 'lucide-react';

import { brandingToCss } from '@cafe-mgmt/design-tokens';

import { useMe, useLogout, useCurrentShift, useTenantSettings, useOfflineReplay, can, isPlatformAdmin } from '@/lib/api';
import { useTenant } from '@/lib/tenant';
import { useRealtime } from '@/lib/ws';
import { unlockAudio } from '@/lib/notify';
import { ConnectivityPill } from '@/components/ConnectivityBanner';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { SteamingCup } from '@/components/SteamingCup';
import { SyncReviewTray } from '@/components/SyncReviewTray';
import { Toasts } from '@/components/Toasts';
import { BugReportModal } from '@/components/BugReportModal';
import { ContactModal } from '@/components/ContactModal';
import { UpdatePrompt } from '@/components/UpdatePrompt';
import { PlanBanners } from '@/components/PlanBanners';
import { AccountMenu } from '@/components/AccountMenu';
import { BranchSwitcher } from '@/components/BranchSwitcher';
import { branchLabel, hasBranches, isOverviewRoute } from '@/lib/branches';
import { useOverview } from '@/lib/useBranchNav';
import { PickBranch } from '@/components/PickBranch';
import { visibleSections } from '@/layout/navConfig';

// Widths where the sidebar renders as an off-canvas drawer rather than an
// inline rail — kept in sync with the matching media query in admin.css.
const MOBILE_DRAWER_QUERY = '(max-width: 1024px) and (orientation: portrait), (max-width: 900px)';

export function AdminShell() {
  const me = useMe();
  const logout = useLogout();
  const { slug, setSlug } = useTenant();
  const nav = useNavigate();
  const location = useLocation();

  // Open the WebSocket once for the whole admin lifecycle.
  useRealtime();
  // Drain the offline mutation queue whenever connectivity returns.
  useOfflineReplay();

  const shift = useCurrentShift({ enabled: can(me.data, 'shift:read') });
  const tenantSettings = useTenantSettings();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [bugOpen, setBugOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  // Collapsed sidebar — persisted so the layout choice survives reloads.
  // No stored preference: desktop defaults to expanded; tablet-sized
  // viewports (≤1280px) default to the 72px icon rail so the floor grid and
  // order screen keep their horizontal real estate. Either way the user's
  // explicit choice wins once made.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('cafe-sidebar-collapsed');
      if (stored !== null) return stored === '1';
      return window.matchMedia('(max-width: 1280px)').matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('cafe-sidebar-collapsed', collapsed ? '1' : '0');
    } catch {
      /* private mode — ignore */
    }
  }, [collapsed]);

  // On phones the sidebar is an off-canvas drawer, so the icon-rail collapse
  // mode makes no sense there (and its toggle is hidden — leaving a stored
  // `collapsed` preference stuck with no way out). Track the mobile breakpoint
  // and treat collapse as a no-op while it matches, regardless of what's in
  // localStorage.
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    try {
      return window.matchMedia(MOBILE_DRAWER_QUERY).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_DRAWER_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const effectiveCollapsed = collapsed && !isMobile;

  // Inject per-tenant CSS variable overrides on a <style id="tenant-branding">
  // tag in <head>. Updates whenever the branding object changes. The
  // typography mode rides as a `data-typography` attribute on <html> so
  // CSS can flip heading styles per tenant without re-rendering React.
  useEffect(() => {
    const id = 'tenant-branding';
    let el = document.getElementById(id) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      document.head.appendChild(el);
    }
    el.textContent = brandingToCss(tenantSettings.data?.branding ?? null);
    const mode = tenantSettings.data?.branding?.typography ?? 'editorial';
    document.documentElement.setAttribute('data-typography', mode);
  }, [tenantSettings.data?.branding]);

  // Auto-close the mobile drawer on route change so it doesn't linger.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Unlock the audio context on the first user gesture so the KDS "new
  // ticket" chirp isn't blocked by browser autoplay policy.
  useEffect(() => {
    const handler = () => {
      unlockAudio();
      window.removeEventListener('pointerdown', handler);
      window.removeEventListener('keydown', handler);
    };
    window.addEventListener('pointerdown', handler);
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('pointerdown', handler);
      window.removeEventListener('keydown', handler);
    };
  }, []);

  // Lock body scroll while the drawer is open on narrow screens.
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  const onLogout = async () => {
    try {
      await logout.mutateAsync();
    } finally {
      setSlug(null);
      nav('/login', { replace: true });
    }
  };

  const branding = tenantSettings.data?.branding;
  const tenantName =
    branding?.cafeName ??
    tenantSettings.data?.name ??
    me.data?.memberships.find((m) => m.tenant_slug === slug)?.tenant_name ??
    slug ??
    'Workspace';
  // In a business the brand line is the business; the branch shows in the
  // switcher beneath it (and after a dot on the phone topbar).
  const multiBranch = hasBranches(me.data);
  const overview = useOverview();
  const brandName = (multiBranch && me.data?.business?.name) || tenantName;
  const activeBranch = multiBranch ? me.data?.branches?.find((b) => b.slug === slug) : undefined;
  const topbarName = overview.active
    ? `${brandName} · All branches`
    : activeBranch
      ? `${brandName} · ${branchLabel(activeBranch.name, brandName)}`
      : tenantName;
  const memberRoles = me.data?.memberships.find((m) => m.tenant_slug === slug)?.roles ?? [];
  // Permission-driven nav gating lives in navConfig: `visibleSections` filters
  // the section tree down to what the active member may see and drops empty
  // groups. The system owner role grants `*:*` so they see everything; custom
  // roles get exactly what the owner gave. The sidebar and the Site map render
  // from the same list, so the two can never drift.
  const sections = visibleSections(me.data);
  // In all-branches mode there is no single drawer to report on.
  const canSeeShift = can(me.data, 'shift:read') && !overview.active;

  return (
    <div
      className={`pos-shell${drawerOpen ? ' drawer-open' : ''}${effectiveCollapsed ? ' collapsed' : ''}`}
    >
      {/* Mobile topbar — visible at ≤1024px only via CSS. */}
      <header className="mobile-topbar">
        <button
          type="button"
          className="btn icon"
          onClick={() => setDrawerOpen((v) => !v)}
          aria-label={drawerOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={drawerOpen}
        >
          {drawerOpen ? <XIcon size={18} strokeWidth={1.5} /> : <MenuIcon size={18} strokeWidth={1.5} />}
        </button>
        <div className="mt-brand">
          {branding?.logoUrl && (
            <img src={branding.logoUrl} alt="" className="mt-logo" />
          )}
          <span className="mt-name">{topbarName}</span>
        </div>
        {canSeeShift && (shift.data ? <span className="pill ok">Open</span> : <span className="pill">Closed</span>)}
      </header>

      {drawerOpen && <div className="drawer-scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />}

      <aside className="side" aria-label="Primary navigation">
        <div className="brand">
          <div className="brand-head">
            <div className="brand-mark">
              {branding?.logoUrl ? (
                <img src={branding.logoUrl} alt="" />
              ) : (
                <SteamingCup size={28} emoji={branding?.accentEmoji} />
              )}
            </div>
            <span className="name">{brandName}</span>
          </div>
          <BranchSwitcher me={me.data} slug={slug} />
        </div>

        <nav className="side-nav" aria-label="Sections">
          {sections.map((group) => (
            <Fragment key={group.title}>
              <div className="group">{group.title}</div>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <Fragment key={item.to}>
                    <NavLink to={item.to} end={item.end} data-tip={item.label}>
                      <Icon size={16} strokeWidth={1.5} />
                      <span className="nav-label">{item.label}</span>
                      {item.badge === 'shift' && !overview.active && (
                        <span className={`pill ${shift.data ? 'ok' : ''} nav-pill`}>
                          {shift.data ? 'open' : 'closed'}
                        </span>
                      )}
                    </NavLink>
                    {/* Contact us lives right below Settings — it opens the
                        support modal rather than navigating, so it's an
                        action anchor (inherits nav-link styling via
                        `aside.side a`) instead of a NavLink. */}
                    {item.to === '/admin/settings' && (
                      <a
                        className="side-action"
                        role="button"
                        tabIndex={0}
                        data-tip="Contact us"
                        onClick={() => setContactOpen(true)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setContactOpen(true);
                          }
                        }}
                      >
                        <LifeBuoy size={16} strokeWidth={1.5} />
                        <span className="nav-label">Contact us</span>
                      </a>
                    )}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
        </nav>

        <div className="footer-sm">
          <AccountMenu
            email={me.data?.email}
            roles={memberRoles}
            isPlatformAdmin={isPlatformAdmin(me.data)}
            collapsed={effectiveCollapsed}
            onReportBug={() => setBugOpen(true)}
            onLogout={onLogout}
          />
          {/* Collapse toggle is meaningless on phones (off-canvas drawer) —
              hide it there so no stored preference can strand the user. */}
          {!isMobile && (
            <button
              type="button"
              className="side-collapse"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              data-tip={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? (
                <PanelLeftOpen size={14} strokeWidth={1.5} />
              ) : (
                <PanelLeftClose size={14} strokeWidth={1.5} />
              )}
              <span className="nav-label">Collapse</span>
            </button>
          )}

          <VersionBadge collapsed={effectiveCollapsed} />
        </div>
      </aside>

      <main className="main">
        <PlanBanners onContact={() => setContactOpen(true)} />
        <SyncReviewTray />
        {/* Route-level boundary: a crash on one page recovers on navigation
            (keyed by path) instead of taking down the whole admin shell. */}
        <ErrorBoundary key={location.pathname}>
          {/* All-branches mode: only the dashboard can show every branch at
              once; any one-branch page asks which branch instead of quietly
              showing the active one. */}
          {overview.active && !isOverviewRoute(location.pathname) ? <PickBranch /> : <Outlet />}
        </ErrorBoundary>
      </main>

      <UpdatePrompt />

      {/* Fixed bottom-left status chip — outside <main> so it never shifts
          page content (toasts own bottom-right, update bar bottom-center). */}
      <ConnectivityPill />

      <BugReportModal open={bugOpen} onClose={() => setBugOpen(false)} />
      <ContactModal open={contactOpen} onClose={() => setContactOpen(false)} />

      <Toasts />
    </div>
  );
}

/** Tiny version chip pinned at the very bottom of the sidebar. Shows SemVer
 *  always; expands to "v1.1.0 · abc1234" with build timestamp tooltip when
 *  the sidebar isn't collapsed. Constants are baked at build time by
 *  `vite.config.ts` so this is zero-runtime-cost. */
function VersionBadge({ collapsed }: { collapsed: boolean }) {
  const version = __APP_VERSION__;
  const sha = __APP_GIT_SHA__;
  const buildTime = __APP_BUILD_TIME__;
  const built = buildTime ? new Date(buildTime).toLocaleString() : '';
  const tooltip = sha
    ? `v${version} · ${sha}${built ? `\nBuilt ${built}` : ''}`
    : `v${version}${built ? `\nBuilt ${built}` : ''}`;
  return (
    <div className="side-version" title={tooltip} aria-label={`Version ${version}`}>
      <span className="side-version-num">v{version}</span>
      {!collapsed && sha && <span className="side-version-sha">{sha}</span>}
    </div>
  );
}
