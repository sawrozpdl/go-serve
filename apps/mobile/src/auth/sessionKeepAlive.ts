/**
 * App-level wiring of the proactive refresh scheduler: schedules on boot,
 * re-arms after login, and heals when the app returns to the foreground.
 */
import { AppState } from 'react-native';
import { getAccessToken, getRefreshToken } from './tokenStore';
import { refreshSession } from '../api/client';
import { createRefreshScheduler } from './refreshScheduler';

const scheduler = createRefreshScheduler({
  getAccessToken,
  getRefreshToken,
  refresh: refreshSession,
});

/** (Re)arm the proactive timer — call after a fresh login. */
export const armRefreshScheduler = (): void => scheduler.schedule();

/** Start keep-alive; returns a cleanup to stop the timer + AppState listener. */
export function startSessionKeepAlive(): () => void {
  scheduler.schedule();
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') scheduler.healOnForeground();
  });
  return () => {
    scheduler.stop();
    sub.remove();
  };
}
