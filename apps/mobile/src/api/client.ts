/**
 * Token-aware fetch layer. Sends `Authorization: Bearer` + `X-Tenant-ID`,
 * transparently rotates the refresh token on a 401 and retries once, and
 * surfaces a synthetic status-0 ApiError when the network is down so callers
 * (and the offline queue, M5) can tell "offline" from a server error.
 *
 * Ported from web's `lib/api.ts` request wrapper; the navigation side-effects
 * (logout bounce) are injected via `setAuthHandlers` since we're outside the
 * component tree.
 */
import type { ApiError } from '@cafe-mgmt/api-types';
import { getAccessToken, getRefreshToken, setTokens } from '../auth/tokenStore';
import { createRefresher } from '../auth/refresh';
import { markOffline, markOnline } from '../stores/connectivity';

export const API_BASE = (process.env.EXPO_PUBLIC_API_BASE_URL ?? '').replace(/\/+$/, '');

type AuthHandlers = {
  /** Session is truly dead (refresh rejected) — sign out + go to login. */
  onUnauthenticated: () => void;
};

let handlers: AuthHandlers = { onUnauthenticated: () => {} };

/** Wire navigation/store side-effects once at app startup. */
export function setAuthHandlers(h: AuthHandlers): void {
  handlers = h;
}

const refresh = createRefresher({
  apiBase: API_BASE,
  getRefreshToken,
  setTokens,
  onNetworkError: markOffline,
});

/** Exposed for the proactive refresh scheduler (shares the single-flight guard
 * with the reactive 401 path). */
export const refreshSession = refresh;

export type RequestOpts = {
  tenantSlug?: string;
  body?: unknown;
  signal?: AbortSignal;
};

function toApiError(status: number, body: unknown): ApiError {
  const j = (body ?? {}) as Record<string, unknown>;
  return {
    status,
    message: typeof j.message === 'string' ? j.message : `HTTP ${status}`,
    code: typeof j.code === 'string' ? j.code : undefined,
    retry_after_seconds:
      typeof j.retry_after_seconds === 'number' ? j.retry_after_seconds : undefined,
    attempts_remaining:
      typeof j.attempts_remaining === 'number' ? j.attempts_remaining : undefined,
    workspaces: Array.isArray(j.workspaces) ? (j.workspaces as string[]) : undefined,
  };
}

export async function request<T>(
  method: string,
  path: string,
  opts: RequestOpts = {},
  retried = false,
): Promise<T> {
  // FormData bodies (multipart uploads) must NOT get a JSON Content-Type —
  // fetch sets the multipart boundary itself.
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
  if (opts.tenantSlug) headers['X-Tenant-ID'] = opts.tenantSlug;
  const at = getAccessToken();
  if (at) headers.Authorization = `Bearer ${at}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch {
    markOffline();
    const err: ApiError = { status: 0, code: 'network', message: 'You appear to be offline.' };
    throw err;
  }
  markOnline();

  // Transparent refresh-on-401: rotate once and retry. Skip /auth/* (the login
  // and refresh endpoints) and a request we've already retried. Only a server
  // REJECTION of the refresh token logs the user out; a network failure keeps
  // the session for when connectivity returns.
  if (res.status === 401 && !retried && !path.startsWith('/auth/') && getRefreshToken()) {
    const result = await refresh();
    if (result === 'ok') return request<T>(method, path, opts, true);
    if (result === 'invalid') handlers.onUnauthenticated();
  }

  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      throw nonJsonError(res.status);
    }
    throw toApiError(res.status, body);
  }

  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    // A 2xx body that isn't JSON almost always means the request hit the wrong
    // server (e.g. the Metro dev server's HTML) rather than the API.
    throw nonJsonError(res.status);
  }
}

function nonJsonError(status: number): ApiError {
  if (API_BASE === '') {
    return {
      status,
      code: 'bad_response',
      message:
        'No API URL is configured. Set EXPO_PUBLIC_API_BASE_URL in apps/mobile/.env and restart Metro.',
    };
  }
  if (status === 404) {
    return {
      status,
      code: 'not_found',
      message: `This endpoint isn't available on ${API_BASE} (HTTP 404). The backend is likely an older build — redeploy the API.`,
    };
  }
  return {
    status,
    code: 'bad_response',
    message: `The API at ${API_BASE} returned a non-JSON response (HTTP ${status}).`,
  };
}

export const api = {
  get: <T>(path: string, opts?: RequestOpts) => request<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOpts) =>
    request<T>('POST', path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOpts) =>
    request<T>('PATCH', path, { ...opts, body }),
  del: <T>(path: string, opts?: RequestOpts) => request<T>('DELETE', path, opts),
};
