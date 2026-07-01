/**
 * Token store — the access + refresh tokens live in expo-secure-store
 * (Keychain / Keystore), with a synchronous in-memory cache so the fetch layer
 * can read the current access token without an async Keychain round-trip on
 * every request. Call `hydrate()` once at cold start before rendering the
 * auth-gated tree, then getters are always current.
 *
 * This mirrors web's `getAccessToken`/`setTokens`/`clearTokens` free functions
 * but uses the OS-native secure store instead of localStorage (native has no
 * cross-site-cookie constraint that forced web onto localStorage).
 */
import * as SecureStore from 'expo-secure-store';

const ACCESS_KEY = 'goserve.accessToken';
const REFRESH_KEY = 'goserve.refreshToken';

let accessToken: string | null = null;
let refreshToken: string | null = null;
let hydrated = false;

const secureOpts: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** Load tokens from the secure store into the in-memory cache. Idempotent. */
export async function hydrate(): Promise<void> {
  const [a, r] = await Promise.all([
    SecureStore.getItemAsync(ACCESS_KEY),
    SecureStore.getItemAsync(REFRESH_KEY),
  ]);
  accessToken = a;
  refreshToken = r;
  hydrated = true;
}

export function isHydrated(): boolean {
  return hydrated;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getRefreshToken(): string | null {
  return refreshToken;
}

export function hasSession(): boolean {
  return refreshToken !== null;
}

/** Persist a new token pair. Updates the in-memory cache synchronously so
 * subsequent getters are correct even before the async write resolves. */
export async function setTokens(access: string, refresh: string): Promise<void> {
  accessToken = access;
  refreshToken = refresh;
  await Promise.all([
    SecureStore.setItemAsync(ACCESS_KEY, access, secureOpts),
    SecureStore.setItemAsync(REFRESH_KEY, refresh, secureOpts),
  ]);
}

/** Wipe tokens from cache and secure store (logout / revoked session). */
export async function clearTokens(): Promise<void> {
  accessToken = null;
  refreshToken = null;
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_KEY),
    SecureStore.deleteItemAsync(REFRESH_KEY),
  ]);
}
