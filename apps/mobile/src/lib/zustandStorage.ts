/**
 * A zustand `persist` StateStorage backed by our MMKV instance. Synchronous
 * under the hood; zustand's persist API is promise-shaped so we wrap.
 */
import type { StateStorage } from 'zustand/middleware';
import { storage } from './kv';

export const mmkvStorage: StateStorage = {
  getItem: (name) => storage.getString(name) ?? null,
  setItem: (name, value) => {
    storage.set(name, value);
  },
  removeItem: (name) => {
    storage.remove(name);
  },
};
