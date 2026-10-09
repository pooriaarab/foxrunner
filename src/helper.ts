// The headless helper: keeps one Firefox running with one extension and one
// persistent profile, and starts it again when it crashes. It talks to
// Firefox over WebDriver BiDi with puppeteer-core. Node only.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";

import { EXIT } from "./exit.js";

export { EXIT };

export class SetupError extends Error {}

/** The Firefox binary: the explicit path, then FIREFOX, then the usual install paths. */
export function findFirefox(explicit?: string): string {
  const chosen = explicit ?? process.env.FIREFOX;
  if (chosen) {
    if (existsSync(chosen)) return chosen;
    throw new SetupError(`cannot find Firefox at ${chosen}`);
  }
  const candidates =
    process.platform === "darwin"
      ? ["/Applications/Firefox.app/Contents/MacOS/firefox"]
      : process.platform === "win32"
        ? ["C:\\Program Files\\Mozilla Firefox\\firefox.exe"]
        : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "firefox"));
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new SetupError(`cannot find Firefox; looked in ${candidates.join(", ") || "PATH"}. Pass --firefox or set FIREFOX`);
  return found;
}

/** The gecko id from the extension's manifest.json. */
export function geckoId(extension: string): string {
  const file = join(extension, "manifest.json");
  if (!existsSync(file)) throw new SetupError(`${file} does not exist; --extension must be an unpacked extension folder`);
  const id = JSON.parse(readFileSync(file, "utf8"))?.browser_specific_settings?.gecko?.id;
  if (typeof id !== "string" || !id) throw new SetupError(`${file} must set browser_specific_settings.gecko.id`);
  return id;
}

/** A UUID made from the gecko id, so the moz-extension: origin and its storage stay the same across restarts. */
export function stableUuid(id: string): string {
  const h = createHash("sha256").update(`foxrunner:${id}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface LaunchOptions {
  extension: string;
  profile: string;
  headless?: boolean;
  firefox?: string;
  /** More Firefox preferences, for example a shorter event page idle timeout in a test. */
  prefs?: Record<string, unknown>;
}

export interface Launched {
  browser: Browser;
  pid: number;
  /** moz-extension://<uuid>/ for the extension. */
  extensionBase: string;
  /** Resolves when the Firefox process ends, for any reason. */
  exited: Promise<void>;
}

/** Start Firefox with a persistent profile and install the extension as a temporary add-on. */
export async function launchFirefox(options: LaunchOptions): Promise<Launched> {
  const extension = resolve(options.extension);
  const id = geckoId(extension);
  const executablePath = findFirefox(options.firefox);
  mkdirSync(options.profile, { recursive: true });
  const uuid = stableUuid(id);
  const browser = await puppeteer.launch({
    browser: "firefox",
    executablePath,
    headless: options.headless ?? true,
    userDataDir: resolve(options.profile),
    defaultViewport: null,
    // Puppeteer's own handlers exit the process (SIGINT with code 130). The
    // caller owns shutdown instead.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    extraPrefsFirefox: {
      ...options.prefs,
      "extensions.webextensions.uuids": JSON.stringify({ [id]: uuid }),
      // Firefox removes a temporary add-on when it quits. Keep its storage and UUID.
      "extensions.webextensions.keepStorageOnUninstall": true,
      "extensions.webextensions.keepUuidOnUninstall": true,
    },
  });
  const child = browser.process();
  const exited = new Promise<void>((done) => {
    child?.once("exit", () => done());
    browser.once("disconnected", () => done());
  });
  try {
    await browser.installExtension(extension);
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
  return { browser, pid: child?.pid ?? 0, extensionBase: `moz-extension://${uuid}/`, exited };
}

export interface HelperOptions extends LaunchOptions {
  /** Crashes allowed in 10 minutes before the helper gives up. Default 5. */
  maxRestarts?: number;
  /** Wait before the first restart; it doubles for each recent crash, up to 60 s. Default 2000. */
  restartDelayMs?: number;
  log?: (line: string) => void;
}

const WINDOW_MS = 10 * 60_000;

/** Keep Firefox running until stop() or a crash loop. `done` resolves with the exit code. */
export function runHelper(options: HelperOptions) {
  const log = options.log ?? ((line: string) => console.log(`${new Date().toISOString()} ${line}`));
  const maxRestarts = options.maxRestarts ?? 5;
  const baseDelay = options.restartDelayMs ?? 2000;
  const crashes: number[] = [];
  let current: Launched | undefined;
  let stopping = false;
  let wake: (() => void) | undefined;

  const done = (async (): Promise<number> => {
    for (let first = true; ; first = false) {
      try {
        // H12: tells a caller (and the E2E test) that a launch is under way.
        log("starting firefox");
        current = await launchFirefox(options);
        if (stopping) {
          // stop() came while Firefox was starting.
          await current.browser.close().catch(() => {});
          return EXIT.stopped;
        }
      } catch (error) {
        if (stopping) return EXIT.stopped;
        const text = error instanceof Error ? error.message : String(error);
        if (first || error instanceof SetupError) {
          log(`cannot start: ${text}`);
          return EXIT.setup;
        }
        log(`restart failed: ${text}`);
      }
      if (current) {
        log(`firefox started pid=${current.pid} extension=${current.extensionBase}`);
        await current.exited;
        current = undefined;
        if (stopping) return EXIT.stopped;
        log("firefox exited");
      }
      if (stopping) return EXIT.stopped;
      const t = Date.now();
      crashes.push(t);
      while (crashes.length && crashes[0]! < t - WINDOW_MS) crashes.shift();
      if (crashes.length > maxRestarts) {
        log(`crash loop: ${crashes.length} crashes in 10 minutes; giving up`);
        return EXIT.crashLoop;
      }
      const delay = Math.min(baseDelay * 2 ** (crashes.length - 1), 60_000);
      log(`restarting in ${delay} ms`);
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, delay);
      });
      if (stopping) return EXIT.stopped;
    }
  })();

  return {
    done,
    async stop() {
      stopping = true;
      wake?.();
      await current?.browser.close().catch(() => {});
    },
  };
}
