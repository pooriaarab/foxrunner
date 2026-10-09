// The Firefox E2E test for the demo extension. It talks to the extension
// through a content script on a 127.0.0.1 page, not through an extension
// page, because an open extension page keeps the event page alive and this
// test needs the event page to unload.
// Usage: pnpm e2e [--headed]. Env: FIREFOX (the Firefox binary).
// Writes artifacts/e2e-<date>.json and artifacts/popup-<date>.png.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve, writeArtifact } from "create-foxkit/e2e";
import { launchFirefox } from "../dist/helper.js";

const record = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: actual === expected });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headless = !process.argv.includes("--headed");
// Firefox unloads an idle event page after 30 s. 2 s makes the unload happen during the test.
const prefs = { "extensions.background.idle.timeout": 2000 };

const site = await serve("e2e/site");
const profile = mkdtempSync(join(tmpdir(), "frn-e2e-"));
let fox;
let page;

async function start() {
  fox = await launchFirefox({ extension: "dist-ext", profile, headless, prefs });
  record.firefox ??= await fox.browser.version();
  page = await fox.browser.newPage();
  await page.goto(`${site.url}/index.html`, { waitUntil: "load" });
  await until("the content script mirrors state", (s) => s);
}

/** Send a command to the background through the content script. */
const send = (msg) =>
  page.evaluate(
    (m) =>
      new Promise((resolve) => {
        const id = Math.random().toString(36).slice(2);
        const onReply = (e) => {
          if (e.data?.frn !== "reply" || e.data.id !== id) return;
          window.removeEventListener("message", onReply);
          resolve(e.data.result);
        };
        window.addEventListener("message", onReply);
        window.postMessage({ frn: "command", id, msg: m }, "*");
      }),
    msg,
  );

const state = () => page.evaluate(() => JSON.parse(document.documentElement.dataset.frnState ?? "null")).catch(() => null);

