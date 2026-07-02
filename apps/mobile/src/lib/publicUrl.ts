/**
 * Public customer-menu URL. The menu page (/menu/:slug) is served by the web
 * app; its origin is configured via EXPO_PUBLIC_PUBLIC_MENU_BASE_URL, falling
 * back to the API origin (same domain in most single-host deploys).
 */
const RAW_BASE = process.env.EXPO_PUBLIC_PUBLIC_MENU_BASE_URL || process.env.EXPO_PUBLIC_API_BASE_URL || '';

/** Strip a trailing slash so we never emit `//menu`. Pure + tested. */
export function normalizeOrigin(base: string): string {
  return base.trim().replace(/\/+$/, '');
}

/** The shareable customer-menu link for a workspace slug. */
export function publicMenuUrl(slug: string, base: string = RAW_BASE): string {
  return `${normalizeOrigin(base)}/menu/${slug}`;
}
