import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type LocksLike, type TaskRecord } from "../src/index.js";
import { setup } from "./helpers.js";

const WAKE = "frn:wake";
const queued = (name: string): TaskRecord => ({
  v: SCHEMA_VERSION,
  id: "t1",
  name,
  input: null,
  status: "queued",
  createdAt: 1,
  updatedAt: 1,
  steps: [{ name: "a", status: "pending", attempt: 0, failures: 0 }],
});

describe("wake alarm", () => {
  it("W1 does not wake at once for a task with no definition", async () => {
    const { runner, store, alarms, clock } = setup({ watchdogMs: 30_000 });
    await store.set("frn:task:t1", queued("renamed"));
    await runner.tick();
    expect(alarms.get(WAKE)).toBe(clock.now + 30_000);
  });

  it("W2 does not wake at once for a task locked by another page", async () => {
    const held = new Set(["foxrunner:task:t1"]);
    const locks: LocksLike = { request: (name, _opts, fn) => fn(held.has(name) ? null : { name }) };
    const { runner, store, alarms, clock } = setup({ watchdogMs: 30_000, locks });
    runner.define("job", [{ name: "a", run: () => 1 }]);
    await store.set("frn:task:t1", queued("job"));
    await runner.tick();
    expect((await runner.get("t1"))?.status).toBe("queued");
    expect(alarms.get(WAKE)).toBe(clock.now + 30_000);
  });

  it("W3 does not wake at once for a schedule with no definition", async () => {
    const { runner, store, alarms, clock } = setup({ watchdogMs: 30_000 });
    await store.set("frn:schedule:old", {
      v: SCHEMA_VERSION, id: "old", task: "gone", input: null, catchUp: "once", overlap: "skip",
      every: 3_600_000, nextRunAt: clock.now - 1000, computedAt: clock.now - 3_600_000, skipped: 0,
    });
    await runner.tick();
    expect(alarms.get(WAKE)).toBe(clock.now + 30_000);
  });
});
