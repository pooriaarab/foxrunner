// The demo's event page. It defines one demo task and answers the popup.
// Firefox unloads this page when it is idle; foxrunner saves every step, so
// the task goes on when an alarm or a message loads the page again.
import { createRunner, storageAreaStore } from "../src/index.ts";

const store = storageAreaStore(browser.storage.local);
// A short watchdog, so a step cut short by an unload runs again within 5 s.
const runner = createRunner({ store, browser, watchdogMs: 5000 });

// Count page loads, so you (and the E2E test) can see each unload and wake.
browser.storage.local.get("demo:boots").then(({ "demo:boots": boots = [] }) =>
  browser.storage.local.set({ "demo:boots": [...boots, Date.now()].slice(-50) }),
);

runner.define("demo", [
  { name: "prepare", run: (ctx) => ({ input: ctx.input }) },
  {
    // The side effect runs once per idempotency key. Each attempt also notes
    // that it saw the key, so you can see a rerun reuse it. Then the first
    // attempt works for input.slowMs, long enough to be cut short.
    name: "slow",
    run: async (ctx) => {
      const { "demo:ledger": ledger = {} } = await browser.storage.local.get("demo:ledger");
      const entry = ledger[ctx.idempotencyKey] ?? { sideEffects: 0, seenBy: [] };
      if (entry.sideEffects === 0) entry.sideEffects = 1;
      entry.seenBy.push(ctx.attempt);
      ledger[ctx.idempotencyKey] = entry;
      await browser.storage.local.set({ "demo:ledger": ledger });
      if (ctx.attempt === 1) await new Promise((r) => setTimeout(r, ctx.input?.slowMs ?? 0));
      return entry;
    },
  },
  // Waits 2 minutes by default. An alarm wakes the page; no timer is held.
  { name: "wait", run: (ctx) => ctx.sleep(ctx.input?.waitMs ?? 120_000) },
  {
    name: "flaky",
    retry: { maxAttempts: 4, backoffMs: 1000 },
    run: (ctx) => {
      if (ctx.attempt < 3) throw new Error(`planned failure ${ctx.attempt} of 2`);
      return { attempts: ctx.attempt };
    },
  },
  { name: "finish", run: (ctx) => ({ steps: Object.keys(ctx.results) }) },
]);

browser.runtime.onMessage.addListener((msg) => {
  switch (msg?.type) {
    case "start":
      return runner.start("demo", msg.input ?? {});
    case "list":
      return runner.list();
    case "pause":
      return runner.pause(msg.id).then(() => true);
    case "resume":
      return runner.resume(msg.id).then(() => true);
    case "cancel":
      return runner.cancel(msg.id).then(() => true);
    case "reload":
      setTimeout(() => browser.runtime.reload(), 50);
      return Promise.resolve(true);
    default:
      return undefined;
  }
});
