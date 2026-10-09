#!/usr/bin/env node
// foxrunner helper: keep Firefox running with an extension, headless or with
// a window, and start it again when it crashes.
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { EXIT, runHelper } from "./helper.js";

const USAGE = `Usage: foxrunner helper --extension <dir> [--profile <dir>] [--headed]
       [--firefox <path>] [--max-restarts <n>] [--restart-delay <ms>]

Exit codes: 0 stopped by SIGINT or SIGTERM, 1 bad command line,
2 cannot start Firefox or read the extension, 3 crash loop.`;

function usage(problem: string): never {
  console.error(`foxrunner: ${problem}\n\n${USAGE}`);
  process.exit(EXIT.usage);
}

function count(text: string | undefined, name: string, fallback: number): number {
  if (text === undefined) return fallback;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 0) usage(`--${name} must be a whole number, got ${text}`);
  return n;
}

const [command, ...rest] = process.argv.slice(2);
if (command !== "helper") usage(command ? `unknown command ${command}` : "no command");
let values: Record<string, string | boolean | undefined>;
try {
  ({ values } = parseArgs({
    args: rest,
    options: {
      extension: { type: "string" },
      profile: { type: "string" },
      headed: { type: "boolean" },
      firefox: { type: "string" },
      "max-restarts": { type: "string" },
      "restart-delay": { type: "string" },
    },
  }));
} catch (error) {
  usage(error instanceof Error ? error.message : String(error));
}
if (typeof values.extension !== "string") usage("--extension is required");

const helper = runHelper({
  extension: values.extension,
  profile: typeof values.profile === "string" ? values.profile : join(homedir(), ".foxrunner", "profile"),
  headless: !values.headed,
  ...(typeof values.firefox === "string" ? { firefox: values.firefox } : {}),
  maxRestarts: count(values["max-restarts"] as string | undefined, "max-restarts", 5),
  restartDelayMs: count(values["restart-delay"] as string | undefined, "restart-delay", 2000),
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void helper.stop());
process.exitCode = await helper.done;
