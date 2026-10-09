import { describe, expect, it } from "vitest";
import { setup } from "./helpers.js";

const WAKE = "frn:wake";
const T0 = 1_000_000;

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

describe("control", () => {
  it("C1 C3 pauses after the current step and resumes from the next", async () => {
    const { runner } = setup();
    const g = gate();
    const ran: string[] = [];
    runner.define("job", [
      { name: "a", run: async () => (await g.promise, ran.push("a"), "A") },
      { name: "b", run: () => void ran.push("b") },
    ]);
    const task = await runner.start("job");
    await runner.pause(task.id);
    g.open();
    await runner.tick();
    let rec = await runner.get(task.id);
    expect(rec?.status).toBe("paused");
    expect(ran).toEqual(["a"]);
    await runner.resume(task.id);
    await runner.tick();
    rec = await runner.get(task.id);
    expect(rec?.status).toBe("done");
    expect(ran).toEqual(["a", "b"]);
  });

  it("C1 does not count an abort caused by pause as a failure", async () => {
    const { runner } = setup();
    runner.define("job", [
      {
        name: "a",
        run: (ctx) =>
          new Promise((resolve, reject) => {
            if (ctx.attempt > 1) return resolve("second");
            if (ctx.signal.aborted) return reject(new Error("aborted"));
            ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
    ]);
    const task = await runner.start("job");
    await runner.pause(task.id);
    await runner.tick();
    let rec = await runner.get(task.id);
    expect(rec?.status).toBe("paused");
    expect(rec?.steps[0]).toMatchObject({ status: "pending", failures: 0 });
    await runner.resume(task.id);
    await runner.tick();
    rec = await runner.get(task.id);
    expect(rec?.status).toBe("done");
    expect(rec?.steps[0]?.output).toBe("second");
  });

  it("C2 C6 cancels a sleeping task and keeps it cancelled", async () => {
    const { runner, advance } = setup();
    let ranB = false;
    runner.define("job", [
      { name: "wait", run: (ctx) => ctx.sleep(120_000) },
      { name: "b", run: () => void (ranB = true) },
    ]);
    const task = await runner.start("job");
    await runner.tick();
    expect((await runner.get(task.id))?.steps[0]).toMatchObject({ status: "sleeping", wakeAt: T0 + 120_000 });
    await runner.cancel(task.id);
    await advance(200_000);
    expect((await runner.get(task.id))?.status).toBe("cancelled");
    expect(ranB).toBe(false);
  });

  it("C4 parks a task in waiting and runs the step again with the reply", async () => {
    const { runner } = setup();
    runner.define("job", [{ name: "ask", run: (ctx) => (ctx.reply === undefined ? ctx.waitForInput({ question: "Send?" }) : { answer: ctx.reply }) }]);
    const task = await runner.start("job");
    await runner.tick();
    let rec = await runner.get(task.id);
    expect(rec?.status).toBe("waiting");
    expect(rec?.prompt).toEqual({ question: "Send?" });
    await runner.resume(task.id, "yes");
    await runner.tick();
    rec = await runner.get(task.id);
    expect(rec?.status).toBe("done");
    expect(rec?.steps[0]?.output).toEqual({ answer: "yes" });
  });

  it("V1 keeps the reply when a paused waiting task is resumed", async () => {
    const { runner } = setup();
    runner.define("job", [{ name: "ask", run: (ctx) => (ctx.reply === undefined ? ctx.waitForInput("code?") : { code: ctx.reply }) }]);
    const task = await runner.start("job");
    await runner.tick();
    await runner.pause(task.id);
    await runner.tick();
    expect((await runner.get(task.id))?.status).toBe("paused");
    await runner.resume(task.id, "4242");
    await runner.tick();
    const rec = await runner.get(task.id);
    expect(rec?.status).toBe("done");
    expect(rec?.steps[0]?.output).toEqual({ code: "4242" });
  });

  it("C5 leaves a finished task alone and rejects an unknown id", async () => {
    const { runner } = setup();
    runner.define("job", [{ name: "a", run: () => 1 }]);
    const task = await runner.start("job");
    await runner.tick();
    await runner.pause(task.id);
    await runner.cancel(task.id);
    await runner.tick();
    expect((await runner.get(task.id))?.status).toBe("done");
    await expect(runner.pause("nope")).rejects.toThrow(/nope/);
    await expect(runner.resume("nope")).rejects.toThrow(/nope/);
  });

  it("C6 C7 C8 sleeps on an alarm, ignores an early fire and runs on a late one", async () => {
    const { runner, alarms, clock, listeners, advance } = setup();
    let runs = 0;
    runner.define("job", [
      { name: "wait", run: (ctx) => (runs++, ctx.sleep(120_000)) },
      { name: "b", run: () => "b" },
    ]);
    const task = await runner.start("job");
    await runner.tick();
    expect(alarms.get(WAKE)).toBe(T0 + 120_000);
    clock.now = T0 + 119_000;
    for (const fn of listeners.alarm) (fn as (a: { name: string }) => void)({ name: WAKE });
    await runner.tick();
    expect((await runner.get(task.id))?.steps[0]?.status).toBe("sleeping");
    expect(alarms.get(WAKE)).toBe(T0 + 120_000);
    await advance(600_000);
    const rec = await runner.get(task.id);
    expect(rec?.status).toBe("done");
    expect(runs).toBe(1);
    expect(alarms.has(WAKE)).toBe(false);
  });

  it("C9 keeps the time left when the clock moves back", async () => {
    const { runner, clock } = setup();
    runner.define("job", [{ name: "wait", run: (ctx) => ctx.sleep(60_000) }, { name: "b", run: () => 1 }]);
    const task = await runner.start("job");
    await runner.tick();
    clock.now = T0 - 3_600_000;
    await runner.tick();
    expect((await runner.get(task.id))?.runAt).toBe(T0 - 3_600_000 + 60_000);
  });

  it("C10 sets the alarm again after alarms are lost", async () => {
    const { runner, alarms, store } = setup();
    runner.define("job", [{ name: "wait", run: (ctx) => ctx.sleep(60_000) }, { name: "b", run: () => 1 }]);
    await runner.start("job");
    await runner.tick();
    alarms.clear();
    const second = setup({ store });
    second.runner.define("job", [{ name: "wait", run: (ctx) => ctx.sleep(60_000) }, { name: "b", run: () => 1 }]);
    await second.runner.tick();
    expect(second.alarms.get(WAKE)).toBe(T0 + 60_000);
  });

  it("C11 keeps a watchdog alarm while a step runs", async () => {
    const { runner, alarms } = setup({ watchdogMs: 30_000 });
    const g = gate();
    let seen: number | undefined;
    runner.define("job", [{ name: "a", run: async () => (await new Promise((r) => setTimeout(r, 5)), (seen = alarms.get(WAKE)), await g.promise) }]);
    await runner.start("job");
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toBe(T0 + 30_000);
    g.open();
    await runner.tick();
  });

  it("wakes on startup and install events", async () => {
    const { runner, listeners } = setup();
    expect(listeners.startup.length).toBe(1);
    expect(listeners.installed.length).toBe(1);
    expect(listeners.alarm.length).toBe(1);
    runner.define("job", [{ name: "a", run: () => 1 }]);
    await runner.tick();
  });
});