async function until(label, fn, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const s = await state();
    const value = s && fn(s);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${label}; state: ${JSON.stringify(s)?.slice(0, 2000)}`);
    await sleep(250);
  }
}

const task = (s, id) => s.tasks.find((t) => t.id === id);
const step = (s, id, name) => task(s, id)?.steps.find((x) => x.name === name);
const status = (id, wanted) => (s) => task(s, id)?.status === wanted && task(s, id);
const ledgerOf = (s, id) => {
  const keys = Object.keys(s.ledger).filter((k) => k.startsWith(`${id}:`));
  return keys.length === 1 ? `${s.ledger[keys[0]].sideEffects}:${JSON.stringify(s.ledger[keys[0]].seenBy)}` : `${keys.length} keys`;
};
let snapshot;

try {
  await start();
  const bootsAtStart = (await state()).boots.length;

  // E1 + E2: a slow first attempt is cut short by a real idle unload.
  const a = await send({ type: "start", input: { slowMs: 20_000, waitMs: 3000 } });
  await until("A slow running", (s) => step(s, a.id, "slow")?.status === "running");
  const aDone = await until("A done", status(a.id, "done"), 90_000);
  const s1 = await state();
  check("E1 event page unloaded and woke again", true, s1.boots.length > bootsAtStart);
  check("E1 slow step ran twice", 2, aDone.steps[1].attempt);
  check("E1 first attempt counted as one failure", 1, aDone.steps[1].failures);
  check("E1 both attempts saw one idempotency key, one side effect", "1:[1,2]", ledgerOf(s1, a.id));
  check("E2 flaky step took 3 attempts", 3, aDone.steps[3].attempt);
  check("E2 flaky step failed twice", 2, aDone.steps[3].failures);

  // E3: kill Firefox while B sleeps and C is in a slow step.
  const b = await send({ type: "start", input: { slowMs: 0, waitMs: 12_000 } });
  await until("B sleeping", (s) => step(s, b.id, "wait")?.status === "sleeping");
  const c = await send({ type: "start", input: { slowMs: 60_000, waitMs: 1000 } });
  await until("C slow running", (s) => step(s, c.id, "slow")?.status === "running");
  process.kill(fox.pid, "SIGKILL");
  await fox.exited;
  await start();
  const bDone = await until("B done after restart", status(b.id, "done"), 90_000);
  const cDone = await until("C done after restart", status(c.id, "done"), 90_000);
  check("E3 sleeping task did not rerun its sleep step", 1, bDone.steps[2].attempt);
  check("E3 sleeping task woke after its wake time", true, bDone.steps[3].startedAt >= bDone.steps[2].wakeAt);
  check("E3 cut-short step ran again after restart", 2, cDone.steps[1].attempt);
  check("E3 both attempts saw one idempotency key, one side effect", "1:[1,2]", ledgerOf(await state(), c.id));

  // E4: reload the extension while D sleeps.
  const d = await send({ type: "start", input: { slowMs: 0, waitMs: 6000 } });
  await until("D sleeping", (s) => step(s, d.id, "wait")?.status === "sleeping");
  const bootsBeforeReload = (await state()).boots.length;
  await send({ type: "reload" }).catch(() => {});
  await sleep(1500);
  check("E4 reload started a new event page", true, (await state()).boots.length > bootsBeforeReload);
  await until("D done after reload", status(d.id, "done"), 60_000);
  check("E4 task finished after reload", "done", task(await state(), d.id).status);

  // E5: pause, resume and cancel.
  const e = await send({ type: "start", input: { slowMs: 0, waitMs: 3000 } });
  const f = await send({ type: "start", input: { slowMs: 0, waitMs: 60_000 } });
  await until("E and F sleeping", (s) => step(s, e.id, "wait")?.status === "sleeping" && step(s, f.id, "wait")?.status === "sleeping");
  await send({ type: "pause", id: e.id });
  await send({ type: "cancel", id: f.id });
  await until("E paused", status(e.id, "paused"));
  await sleep(5000);
  const g = await send({ type: "start", input: { slowMs: 0 } });
  await until("G sleeping", (s) => step(s, g.id, "wait")?.status === "sleeping");
  snapshot = await send({ type: "list" });
  check("E5 paused task stays paused past its wake time", "paused", task(await state(), e.id).status);
  check("E5 cancelled task is cancelled", "cancelled", task(await state(), f.id).status);
  await send({ type: "resume", id: e.id });
  await until("E done after resume", status(e.id, "done"), 60_000);
  check("E5 resumed task finished", "done", task(await state(), e.id).status);
  // One line per task: id, status, then each step as name:status:attempts/failures.
  record.tasks = (await state()).tasks
    .toSorted((x, y) => x.createdAt - y.createdAt)
    .map((t) => `${t.id.slice(0, 8)} ${t.status} ${t.steps.map((x) => `${x.name}:${x.status}:${x.attempt}/${x.failures}`).join(" ")}`);
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await fox?.browser.close().catch(() => {});
}

// Screenshot: the real popup.html and popup.js over http, with a stub browser
// object that returns the task list captured above. BiDi cannot capture
// moz-extension: pages.
if (snapshot) {
  const dir = mkdtempSync(join(tmpdir(), "frn-shot-"));
  const html = readFileSync("dist-ext/popup.html", "utf8").replace(
    '<script src="popup.js"></script>',
    `<script>window.browser={runtime:{sendMessage:async(m)=>m.type==="list"?${JSON.stringify(snapshot)}:null},storage:{onChanged:{addListener(){}}}};</script><script src="popup.js"></script>`,
  );
  writeFileSync(join(dir, "popup.html"), html);
  for (const file of ["popup.js", "popup.css"]) writeFileSync(join(dir, file), readFileSync(`dist-ext/${file}`));
  const shotSite = await serve(dir);
  const shooter = await launchFirefox({ extension: "dist-ext", profile: mkdtempSync(join(tmpdir(), "frn-shot-profile-")), headless: true });
  const shotPage = await shooter.browser.newPage();
  await shotPage.setViewport({ width: 420, height: 900 });
  await shotPage.goto(`${shotSite.url}/popup.html`, { waitUntil: "load" });
  await sleep(500);
  mkdirSync("artifacts", { recursive: true });
  record.screenshot = `artifacts/popup-${new Date().toISOString().slice(0, 10)}.png`;
  await shotPage.screenshot({ path: record.screenshot, fullPage: true });
  await shooter.browser.close();
  await shotSite.close();
  rmSync(dir, { recursive: true, force: true });
}
await site.close();
rmSync(profile, { recursive: true, force: true });
record.passed = !record.error && record.checks.length === 15 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${c.actual}`);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
