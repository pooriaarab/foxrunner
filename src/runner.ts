// The runner: it saves each step's state before and after the step runs, so
// a task picks up at the last finished step after an unload, a restart or a
// throw. It never tries to keep the event page alive.

import { tryLock, type LocksLike } from "./lock.js";
import { parseTask, SCHEMA_VERSION, type StepRecord, type TaskRecord } from "./record.js";
import type { Store } from "./store.js";

export interface RetryOptions {
  /** Failures before the task fails. Default 3. */
  maxAttempts?: number;
  /** Wait before the first retry. Default 1000 ms. */
  backoffMs?: number;
  /** Each retry waits this many times longer. Default 2. */
  factor?: number;
  /** The longest wait. Default 60000 ms. */
  maxBackoffMs?: number;
}

export interface StepContext {
  taskId: string;
  input: unknown;
  /** Outputs of the finished steps, by step name. */
  results: Record<string, unknown>;
  /** 1 on the first run of this step, 2 on the second, and so on. */
  attempt: number;
  /** The same for every attempt of this step in this task. */
  idempotencyKey: string;
  /** Aborts when the user pauses or cancels the task. */
  signal: AbortSignal;
  /** The value given to `resume(id, reply)` after `waitForInput`. */
  reply: unknown;
  /** Return this to end the step and run the next one after ms. An alarm wakes the page. */
  sleep(ms: number): Sleep;
  /** Return this to park the task in `waiting` until `resume(id, reply)`. */
  waitForInput(prompt: unknown): WaitForInput;
}

export class Sleep {
  constructor(readonly ms: number) {}
}
export class WaitForInput {
  constructor(readonly prompt: unknown) {}
}

export interface StepDefinition {
  name: string;
  retry?: RetryOptions;
  run(ctx: StepContext): unknown;
}

/** The parts of the WebExtension `browser` object that the runner uses. */
export interface BrowserLike {
  alarms: {
    create(name: string, info: { when: number }): void;
    clear(name: string): Promise<unknown>;
    onAlarm: { addListener(fn: (alarm: { name: string }) => void): void };
  };
  runtime: {
    onStartup: { addListener(fn: () => void): void };
    onInstalled: { addListener(fn: () => void): void };
  };
}

export interface RunnerOptions {
  store: Store;
  /** `browser`, so alarms and startup wake the runner. Leave it out in Node. */
  browser?: BrowserLike;
  /** Default: `navigator.locks` when it exists. */
  locks?: LocksLike;
  now?: () => number;
  /** Retry options for steps that set none. */
  retry?: RetryOptions;
  /** Largest step output, as JSON characters. Default 1000000. */
  maxOutputBytes?: number;
  /** While a step runs, keep a wake alarm this far ahead, so an unload mid-step gets a wake. Default 30000. */
  watchdogMs?: number;
  /** Check stored tasks once, right after createRunner. Default true. */
  autoTick?: boolean;
}

export interface RunnerEvents {
  change: TaskRecord;
  step: { task: TaskRecord; step: StepRecord };
  error: { id?: string; message: string };
}

export const TASK_PREFIX = "frn:task:";
export const CONTROL_PREFIX = "frn:ctl:";
export const WAKE_ALARM = "frn:wake";
const TERMINAL = new Set(["done", "failed", "cancelled"]);
const INTERRUPTED = "interrupted: the page unloaded or the browser stopped during this step";

class PermanentError extends Error {}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createRunner(options: RunnerOptions) {
  const { store } = options;
  const now = options.now ?? Date.now;
  const lock = tryLock(options.locks ?? (globalThis.navigator as { locks?: LocksLike } | undefined)?.locks);
  const maxOutput = options.maxOutputBytes ?? 1_000_000;
  const definitions = new Map<string, StepDefinition[]>();
  const listeners = new Map<keyof RunnerEvents, Set<(event: never) => void>>();
  const active = new Map<string, Promise<void>>();
  const controllers = new Map<string, AbortController>();
  const watchdogMs = options.watchdogMs ?? 30_000;
  let arming = Promise.resolve();

