import * as SecureStore from 'expo-secure-store';
import {
  hydrate,
  isHydrated,
  getAccessToken,
  getRefreshToken,
  hasSession,
  setTokens,
  clearTokens,
  setStorageErrorHandler,
} from '../tokenStore';

// The mock exposes a __reset helper not present on the real module.
const reset = (SecureStore as unknown as { __reset: () => void }).__reset;

const SESSION_KEY = 'goserve.session';
const LEGACY_ACCESS_KEY = 'goserve.accessToken';
const LEGACY_REFRESH_KEY = 'goserve.refreshToken';

beforeEach(async () => {
  reset();
  await clearTokens();
  setStorageErrorHandler(() => {});
});

describe('tokenStore', () => {
  it('starts with no session', () => {
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(hasSession()).toBe(false);
  });

  it('setTokens updates the in-memory cache synchronously and persists', async () => {
    await setTokens('access-1', 'refresh-1');
    expect(getAccessToken()).toBe('access-1');
    expect(getRefreshToken()).toBe('refresh-1');
    expect(hasSession()).toBe(true);
    const raw = await SecureStore.getItemAsync(SESSION_KEY);
    expect(JSON.parse(raw as string)).toEqual({ access: 'access-1', refresh: 'refresh-1' });
  });

  it('persists tokens with AFTER_FIRST_UNLOCK so they survive relaunch', async () => {
    const spy = jest.spyOn(SecureStore, 'setItemAsync');
    await setTokens('access-2', 'refresh-2');
    for (const call of spy.mock.calls) {
      expect(call[2]).toMatchObject({
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
    }
    spy.mockRestore();
  });

  // The pair must land in ONE write. Two writes can be interrupted between
  // them, leaving a fresh access token beside an already-rotated refresh token
  // — a combination that works until the next cold start and then can't be
  // recovered, because the server rotated the stored token away.
  it('writes the pair as a single atomic value', async () => {
    const spy = jest.spyOn(SecureStore, 'setItemAsync');
    await setTokens('a', 'r');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('hydrate loads the persisted pair into the cache', async () => {
    await setTokens('a2', 'r2');
    await hydrate();
    expect(isHydrated()).toBe(true);
    expect(getAccessToken()).toBe('a2');
    expect(getRefreshToken()).toBe('r2');
  });

  it('hydrate with nothing stored yields nulls', async () => {
    await hydrate();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
  });

  // Defensive: a stored value that is missing either half must read as absent
  // rather than as the string "undefined", which would be sent as a bearer
  // token and 401 every request.
  it('treats a half-written stored value as no session', async () => {
    await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify({}));
    await hydrate();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(hasSession()).toBe(false);
  });

  // The update that fixes the logout bug must not cause one on the way in.
  it('adopts a session written by the previous two-key layout', async () => {
    await SecureStore.setItemAsync(LEGACY_ACCESS_KEY, 'old-a');
    await SecureStore.setItemAsync(LEGACY_REFRESH_KEY, 'old-r');

    await hydrate();

    expect(hasSession()).toBe(true);
    expect(getAccessToken()).toBe('old-a');
    expect(getRefreshToken()).toBe('old-r');
    // Collapsed onto the single key, and the old keys cleaned up so the
    // migration runs exactly once.
    expect(JSON.parse((await SecureStore.getItemAsync(SESSION_KEY)) as string)).toEqual({
      access: 'old-a',
      refresh: 'old-r',
    });
    expect(await SecureStore.getItemAsync(LEGACY_ACCESS_KEY)).toBeNull();
    expect(await SecureStore.getItemAsync(LEGACY_REFRESH_KEY)).toBeNull();
  });

  // The router blocks on `hydrated`. If this throws and the flag never flips,
  // the app sits on the splash spinner forever — worse than the login screen.
  it('still finishes hydrating when the secure store read throws', async () => {
    const spy = jest.spyOn(SecureStore, 'getItemAsync').mockRejectedValue(new Error('keystore'));
    const seen: string[] = [];
    setStorageErrorHandler((op) => seen.push(op));

    await expect(hydrate()).resolves.toBeUndefined();

    expect(isHydrated()).toBe(true);
    expect(hasSession()).toBe(false);
    expect(seen).toContain('read');
    spy.mockRestore();
  });

  it('retries a failed write once before giving up', async () => {
    const spy = jest
      .spyOn(SecureStore, 'setItemAsync')
      .mockRejectedValueOnce(new Error('transient'));
    await expect(setTokens('a3', 'r3')).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  // A write that cannot be completed must be visible to the caller, not
  // swallowed — the session is live in memory but will not survive a restart.
  it('rejects when the pair cannot be stored at all', async () => {
    const spy = jest.spyOn(SecureStore, 'setItemAsync').mockRejectedValue(new Error('keystore'));
    await expect(setTokens('a4', 'r4')).rejects.toThrow('keystore');
    spy.mockRestore();
  });

  // The adopted session is what matters; failing to tidy the old keys afterwards
  // must not cost it. The new key is written first, so the next launch reads
  // that and never looks at the legacy pair again.
  it('keeps the adopted session when clearing the legacy keys fails', async () => {
    await SecureStore.setItemAsync(LEGACY_ACCESS_KEY, 'old-a');
    await SecureStore.setItemAsync(LEGACY_REFRESH_KEY, 'old-r');
    const del = jest.spyOn(SecureStore, 'deleteItemAsync').mockRejectedValue(new Error('keystore'));
    const seen: string[] = [];
    setStorageErrorHandler((op) => seen.push(op));

    await hydrate();

    expect(hasSession()).toBe(true);
    expect(getRefreshToken()).toBe('old-r');
    expect(seen).toContain('write');
    del.mockRestore();
  });

  // Without a handler wired, the failure still has to leave a trace — logcat is
  // where anyone chasing "logged out again" will be looking.
  it('warns by default when the secure store fails', async () => {
    jest.resetModules();
    jest.doMock('expo-secure-store', () => ({
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
      getItemAsync: jest.fn().mockRejectedValue(new Error('keystore')),
      setItemAsync: jest.fn(),
      deleteItemAsync: jest.fn(),
    }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // A fresh module instance is the only way to reach the default handler,
    // which every other test replaces.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fresh = require('../tokenStore') as typeof import('../tokenStore');

    await fresh.hydrate();

    expect(fresh.isHydrated()).toBe(true);
    expect(fresh.hasSession()).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    jest.dontMock('expo-secure-store');
    jest.resetModules();
  });

  it('clearTokens wipes cache and secure store, including legacy keys', async () => {
    await SecureStore.setItemAsync(LEGACY_REFRESH_KEY, 'stale');
    await setTokens('a', 'r');
    await clearTokens();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(hasSession()).toBe(false);
    expect(await SecureStore.getItemAsync(SESSION_KEY)).toBeNull();
    expect(await SecureStore.getItemAsync(LEGACY_REFRESH_KEY)).toBeNull();
  });
});
