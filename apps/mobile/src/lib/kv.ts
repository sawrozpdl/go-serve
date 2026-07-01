/**
 * Thin, typed wrapper around a single MMKV instance.
 *
 * MMKV (v4 / Nitro) is synchronous and fast — ideal for small app state (theme
 * override, device print role, TanStack Query cache blob) that must rehydrate
 * instantly on cold start. Zustand stores and the Query persister layer on top.
 *
 * Note the v4 API: instances are created via `createMMKV({ id })` (not
 * `new MMKV()`), and key removal is `.remove()` (not `.delete()`).
 */
import { createMMKV, type MMKV } from 'react-native-mmkv';

export const storage: MMKV = createMMKV({ id: 'cafe-mgmt' });

/** Namespaced keys used across the app; keep them all here to avoid clashes. */
export const KV = {
  themeOverride: 'theme.override', // 'light' | 'dark' | 'system'
} as const;

export function getString(key: string): string | undefined {
  return storage.getString(key);
}

export function setString(key: string, value: string): void {
  storage.set(key, value);
}

export function remove(key: string): void {
  storage.remove(key);
}
