/**
 * WebSocket ticket + URL helpers. The WS API can't send an Authorization
 * header, so we fetch a short-lived single-use ticket over the authed REST API
 * and pass it in the URL (same as web).
 */
import { api, API_BASE } from '../api/client';

const WS_BASE = (process.env.EXPO_PUBLIC_WS_BASE_URL ?? '').replace(/\/+$/, '');

export async function getWSTicket(slug: string): Promise<{ ticket: string }> {
  return api.post<{ ticket: string }>('/v1/ws-ticket', {}, { tenantSlug: slug });
}

/** Build the wss:// URL. WS_BASE wins (REST may be proxied while WS is direct);
 * otherwise derive from an absolute API_BASE. */
export function wsUrl(slug: string, ticket: string): string {
  const apiAbsolute = /^https?:\/\//i.test(API_BASE);
  const rawOrigin = WS_BASE || (apiAbsolute ? API_BASE : '');
  const wsOrigin = rawOrigin.replace(/^http/i, 'ws');
  return `${wsOrigin}/ws?tenant=${encodeURIComponent(slug)}&ticket=${encodeURIComponent(ticket)}`;
}
