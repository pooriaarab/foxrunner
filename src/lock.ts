// One owner per task. In a browser, Web Locks also keep two extension pages
// from running the same task. Elsewhere, a lock in memory does the same
// inside one page.

/** The part of `navigator.locks` that foxrunner uses. */
export interface LocksLike {
  request<T>(name: string, options: { ifAvailable: true }, fn: (lock: unknown) => Promise<T>): Promise<T>;
}

export type TryLock = <T>(name: string, fn: () => Promise<T>) => Promise<{ ran: true; value: T } | { ran: false }>;

export function tryLock(locks?: LocksLike): TryLock {
  if (locks) {
    return (name, fn) =>
      locks.request(name, { ifAvailable: true }, async (lock) => (lock ? { ran: true as const, value: await fn() } : { ran: false as const }));
  }
  const held = new Set<string>();
  return async (name, fn) => {
    if (held.has(name)) return { ran: false };
    held.add(name);
    try {
      return { ran: true, value: await fn() };
    } finally {
      held.delete(name);
    }
  };
}
