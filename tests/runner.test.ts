import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, type TaskRecord } from "../src/index.js";
import { setup } from "./helpers.js";

const stored = (over: Partial<TaskRecord> = {}): TaskRecord => ({
  v: SCHEMA_VERSION,
  id: "t1",
  name: "job",
  input: {},
  status: "running",
  createdAt: 1,
  updatedAt: 1,
  steps: [
    { name: "a", status: "running", attempt: 1, failures: 0, startedAt: 1 },
    { name: "b", status: "pending", attempt: 0, failures: 0 },
  ],
  ...over,
});

describe("runner core", () => {
  it("runs steps in order and passes earlier outputs on", async () => {
    const { runner } = setup();
    runner.define("job", [
      { name: "a", run: (ctx) => ({ got: ctx.input }) },
      { name: "b", run: (ctx) => ({ fromA: ctx.results.a }) },
    ]);
    const task = await runner.start("job", { n: 1 });
    await runner.tick();
    const done = await runner.get(task.id);
    expect(done?.status).toBe("done");
    expect(done?.steps.map((s) => s.status)).toEqual(["done", "done"]);
    expect(done?.steps[1]?.output).toEqual({ fromA: { got: { n: 1 } } });
  });

  it("T3 T4 retries with backoff and keeps one idempotency key", async () => {
    const { runner, advance } = setup();
    const keys: string[] = [];
    runner.define("job", [
      {
        name: "a",
        retry: { maxAttempts: 3, backoffMs: 1000, factor: 2 },
        run: (ctx) => {
          keys.push(`${ctx.idempotencyKey}#${ctx.attempt}`);
          if (ctx.attempt < 3) throw new Error(`boom ${ctx.attempt}`);
          return "ok";
        },
      },
    ]);
    const task = await runner.start("job", {}, { id: "t9" });
    await runner.tick();
    let rec = await runner.get(task.id);
    expect(rec?.status).toBe("queued");
    expect(rec?.runAt).toBe(1_000_000 + 1000);
    expect(rec?.steps[0]?.error).toBe("boom 1");
    await advance(999);
    expect((await runner.get(task.id))?.steps[0]?.attempt).toBe(1);
    await advance(1);
    rec = await runner.get(task.id);
    expect(rec?.runAt).toBe(1_000_000 + 1000 + 2000);
    await advance(2000);
    rec = await runner.get(task.id);
    expect(rec?.status).toBe("done");
    expect(rec?.steps[0]).toMatchObject({ attempt: 3, failures: 2, output: "ok" });
    expect(keys).toEqual(["t9:a#1", "t9:a#2", "t9:a#3"]);
  });

  it("T4 fails the task after maxAttempts", async () => {
    const { runner, advance } = setup();
    runner.define("job", [{ name: "a", retry: { maxAttempts: 2, backoffMs: 10 }, run: () => Promise.reject(new Error("always")) }]);
    const task = await runner.start("job", {});
    await runner.tick();
    await advance(10);
    const rec = await runner.get(task.id);
    expect(rec?.status).toBe("failed");
    expect(rec?.error).toBe("always");
    expect(rec?.steps[0]).toMatchObject({ status: "failed", failures: 2 });
  });

  it("T6 starts one task for one id", async () => {
    const { runner } = setup();
    let runs = 0;
    runner.define("job", [{ name: "a", run: () => void runs++ }]);
    const [one, two] = await Promise.all([runner.start("job", {}, { id: "same" }), runner.start("job", {}, { id: "same" })]);
    await runner.tick();
    expect(one.id).toBe(two.id);
    expect(runs).toBe(1);
    expect((await runner.list()).length).toBe(1);
  });

  it("T7 rejects an unknown task name and keeps a stored one queued", async () => {
    const { runner, store, errors } = setup();
    await expect(runner.start("nope", {})).rejects.toThrow(/nope/);
    await store.set("frn:task:t1", stored({ name: "later", status: "queued", steps: [{ name: "a", status: "pending", attempt: 0, failures: 0 }] }));
    await runner.tick();
    expect((await runner.get("t1"))?.status).toBe("queued");
    expect(errors.some((e) => e.includes("later"))).toBe(true);
  });

  it.each([
    ["a function", () => () => 1],
    ["too large", () => "x".repeat(100)],
  ])("T9 fails with no retry when the output is %s", async (_label, make) => {
    const { runner } = setup({ maxOutputBytes: 50 });
    let runs = 0;
    runner.define("job", [{ name: "a", retry: { maxAttempts: 5 }, run: () => (runs++, make()) }]);
    const task = await runner.start("job", {});
    await runner.tick();
    const rec = await runner.get(task.id);
    expect(rec?.status).toBe("failed");
    expect(runs).toBe(1);
  });

  it("emits change and step events", async () => {
    const { runner } = setup();
    const seen: string[] = [];
    runner.on("change", (t) => seen.push(`change:${t.status}`));
    runner.on("step", ({ step }) => seen.push(`step:${step.name}:${step.status}`));
    runner.define("job", [{ name: "a", run: () => 1 }]);
    await runner.start("job", {});
    await runner.tick();
    expect(seen).toContain("step:a:done");
    expect(seen.at(-1)).toBe("change:done");
  });
});
