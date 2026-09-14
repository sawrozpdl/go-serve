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
 *
 * The pair is stored as ONE value under ONE key. It used to be two independent
 * writes issued together, which meant a process death between them left the new
 * access token on disk beside the PREVIOUS refresh token. That combination
 * looks healthy — the app starts, the access token works for its 15 minutes —
 * and then the stale refresh token is presented to the server, which rotated it
 * away long ago, and the session is rejected. Refresh-token rotation makes a
 * half-written pair unrecoverable, so the pair must be written atomically.
 */
import * as SecureStore from 'expo-secure-store';

const SESSION_KEY = 'goserve.session';
// The pre-atomic layout. Still read once, on the first launch after upgrading,
// so an existing install carries its session across instead of being bounced to
// the login screen by the very update meant to stop that happening.
const LEGACY_ACCESS_KEY = 'goserve.accessToken';
const LEGACY_REFRESH_KEY = 'goserve.refreshToken';

type StoredPair = { access: string | null; refresh: string | null };

let accessToken: string | null = null;
let refreshToken: string | null = null;
let hydrated = false;

// AFTER_FIRST_UNLOCK (not WHEN_UNLOCKED): the tokens must be readable at cold
// start / relaunch even if the read races the device-unlock state. WHEN_UNLOCKED
// returned null on relaunch (and Android Keystore could invalidate it), which
// dropped `hasSession` to false and logged the user out on every launch. Still
// THIS_DEVICE_ONLY so the secret never leaves the device or syncs to a backup.
const secureOpts: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/**
 * Called when the secure store itself fails. Worth surfacing on its own:
 * a failed write is not a failed request, and the cost lands later — the
 * session keeps working from memory for the rest of the run and only dies at
 * the next cold start, by which time the cause is invisible.
 */
let onStorageError: (op: 'read' | 'write', err: unknown) => void = (op, err) => {
  console.warn(`[tokenStore] secure store ${op} failed`, err);
};

export function setStorageErrorHandler(fn: (op: 'read' | 'write', err: unknown) => void): void {
  onStorageError = fn;
}

/** Write the current pair as a single atomic value, with one retry. */
async function persist(): Promise<void> {
  const blob = JSON.stringify({ access: accessToken, refresh: refreshToken } satisfies StoredPair);
  try {
    await SecureStore.setItemAsync(SESSION_KEY, blob, secureOpts);
  } catch {
    // Retry once before giving up. By the time we get here the server has
    // already rotated the old token, so losing this write costs the session at
    // the next launch — it is worth a second attempt.
    await SecureStore.setItemAsync(SESSION_KEY, blob, secureOpts);
  }
}

/** Load tokens from the secure store into the in-memory cache. Idempotent. */
export async function hydrate(): Promise<void> {
  try {
    const raw = await SecureStore.getItemAsync(SESSION_KEY, secureOpts);
    if (raw) {
      const pair = JSON.parse(raw) as StoredPair;
      accessToken = pair.access ?? null;
      refreshToken = pair.refresh ?? null;
    } else {
      const [a, r] = await Promise.all([
        SecureStore.getItemAsync(LEGACY_ACCESS_KEY),
        SecureStore.getItemAsync(LEGACY_REFRESH_KEY),
      ]);
      accessToken = a;
      refreshToken = r;
      if (r !== null) await migrateLegacy();
    }
  } catch (err) {
    // `hydrated` must be set no matter what. The router blocks on it, so a
    // throw here left the app on the splash spinner forever with no way out —
    // a worse failure than the login screen this whole file exists to avoid.
    // Nothing is deleted: a transient read fault should not cost the session,
    // and the next launch reads the same bytes again.
    accessToken = null;
    refreshToken = null;
    onStorageError('read', err);
  }
  hydrated = true;
}

/** Collapse a pre-atomic install onto the single key. Best-effort. */
async function migrateLegacy(): Promise<void> {
  try {
    await persist();
    // Only after the new key is safely written — if this half fails, the next
    // launch reads the new key and never looks at the legacy ones again.
    await Promise.all([
      SecureStore.deleteItemAsync(LEGACY_ACCESS_KEY),
      SecureStore.deleteItemAsync(LEGACY_REFRESH_KEY),
    ]);
  } catch (err) {
    onStorageError('write', err);
  }
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
 * subsequent getters are correct even before the async write resolves.
 * Rejects if the pair could not be written — callers must not treat that as a
 * network failure (see createRefresher). */
export async function setTokens(access: string, refresh: string): Promise<void> {
  accessToken = access;
  refreshToken = refresh;
  await persist();
}

/** Wipe tokens from cache and secure store (logout / revoked session). */
export async function clearTokens(): Promise<void> {
  accessToken = null;
  refreshToken = null;
  await Promise.all([
    SecureStore.deleteItemAsync(SESSION_KEY),
    SecureStore.deleteItemAsync(LEGACY_ACCESS_KEY),
    SecureStore.deleteItemAsync(LEGACY_REFRESH_KEY),
  ]);
}