  function emit<K extends keyof RunnerEvents>(name: K, event: RunnerEvents[K]) {
    for (const fn of listeners.get(name) ?? []) (fn as (e: RunnerEvents[K]) => void)(event);
  }

  async function load(id: string): Promise<TaskRecord | undefined> {
    const raw = await store.get(TASK_PREFIX + id);
    if (raw === undefined) return undefined;
    const parsed = parseTask(raw);
    if (parsed.ok) return parsed.task;
    emit("error", { id, message: `task ${id} skipped: ${parsed.message}` });
    return undefined;
  }

  async function save(task: TaskRecord) {
    task.updatedAt = now();
    await store.set(TASK_PREFIX + task.id, task);
    emit("change", structuredClone(task));
  }

  function retryOf(stepName: string, def: StepDefinition[] | undefined): Required<RetryOptions> {
    const own = def?.find((s) => s.name === stepName)?.retry;
    return { maxAttempts: 3, backoffMs: 1000, factor: 2, maxBackoffMs: 60_000, ...options.retry, ...own };
  }

  /** Record a failed attempt: plan a retry, or fail the task. */
  function fail(task: TaskRecord, step: StepRecord, error: string, permanent: boolean, def?: StepDefinition[]) {
    const retry = retryOf(step.name, def);
    step.failures += 1;
    step.error = error;
    step.endedAt = now();
    if (permanent || step.failures >= retry.maxAttempts) {
      step.status = "failed";
      task.status = "failed";
      task.error = error;
      delete task.runAt;
      return;
    }
    step.status = "pending";
    task.status = "queued";
    task.scheduledAt = now();
    task.runAt = now() + Math.min(retry.backoffMs * retry.factor ** (step.failures - 1), retry.maxBackoffMs);
  }

  function checkOutput(value: unknown) {
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch (error) {
      throw new PermanentError(`the step output is not JSON: ${message(error)}`);
    }
    if (value !== undefined && (json === undefined || typeof value === "function")) throw new PermanentError("the step output is not JSON");
    if (json && json.length > maxOutput) throw new PermanentError(`the step output has ${json.length} characters; the limit is ${maxOutput}`);
  }

