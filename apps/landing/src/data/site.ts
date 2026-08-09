/* Central site config — brand, URLs, contacts, navigation. Single source
 * of truth so the header, footer, CTAs, and the contact form island can
 * never drift. Every external URL is env-overridable; anything an island
 * needs at runtime is read from a PUBLIC_* var so it survives the client
 * bundle. `||` (not `??`) throughout: an unset CI variable arrives as ""
 * and must still fall back to the default. */

const stripSlash = (u: string) => u.replace(/\/+$/, '');

/** Origin of the live app (login + request-access live here). */
export const APP_URL = stripSlash(import.meta.env.PUBLIC_APP_URL || 'https://app.goserve.com.np');
/** API origin the public contact form posts to. */
export const API_URL = stripSlash(import.meta.env.PUBLIC_API_URL || 'https://api.goserve.com.np');

export const LOGIN_URL = `${APP_URL}/login`;
export const SIGNUP_URL = `${APP_URL}/request-access`;
/** Public, unauthenticated lead-capture endpoint. */
export const REQUEST_ACCESS_ENDPOINT = `${API_URL}/public/request-access`;

export const CONTACT_EMAIL = import.meta.env.PUBLIC_CONTACT_EMAIL || 'hello@goserve.com.np';
export const CONTACT_PHONE = import.meta.env.PUBLIC_CONTACT_PHONE || '';

export const BRAND = {
  name: 'GoServe',
  tagline: 'The point of sale built for cafes.',
  city: 'Kathmandu',
  country: 'Nepal',
};

/* Base-aware link helper. Astro does not prepend the configured `base` to
 * plain <a href> values, so internal links must run through this. Returns
 * a root-relative path with the deploy base folded in. */
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');
export const withBase = (p: string) => {
  if (/^(https?:)?\/\//.test(p) || p.startsWith('mailto:') || p.startsWith('tel:')) return p;
  const path = p.startsWith('/') ? p : `/${p}`;
  return `${BASE}${path}` || '/';
};

export type NavLink = { label: string; href: string };
/** Primary nav — hrefs are plain paths; components apply withBase(). */
export const NAV_LINKS: NavLink[] = [
  { label: 'Features', href: '/features' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Blog', href: '/blog' },
  { label: 'Resources', href: '/resources' },
  { label: 'Contact', href: '/contact' },
];

export const FOOTER_NAV: { title: string; links: NavLink[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'Features', href: '/features' },
      { label: 'Pricing', href: '/pricing' },
      { label: 'Live demo', href: '/#playground' },
      { label: 'Hardware & payments', href: '/hardware' },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'Help centre', href: '/resources' },
      { label: 'Blog', href: '/blog' },
      { label: 'Reviews', href: '/reviews' },
      { label: 'FAQ', href: '/#faq' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'Contact', href: '/contact' },
      { label: 'Log in', href: APP_URL + '/login' },
      { label: 'Start free trial', href: APP_URL + '/request-access' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Privacy policy', href: '/privacy' },
      { label: 'Terms of service', href: '/terms' },
    ],
  },
];

export type SupportLine = { label: string; phone: string };
/* Direct phone lines, labelled by what they're for — the public site publishes
 * contact routes, not the team's identities, so no names and no personal
 * inboxes here. Email goes to the shared CONTACT_EMAIL above. */
export const SUPPORT_LINES: SupportLine[] = [
  { label: 'Product & setup', phone: CONTACT_PHONE || '9800769340' },
  { label: 'Onboarding', phone: '9843413772' },
  { label: 'Training & support', phone: '9860099303' },
];
