import { createRunner, memoryStore, type RunnerOptions } from "../src/index.js";

type Listener = (...args: never[]) => unknown;

/** A fake of the WebExtension APIs the runner uses, with a clock the test moves. */
export function setup(options: Partial<RunnerOptions> = {}) {
  const clock = { now: 1_000_000 };
  const alarms = new Map<string, number>();
  const listeners: Record<string, Listener[]> = { alarm: [], startup: [], installed: [] };
  const on = (name: string) => ({ addListener: (fn: Listener) => listeners[name]!.push(fn) });
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
