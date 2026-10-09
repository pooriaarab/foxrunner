// A small key-value store. foxrunner keeps every task, schedule and control
// signal in one, so a task survives an event page unload or a browser restart.

/** Where foxrunner keeps its records. Every method is async. */
export interface Store {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  /** All entries whose key starts with prefix. */
  entries(prefix: string): Promise<[string, unknown][]>;
}

/** A store in memory. It loses everything when the page unloads. Use it for tests. */
export function memoryStore(): Store {
  const data = new Map<string, unknown>();
  return {
    async get(key) {
      return data.has(key) ? structuredClone(data.get(key)) : undefined;
    },
    async set(key, value) {
      data.set(key, structuredClone(value));
    },
    async remove(key) {
      data.delete(key);
    },
    async entries(prefix) {
      return [...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)]);
    },
  };
}

/** The part of `browser.storage.local` that the store uses. */
export interface StorageAreaLike {
  get(keys: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

/** A store on a WebExtension storage area, usually `browser.storage.local`. */
export function storageAreaStore(area: StorageAreaLike): Store {
  return {
    async get(key) {
      return (await area.get(key))[key];
    },
    async set(key, value) {
      await area.set({ [key]: value });
    },
    async remove(key) {
      await area.remove(key);
    },
    async entries(prefix) {
      return Object.entries(await area.get(null)).filter(([key]) => key.startsWith(prefix));
    },
  };
}
