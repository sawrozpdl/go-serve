import * as SecureStore from 'expo-secure-store';
import {
  hydrate,
  isHydrated,
  getAccessToken,
  getRefreshToken,
  hasSession,
  setTokens,
  clearTokens,
} from '../tokenStore';

// The mock exposes a __reset helper not present on the real module.
const reset = (SecureStore as unknown as { __reset: () => void }).__reset;

beforeEach(async () => {
  reset();
  await clearTokens();
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
    // persisted to the secure store
    expect(await SecureStore.getItemAsync('goserve.refreshToken')).toBe('refresh-1');
  });

  it('persists tokens with AFTER_FIRST_UNLOCK so they survive relaunch', async () => {
    const spy = jest.spyOn(SecureStore, 'setItemAsync');
    await setTokens('access-2', 'refresh-2');
    // Both writes must carry the relaunch-safe accessibility flag.
    for (const call of spy.mock.calls) {
      expect(call[2]).toMatchObject({
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
    }
    spy.mockRestore();
  });

  it('hydrate loads persisted tokens into the cache', async () => {
    await SecureStore.setItemAsync('goserve.accessToken', 'a2');
    await SecureStore.setItemAsync('goserve.refreshToken', 'r2');
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

  it('clearTokens wipes cache and secure store', async () => {
    await setTokens('a', 'r');
    await clearTokens();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(hasSession()).toBe(false);
    expect(await SecureStore.getItemAsync('goserve.accessToken')).toBeNull();
  });
});
