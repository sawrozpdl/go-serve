/**
 * In-memory mock of react-native-mmkv (v4 / Nitro) for Jest.
 *
 * The real MMKV is a Nitro/JSI native module and can't load in the Node test
 * environment. This mock implements the subset of the v4 API the app uses,
 * backed by a plain Map, and exposes the same `createMMKV` factory. Jest picks
 * this up automatically for `react-native-mmkv` because it lives in the root
 * `__mocks__` directory adjacent to node_modules.
 */
type StoredValue = boolean | string | number | ArrayBuffer;

export interface Configuration {
  id: string;
  path?: string;
  encryptionKey?: string;
}

class MockMMKV {
  private store = new Map<string, StoredValue>();
  readonly id: string;

  constructor(config: Configuration) {
    this.id = config.id;
  }

  get length(): number {
    return this.store.size;
  }

  set(key: string, value: StoredValue): void {
    this.store.set(key, value);
  }

  getString(key: string): string | undefined {
    const v = this.store.get(key);
    return typeof v === 'string' ? v : undefined;
  }

  getNumber(key: string): number | undefined {
    const v = this.store.get(key);
    return typeof v === 'number' ? v : undefined;
  }

  getBoolean(key: string): boolean | undefined {
    const v = this.store.get(key);
    return typeof v === 'boolean' ? v : undefined;
  }

  getBuffer(key: string): ArrayBuffer | undefined {
    const v = this.store.get(key);
    return v instanceof ArrayBuffer ? v : undefined;
  }

  contains(key: string): boolean {
    return this.store.has(key);
  }

  remove(key: string): boolean {
    return this.store.delete(key);
  }

  getAllKeys(): string[] {
    return Array.from(this.store.keys());
  }

  clearAll(): void {
    this.store.clear();
  }
}

/** Matches the real `createMMKV(configuration?): MMKV` factory. */
export function createMMKV(configuration: Configuration = { id: 'mmkv.default' }): MockMMKV {
  return new MockMMKV(configuration);
}

// Re-export the type name the app imports as `type MMKV`.
export type MMKV = MockMMKV;
