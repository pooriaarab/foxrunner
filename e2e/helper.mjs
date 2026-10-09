// E2E test of `foxrunner helper`: start it with the demo extension, kill its
// Firefox and check that it starts Firefox again, then check the crash-loop
// stop, clean SIGTERM and SIGINT stops, a stop during start-up and the
// setup errors.
// Writes artifacts/helper-<date>.json. Env: FIREFOX (the Firefox binary).
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeArtifact } from "create-foxkit/e2e";

const record = { startedAt: new Date().toISOString(), checks: [] };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: actual === expected });
const headed = process.argv.includes("--headed");

function helper(args) {
  const child = spawn(process.execPath, ["dist/cli.js", "helper", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  let buffer = "";
  const waiters = [];
  const onData = (chunk) => {
    buffer += chunk;
    const parts = buffer.split("\n");
    buffer = parts.pop();
    for (const line of parts) {
      lines.push(line);
      for (const w of waiters.filter((x) => x.re.test(line))) {
        waiters.splice(waiters.indexOf(w), 1);
        w.done(line);
      }
    }
  };
  child.stdout.setEncoding("utf8").on("data", onData);
  child.stderr.setEncoding("utf8").on("data", onData);
  const exited = new Promise((done) => child.on("exit", (code) => done(code)));
  const waitFor = (re, ms = 60_000) =>
    new Promise((done, fail) => {
      const hit = lines.find((l) => re.test(l));
      if (hit) return done(hit);
      const timer = setTimeout(() => fail(new Error(`timed out waiting for ${re}; log:\n${lines.join("\n")}`)), ms);
      waiters.push({ re, done: (l) => (clearTimeout(timer), done(l)) });
    });
  return { child, lines, exited, waitFor };
}

const pidOf = (line) => Number(/pid=(\d+)/.exec(line)?.[1]);
const profile = join(mkdtempSync(join(tmpdir(), "frn-helper-")), "new-profile");
const extra = headed ? ["--headed"] : [];
try {
  // H1, H2, H3: setup errors exit fast with the documented codes.
  check("no --extension exits 1", 1, await helper([]).exited);
  check("unknown flag exits 1", 1, await helper(["--extension", "dist-ext", "--nope"]).exited);
  check("missing Firefox exits 2", 2, await helper(["--extension", "dist-ext", "--firefox", "/no/such/firefox"]).exited);
  check("folder without manifest exits 2", 2, await helper(["--extension", "e2e"]).exited);

  // H4, H5, H7: kill Firefox once (restart), then again (crash loop, exit 3).
  const run = helper(["--extension", "dist-ext", "--profile", profile, "--max-restarts", "1", "--restart-delay", "500", ...extra]);
  const first = pidOf(await run.waitFor(/firefox started pid=\d+/));
  process.kill(first, "SIGKILL");
  await run.waitFor(/firefox exited/);
  const secondLine = await run.waitFor(new RegExp(`firefox started pid=(?!${first}\\b)\\d+`));
  const second = pidOf(secondLine);
  check("helper started a new Firefox after a kill", true, second > 0 && second !== first);
  process.kill(second, "SIGKILL");
  check("second crash in the window exits 3", 3, await run.exited);
  record.restartLog = run.lines;

  // H6: SIGTERM closes Firefox and exits 0.
  const calm = helper(["--extension", "dist-ext", "--profile", profile, ...extra]);
  const calmPid = pidOf(await calm.waitFor(/firefox started pid=\d+/));
  calm.child.kill("SIGTERM");
  check("SIGTERM exits 0", 0, await calm.exited);
  let alive = true;
  try {
    process.kill(calmPid, 0);
  } catch {
    alive = false;
  }
  check("SIGTERM closed Firefox", false, alive);

  // H9: SIGINT exits 0 too (puppeteer's own handler used to exit 130).
  const ctrlC = helper(["--extension", "dist-ext", "--profile", profile, ...extra]);
  await ctrlC.waitFor(/firefox started pid=\d+/);
  ctrlC.child.kill("SIGINT");
  check("SIGINT exits 0", 0, await ctrlC.exited);

  // H10: SIGTERM while Firefox is still starting exits 0 and leaves no Firefox.
  const early = helper(["--extension", "dist-ext", "--profile", profile, ...extra]);
  await new Promise((r) => setTimeout(r, 300));
  early.child.kill("SIGTERM");
  check("SIGTERM during start-up exits 0", 0, await early.exited);
  await new Promise((r) => setTimeout(r, 1000));
  let left = "";
  try {
    left = execFileSync("pgrep", ["-f", profile], { encoding: "utf8" }).trim();
  } catch {
    left = "";
  }
  check("no Firefox left on the profile", "", left);
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  rmSync(join(profile, ".."), { recursive: true, force: true });
}
record.passed = !record.error && record.checks.length === 11 && record.checks.every((c) => c.ok);
const path = writeArtifact("artifacts", "helper", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${c.actual}`);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
