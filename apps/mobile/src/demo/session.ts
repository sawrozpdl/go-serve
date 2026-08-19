/**
 * Guest ("demo") mode lifecycle.
 *
 * Entering flips the auth store's `demo` + `hasSession` flags and installs a
 * synthetic active tenant, which is all the existing router guards need — see
 * src/stores/auth.ts. From that point `src/api/client.ts` answers every request
 * from src/demo/transport.ts and no socket, poll, or fetch leaves the device.
 *
 * Two invariants:
 *  - Never write tokens. src/auth/refreshScheduler.ts only arms itself when both
 *    tokens exist, so a token-less guest makes the keep-alive timer a no-op with
 *    no edit needed. Writing a fake token would start it refreshing against the
 *    real API.
 *  - Force connectivity to 'online'. NetInfo is suppressed in demo mode, but the
 *    store may already hold 'offline' from a failed real request — and offline
 *    disables every money action (SettleSheet) and refuses to open a tab
 *    (useOrderController).
 *
 * Not persisted, on purpose: the seeded world is `now`-relative (kitchen ticket
 * ages drive the KDS colour tiers), so a demo resumed the next morning would show
 * every ticket as hours overdue. A relaunch lands on login instead, which always
 * has a working guest button.
 */
import { useAuthStore } from '../stores/auth';
import { useTenantStore } from '../stores/tenant';
import { useConnectivity } from '../stores/connectivity';
import { DEMO_TENANT } from './constants';
import { resetWorld } from './world';

export { isDemoMode } from '../stores/auth';

/** Start the guest demo from a pristine world. */
export function enterDemo(): void {
  resetWorld();
  useConnectivity.getState().setMode('online');
  useTenantStore.getState().setActive(DEMO_TENANT);
  useAuthStore.getState().startDemo();
}

/** Leave the guest demo. Same path as a real sign-out, so More's existing button
 *  works untouched; the world is re-seeded on the next enterDemo(). */
export async function exitDemo(): Promise<void> {
  await useAuthStore.getState().signOut();
  resetWorld();
}
