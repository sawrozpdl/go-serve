import { createRefreshScheduler, type SchedulerDeps } from '../refreshScheduler';

function jwtExpiringInSec(sec: number, nowMs: number): string {
  const exp = Math.floor((nowMs + sec * 1000) / 1000);
  const b64 = (o: object) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ exp })}.sig`;
}

function makeDeps(over: Partial<SchedulerDeps> = {}) {
  const NOW = 1_000_000_000_000;
  const refresh = jest.fn().mockResolvedValue(undefined);
  return {
    NOW,
    refresh,
    deps: {
      now: () => NOW,
      refresh,
      getAccessToken: () => jwtExpiringInSec(900, NOW), // 15m out
      getRefreshToken: () => 'rt',
      ...over,
    } as SchedulerDeps,
  };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('createRefreshScheduler', () => {
  it('fires a proactive refresh ~60s before expiry', () => {
    const { deps, refresh } = makeDeps();
    const s = createRefreshScheduler(deps);
    s.schedule();
    // 15m token → fires at 14m (840s). Nothing before then.
    jest.advanceTimersByTime(839_000);
    expect(refresh).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not schedule when logged out', () => {
    const { deps, refresh } = makeDeps({ getRefreshToken: () => null });
    createRefreshScheduler(deps).schedule();
    jest.advanceTimersByTime(2_000_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not schedule when the token is undecodable', () => {
    const { deps, refresh } = makeDeps({ getAccessToken: () => 'garbage' });
    createRefreshScheduler(deps).schedule();
    jest.advanceTimersByTime(2_000_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('stop() cancels the pending timer', () => {
    const { deps, refresh } = makeDeps();
    const s = createRefreshScheduler(deps);
    s.schedule();
    s.stop();
    jest.advanceTimersByTime(2_000_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('healOnForeground refreshes immediately when the token is near expiry', () => {
    const { NOW, refresh } = makeDeps();
    const s = createRefreshScheduler({
      now: () => NOW,
      refresh,
      getAccessToken: () => jwtExpiringInSec(30, NOW), // within 60s lead
      getRefreshToken: () => 'rt',
    });
    s.healOnForeground();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('healOnForeground only re-arms (no immediate refresh) when still fresh', () => {
    const { deps, refresh } = makeDeps();
    const s = createRefreshScheduler(deps);
    s.healOnForeground();
    expect(refresh).not.toHaveBeenCalled();
    jest.advanceTimersByTime(841_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('healOnForeground is a no-op when logged out', () => {
    const { deps, refresh } = makeDeps({ getRefreshToken: () => null });
    createRefreshScheduler(deps).healOnForeground();
    jest.advanceTimersByTime(2_000_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
