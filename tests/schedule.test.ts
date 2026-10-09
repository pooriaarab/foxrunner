import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

const T0 = 1_000_000;
const HOUR = 3_600_000;

function job(runner: ReturnType<typeof setup>["runner"], step: () => unknown = () => 1) {
  runner.define("job", [{ name: "a", run: step }]);
}

describe("schedules", () => {
  it.each([59_999, 90_000.5, 0])("Q1 rejects every = %s", async (every) => {
    const { runner } = setup();
    job(runner);
    await expect(runner.schedule("job", { every })).rejects.toThrow(RangeError);
  });

  it("runs on time and plans the next slot", async () => {
    const { runner, advance, alarms } = setup();
    job(runner);
    const s = await runner.schedule("job", { every: HOUR, input: { n: 1 } });
    expect(s.nextRunAt).toBe(T0 + HOUR);
    await runner.tick();
    expect(alarms.get("frn:wake")).toBe(T0 + HOUR);
    await advance(HOUR + 5_000);
    const tasks = await runner.list();
    expect(tasks.length).toBe(1);
    expect(tasks[0]).toMatchObject({ status: "done", input: { n: 1 }, scheduleId: "job" });
    expect((await runner.schedules())[0]?.nextRunAt).toBe(T0 + 2 * HOUR);
  });

  it("Q3 runs once for many missed slots", async () => {
    const { runner, advance } = setup();
    job(runner);
    await runner.schedule("job", { every: HOUR, catchUp: "once" });
    await advance(5 * HOUR + 10 * 60_000);
    expect((await runner.list()).length).toBe(1);
    expect((await runner.schedules())[0]?.nextRunAt).toBe(T0 + 6 * HOUR);
  });

  it("Q4 skips missed slots", async () => {
    const { runner, advance } = setup();
    job(runner);
    await runner.schedule("job", { every: HOUR, catchUp: "skip" });
    await advance(5 * HOUR + 10 * 60_000);
    expect((await runner.list()).length).toBe(0);
    expect((await runner.schedules())[0]?.nextRunAt).toBe(T0 + 6 * HOUR);
  });

  it("Q5 skips a slot while the last run is still going", async () => {
    const { runner, advance } = setup();
    runner.define("job", [{ name: "a", run: (ctx) => (ctx.reply ? 1 : ctx.waitForInput("ok?")) }]);
    await runner.schedule("job", { every: HOUR });
    await advance(HOUR);
    await advance(HOUR);
    expect((await runner.list()).length).toBe(1);
    expect((await runner.schedules())[0]?.skipped).toBe(1);
  });

  it("Q5 starts a second task with overlap allow", async () => {
    const { runner, advance } = setup();
    runner.define("job", [{ name: "a", run: (ctx) => ctx.waitForInput("ok?") }]);
    await runner.schedule("job", { every: HOUR, overlap: "allow" });
    await advance(HOUR);
    await advance(HOUR);
    expect((await runner.list()).length).toBe(2);
  });

  it("Q6 starts one task when two wakes race", async () => {
    const { runner, clock } = setup();
    job(runner);
    await runner.schedule("job", { every: HOUR });
    clock.now += HOUR;
    await Promise.all([runner.tick(), runner.tick()]);
    expect((await runner.list()).length).toBe(1);
  });

  it("Q7 plans again when the clock moves back", async () => {
    const { runner, clock } = setup();
    job(runner);
    await runner.schedule("job", { every: HOUR });
    clock.now = T0 - 24 * HOUR;
    await runner.tick();
    expect((await runner.schedules())[0]?.nextRunAt).toBe(T0 - 23 * HOUR);
  });

  it("Q9 keeps the next slot when schedule() is called again", async () => {
    const { runner, clock } = setup();
    job(runner);
    await runner.schedule("job", { every: HOUR });
    clock.now += 30 * 60_000;
    expect((await runner.schedule("job", { every: HOUR })).nextRunAt).toBe(T0 + HOUR);
    expect((await runner.schedule("job", { every: 2 * HOUR })).nextRunAt).toBe(clock.now + 2 * HOUR);
  });

  it("Q10 gives two schedules of one task their own tasks", async () => {
    const { runner, advance } = setup();
    job(runner);
    await runner.schedule("job", { every: HOUR, id: "first" });
    await runner.schedule("job", { every: HOUR, id: "second" });
    await advance(HOUR);
    const tasks = await runner.list();
    expect(tasks.map((t) => t.scheduleId).toSorted()).toEqual(["first", "second"]);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(2);
  });

  it("runs a cron schedule and can remove it", async () => {
    const { runner, clock } = setup();
    job(runner);
    const s = await runner.schedule("job", { cron: "*/5 * * * *" });
    expect(new Date(s.nextRunAt).getMinutes() % 5).toBe(0);
    expect(s.nextRunAt).toBeGreaterThan(clock.now);
    await runner.unschedule(s.id);
    expect(await runner.schedules()).toEqual([]);
  });
});