  /** Run one step of a task we hold the lock for. Returns false when there is nothing more to do now. */
  async function advance(id: string): Promise<boolean> {
    const task = await load(id);
    if (!task) return false;
    const def = definitions.get(task.name);
    const control = await store.get(CONTROL_PREFIX + id);
    if (control === "pause" || control === "cancel") {
      if (!TERMINAL.has(task.status)) {
        for (const s of task.steps) if (s.status === "running") s.status = "pending";
        task.status = control === "pause" ? "paused" : "cancelled";
        if (control === "cancel") delete task.runAt;
        await save(task);
      }
      await store.remove(CONTROL_PREFIX + id);
      return false;
    }
    if (task.status === "running") {
      const cut = task.steps.find((s) => s.status === "running");
      if (!cut) throw new Error(`task ${id} is running but has no running step`);
      fail(task, cut, INTERRUPTED, false, def);
      await save(task);
      emit("step", { task: structuredClone(task), step: structuredClone(cut) });
      return true;
    }
    if (task.status !== "queued") return false;
    if (task.runAt !== undefined && task.scheduledAt !== undefined && now() < task.scheduledAt) {
      // The clock moved back. Keep the time that was left.
      task.runAt = now() + (task.runAt - task.scheduledAt);
      task.scheduledAt = now();
      await save(task);
    }
    if ((task.runAt ?? 0) > now()) return false;
    const step = task.steps.find((s) => s.status !== "done");
    if (!step) {
      task.status = "done";
      delete task.runAt;
      await save(task);
      return false;
    }
    if (!def) {
      emit("error", { id, message: `task ${id} waits: no definition for task name ${task.name}` });
      return false;
    }
    if (step.status === "sleeping") {
      step.status = "done";
      step.endedAt = now();
      delete task.runAt;
      await save(task);
      return true;
    }
    const stepDef = def.find((s) => s.name === step.name);
    if (!stepDef) {
      fail(task, step, `the definition of ${task.name} has no step ${step.name}`, true);
      await save(task);
      return false;
    }
    step.status = "running";
    step.attempt += 1;
    step.startedAt = now();
    delete step.error;
    task.status = "running";
    delete task.runAt;
    try {
      await save(task);
    } catch (error) {
      emit("error", { id, message: `task ${id} not started: ${message(error)}` });
      return false;
    }
    void arm();
    const results = Object.fromEntries(task.steps.filter((s) => s.status === "done").map((s) => [s.name, s.output]));
    const controller = new AbortController();
    controllers.set(id, controller);
    // pause() writes the signal, then looks for the controller. Here the order
    // is the other way, so one of the two always sees the other.
    if (await store.get(CONTROL_PREFIX + id)) controller.abort("control");
    const ctx: StepContext = {
      taskId: id,
      input: task.input,
      results,
      attempt: step.attempt,
      idempotencyKey: `${id}:${step.name}`,
      signal: controller.signal,
      reply: step.reply,
      sleep: (ms) => new Sleep(ms),
      waitForInput: (prompt) => new WaitForInput(prompt),
    };
    try {
      const output = await stepDef.run(ctx);
      task.status = "queued";
      if (output instanceof Sleep) {
        step.status = "sleeping";
        step.wakeAt = now() + output.ms;
        task.runAt = step.wakeAt;
        task.scheduledAt = now();
      } else if (output instanceof WaitForInput) {
        step.status = "waiting";
        task.status = "waiting";
        task.prompt = output.prompt;
      } else {
        checkOutput(output);
        step.status = "done";
        step.output = output;
        step.endedAt = now();
      }
    } catch (error) {
      if (await store.get(CONTROL_PREFIX + id)) {
        // The user paused or cancelled; the abort is not the step's fault.
        step.status = "pending";
        task.status = "queued";
      } else {
        fail(task, step, message(error), error instanceof PermanentError, def);
      }
    } finally {
      controllers.delete(id);
    }
    try {
      await save(task);
    } catch (error) {
      // Keep the step "running" in storage; the next wake treats it as cut short.
      emit("error", { id, message: `task ${id} step ${step.name} result not saved: ${message(error)}` });
      return false;
    }
    emit("step", { task: structuredClone(task), step: structuredClone(step) });
    return true;
  }

  function drive(id: string): Promise<void> {
    const running = active.get(id);
    if (running) return running;
    const work = lock(`foxrunner:task:${id}`, async () => {
      while (await advance(id));
    })
      .then(() => undefined)
      .catch((error) => emit("error", { id, message: message(error) }))
      .finally(() => {
        active.delete(id);
        void arm();
      });
    active.set(id, work);
    return work;
  }

  async function list(): Promise<TaskRecord[]> {
    const tasks: TaskRecord[] = [];
    for (const [key, raw] of await store.entries(TASK_PREFIX)) {
      const parsed = parseTask(raw);
      if (parsed.ok) tasks.push(parsed.task);
      else emit("error", { id: key.slice(TASK_PREFIX.length), message: `task ${key.slice(TASK_PREFIX.length)} skipped: ${parsed.message}` });
    }
    return tasks.toSorted((a, b) => b.createdAt - a.createdAt);
  }

  /** Set one wake alarm for the earliest moment a stored task needs the page. */
  function arm(): Promise<void> {
    arming = arming.then(async () => {
      if (!options.browser) return;
      let when = Infinity;
      for (const t of await list()) {
        if (t.status === "running") when = Math.min(when, now() + watchdogMs);
        if (t.status === "queued") when = Math.min(when, t.runAt ?? now());
      }
      if (when === Infinity) await options.browser.alarms.clear(WAKE_ALARM);
      else options.browser.alarms.create(WAKE_ALARM, { when });
    }).catch((error) => emit("error", { message: `wake alarm not set: ${message(error)}` }));
    return arming;
  }

