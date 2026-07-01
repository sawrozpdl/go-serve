/**
 * Proactive refresh scheduler. Refreshes the access token ~60s before it
 * expires so an idle app never lands on a 401, and heals on foreground (mobile
 * OSes freeze timers while backgrounded, so the scheduled refresh may never
 * fire for a suspended app — re-check when the user returns).
 *
 * Built as a factory with injected deps (clock + token accessors + refresh) so
 * the scheduling decision is unit-testable with fake timers.
 */
import { decodeJwtExpMs, msUntilRefresh, shouldRefreshNow } from './jwt';

export type SchedulerDeps = {
  getAccessToken: () => string | null;
  getRefreshToken: () => string | null;
  refresh: () => Promise<unknown>;
  now?: () => number;
};

export type RefreshScheduler = {
  /** (Re)arm the proactive timer from the current token's exp. */
  schedule: () => void;
  /** Call when the app returns to the foreground. */
  healOnForeground: () => void;
  /** Cancel the pending timer. */
  stop: () => void;
};

export function createRefreshScheduler(deps: SchedulerDeps): RefreshScheduler {
  const now = deps.now ?? (() => Date.now());
  let timer: ReturnType<typeof setTimeout> | null = null;

  function stop(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(): void {
    stop();
    const at = deps.getAccessToken();
    if (!at || !deps.getRefreshToken()) return; // logged out — nothing to keep warm
    const exp = decodeJwtExpMs(at);
    if (exp == null) return;
    timer = setTimeout(() => {
      void deps.refresh().finally(schedule);
    }, msUntilRefresh(exp, now()));
  }

  function healOnForeground(): void {
    if (!deps.getRefreshToken()) return;
    if (shouldRefreshNow(deps.getAccessToken(), now())) {
      void deps.refresh().finally(schedule);
    } else {
      schedule();
    }
  }

  return { schedule, healOnForeground, stop };
}
