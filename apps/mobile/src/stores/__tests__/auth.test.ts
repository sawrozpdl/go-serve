/**
 * The guest flag's two failure modes, both of which would strand a user.
 */
import * as SecureStore from 'expo-secure-store';
import { useAuthStore } from '../auth';
import { useTenantStore } from '../tenant';
import { clearTokens, getRefreshToken, setTokens } from '../../auth/tokenStore';
import { DEMO_SLUG, DEMO_TENANT } from '../../demo/constants';

const reset = (SecureStore as unknown as { __reset: () => void }).__reset;

beforeEach(async () => {
  reset();
  await clearTokens();
  useTenantStore.getState().clear();
  useAuthStore.setState({ hydrated: false, hasSession: false, demo: false });
});

it('does not knock a guest back out to login when hydration runs', async () => {
  // A guest legitimately has no tokens, so tokenStore.hasSession() is false for
  // one. If hydrate() took that at face value the router would bounce them to
  // login mid-demo — a spontaneous logout.
  useAuthStore.getState().startDemo();
  useTenantStore.getState().setActive(DEMO_TENANT);

  await useAuthStore.getState().hydrate();

  expect(useAuthStore.getState().hasSession).toBe(true);
  expect(useAuthStore.getState().demo).toBe(true);
  expect(useTenantStore.getState().active?.slug).toBe(DEMO_SLUG);
  // And crucially it never wrote tokens — refreshScheduler only arms itself when
  // both tokens exist, which is what keeps the keep-alive timer a no-op.
  expect(getRefreshToken()).toBeNull();
});

it('clears a demo tenant left behind by a force-quit', async () => {
  // tenant.ts persists `active` to MMKV but the demo flag is not persisted. Without
  // the heal, the next cold start boots into the app shell sending
  // X-Tenant-ID: demo on REAL requests and 403s everywhere.
  useTenantStore.getState().setActive(DEMO_TENANT);
  await setTokens('access', 'refresh');

  await useAuthStore.getState().hydrate();

  expect(useAuthStore.getState().demo).toBe(false);
  expect(useTenantStore.getState().active).toBeNull();
  expect(useAuthStore.getState().hasSession).toBe(true);
});

it('leaves a real workspace alone', async () => {
  useTenantStore.getState().setActive({ slug: 'sahan', id: 't1', name: 'Sahan Cafe' });
  await setTokens('access', 'refresh');

  await useAuthStore.getState().hydrate();

  expect(useTenantStore.getState().active?.slug).toBe('sahan');
});

it('signing out leaves demo mode, so every existing exit path works', async () => {
  useAuthStore.getState().startDemo();
  useTenantStore.getState().setActive(DEMO_TENANT);

  await useAuthStore.getState().signOut();

  expect(useAuthStore.getState().demo).toBe(false);
  expect(useAuthStore.getState().hasSession).toBe(false);
  expect(useTenantStore.getState().active).toBeNull();
});
