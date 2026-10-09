import { createRunner, memoryStore, type RunnerOptions, type Store } from "../src/index.js";

type Listener = (...args: never[]) => unknown;

/** A fake of the WebExtension APIs the runner uses, with a clock the test moves. */
export function setup(options: Partial<RunnerOptions> = {}) {
  const clock = { now: 1_000_000 };
  const alarms = new Map<string, number>();
  const listeners = { alarm: [] as Listener[], startup: [] as Listener[], installed: [] as Listener[] };
  const on = (name: keyof typeof listeners) => ({ addListener: (fn: Listener) => listeners[name].push(fn) });
  const browser = {
    alarms: {
      create: (name: string, info: { when: number }) => void alarms.set(name, info.when),
      clear: async (name: string) => alarms.delete(name),
      onAlarm: on("alarm"),
    },
    runtime: { onStartup: on("startup"), onInstalled: on("installed") },
  };
  const store = options.store ?? memoryStore();
  const errors: string[] = [];
  const runner = createRunner({ store, browser, now: () => clock.now, autoTick: false, ...options });
  runner.on("error", (event) => errors.push(event.message));
  const advance = async (ms: number) => {
    clock.now += ms;
    await runner.tick();
  };
  return { runner, store, clock, alarms, listeners, errors, advance };
}

/** A store whose next write fails once. */
export function flakyStore(): Store & { failNext: (match: (key: string, value: unknown) => boolean) => void } {
  const inner = memoryStore();
  let match: ((key: string, value: unknown) => boolean) | undefined;
  return {
    ...inner,
    async set(key, value) {
      if (match?.(key, value)) {
        match = undefined;
        throw new Error("QuotaExceededError: the store is full");
      }
      await inner.set(key, value);
    },
    failNext: (fn) => void (match = fn),
  };
}