  async function sendControl(id: string, signal: "pause" | "cancel") {
    const task = await load(id);
    if (!task) throw new Error(`no task with id ${id}`);
    if (TERMINAL.has(task.status)) return;
    await store.set(CONTROL_PREFIX + id, signal);
    controllers.get(id)?.abort(signal);
    void drive(id);
  }

  async function tick() {
    const tasks = await list();
    await Promise.all(tasks.filter((t) => t.status === "running" || t.status === "queued").map((t) => drive(t.id)));
    await Promise.all(active.values());
    await arm();
  }

  const runner = {
    /** Define a task: a name and its steps, in order. Call it before the first await in the event page. */
    define(name: string, steps: StepDefinition[]) {
      if (steps.length === 0) throw new Error(`task ${name} needs at least one step`);
      const names = new Set(steps.map((s) => s.name));
      if (names.size !== steps.length) throw new Error(`task ${name} has two steps with the same name`);
      definitions.set(name, steps);
    },
    /** Save a new task and start it. With the same `id`, a second call returns the first task. */
    async start(name: string, input: unknown = null, opts: { id?: string } = {}): Promise<TaskRecord> {
      const def = definitions.get(name);
      if (!def) throw new Error(`no task named ${name}; call define() first`);
      const id = opts.id ?? crypto.randomUUID();
      const made = await lock(`foxrunner:task:${id}`, async () => {
        const existing = await load(id);
        if (existing) return existing;
        const t = now();
        const task: TaskRecord = {
          v: SCHEMA_VERSION,
          id,
          name,
          input,
          status: "queued",
          createdAt: t,
          updatedAt: t,
          steps: def.map((s) => ({ name: s.name, status: "pending", attempt: 0, failures: 0 })),
        };
        await save(task);
        return task;
      });
      const task = made.ran ? made.value : await load(id);
      if (!task) throw new Error(`task ${id} could not be read back`);
      void drive(id);
      return task;
    },
    get: load,
    /** Stop the task after the current step. `ctx.signal` aborts. */
    pause: (id: string) => sendControl(id, "pause"),
    /** Stop the task for good. */
    cancel: (id: string) => sendControl(id, "cancel"),
    /** Go on with a paused task, or answer a waiting one. */
    async resume(id: string, reply?: unknown) {
      const done = await lock(`foxrunner:task:${id}`, async () => {
        const task = await load(id);
        if (!task) throw new Error(`no task with id ${id}`);
        if (task.status === "paused") task.status = "queued";
        else if (task.status === "waiting") {
          const step = task.steps.find((s) => s.status === "waiting");
          if (step) {
            step.status = "pending";
            step.reply = reply;
          }
          delete task.prompt;
          task.status = "queued";
        } else return;
        await store.remove(CONTROL_PREFIX + id);
        await save(task);
      });
      if (done.ran) void drive(id);
    },
    list,
    /** Run every due task and wait for the work in this page to finish. */
    tick,
    on<K extends keyof RunnerEvents>(name: K, fn: (event: RunnerEvents[K]) => void): () => void {
      const set = listeners.get(name) ?? new Set();
      set.add(fn as (event: never) => void);
      listeners.set(name, set);
      return () => set.delete(fn as (event: never) => void);
    },
  };

  // Listeners must be added in the first turn of the event page, so Firefox
  // starts the page for these events.
  options.browser?.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WAKE_ALARM) void tick();
  });
  options.browser?.runtime.onStartup.addListener(() => void tick());
  options.browser?.runtime.onInstalled.addListener(() => void tick());
  if (options.autoTick ?? true) setTimeout(() => void tick(), 0);
  return runner;
}

export type Runner = ReturnType<typeof createRunner>;
