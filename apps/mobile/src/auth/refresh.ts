/**
 * Single-flight refresh-token rotation.
 *
 * Tri-state result — the distinction is load-bearing for offline support:
 *   'ok'      — rotated; retry the original request.
 *   'invalid' — the server REJECTED the refresh token (401/403): the session is
 *               dead (revoked / reuse-detected / token_version bumped). Clear
 *               tokens and drop to login.
 *   'network' — the refresh never reached the server (offline / 5xx). The
 *               session may be fine; keep tokens so a wifi blip mid-shift
 *               doesn't log the cashier out.
 *
 * Built as a factory taking injected deps (token accessors + fetch) so it is
 * fully unit-testable and its single-flight guard is per-instance.
 */
import type { TokenResponse } from '@cafe-mgmt/api-types';

export type RefreshResult = 'ok' | 'invalid' | 'network';

export type RefreshDeps = {
  apiBase: string;
  getRefreshToken: () => string | null;
  setTokens: (access: string, refresh: string) => Promise<void> | void;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  /** Called when the refresh fails with a network error (offline signal). */
  onNetworkError?: () => void;
};

export type Refresher = () => Promise<RefreshResult>;

export function createRefresher(deps: RefreshDeps): Refresher {
  let inFlight: Promise<RefreshResult> | null = null;

  async function run(): Promise<RefreshResult> {
    const rt = deps.getRefreshToken();
    if (!rt) return 'invalid';
    // Resolve fetch at call time (not factory time) so a global fetch swapped
    // in later — e.g. a test spy — is picked up.
    const doFetch = deps.fetchFn ?? fetch;
    try {
      const res = await doFetch(`${deps.apiBase}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (res.status === 401 || res.status === 403) return 'invalid';
      if (!res.ok) return 'network';
      const j = (await res.json()) as TokenResponse;
      await deps.setTokens(j.access_token, j.refresh_token);
      return 'ok';
    } catch {
      deps.onNetworkError?.();
      return 'network';
    }
  }

  return function refresh(): Promise<RefreshResult> {
    // Concurrent callers share one in-flight /auth/refresh so we never rotate
    // the refresh token twice (which would trip server reuse-detection).
    if (inFlight) return inFlight;
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
