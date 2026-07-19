/**
 * In-memory mock of expo-secure-store for Jest. The real module talks to the
 * iOS Keychain / Android Keystore, unavailable in Node.
 */
const store = new Map<string, string>();

export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = 'whenUnlockedThisDeviceOnly';
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = 'afterFirstUnlockThisDeviceOnly';

export async function getItemAsync(key: string): Promise<string | null> {
  return store.has(key) ? (store.get(key) as string) : null;
}

export async function setItemAsync(
  key: string,
  value: string,
  _opts?: { keychainAccessible?: string },
): Promise<void> {
  store.set(key, value);
}

export async function deleteItemAsync(key: string): Promise<void> {
  store.delete(key);
}

/** Test helper (not part of the real API) to reset between tests. */
export function __reset(): void {
  store.clear();
}
