# foxrunner

[![npm version](https://img.shields.io/npm/v/foxrunner)](https://www.npmjs.com/package/foxrunner)
[![Downloads/month](https://img.shields.io/npm/dm/foxrunner)](https://www.npmjs.com/package/foxrunner)
[![MIT license](https://img.shields.io/npm/l/foxrunner)](https://opensource.org/license/mit)
![Types included](https://img.shields.io/badge/types-included-blue)

[Setup](#install) · [API reference](#runtime-surfaces) · [Comparisons](#compare) · [Source](https://github.com/pooriaarab/foxrunner)

foxrunner is an open-source task runner for Firefox extension authors and browser-agent developers.
It saves named step records, retries failed steps, and wakes scheduled work through browser alarms.
A Node.js helper starts Firefox with your extension and restarts it after crashes.

## Install

```bash
npm install foxrunner
```

The helper and development tools require Node.js 24 or later.
The demo targets Firefox 153 or later.
The package includes TypeScript types and one direct runtime dependency, `puppeteer-core`.

## Run your first task

Save this example as `quickstart.mjs`, then run `node quickstart.mjs`.
It uses memory storage and needs no browser, credentials, environment variables, or `.env` file.
Success prints `Hello, Ada`.

```js
import { createRunner, memoryStore } from "foxrunner";

const runner = createRunner({ store: memoryStore() });
runner.define("greet", [
  { name: "name", run: (ctx) => ctx.input.name.trim() },
  { name: "say", run: (ctx) => `Hello, ${ctx.results.name}` },
]);

const task = await runner.start("greet", { name: " Ada " });
await runner.tick();
console.log((await runner.get(task.id)).steps.at(-1).output);
// Hello, Ada
```

Memory storage is temporary. Use `storageAreaStore(browser.storage.local)` for persistent extension records.
In a Firefox background script, pass `browser` to `createRunner` and grant `storage` and `alarms` permissions.
Define task steps before the first `await` on every background-page load.
Grant host access only for sites your step code calls.

```js
import { createRunner, storageAreaStore } from "foxrunner";

const runner = createRunner({ store: storageAreaStore(browser.storage.local), browser });
runner.define("reminder", [
  { name: "message", run: () => ({ text: "Check today's tasks" }) },
]);
await runner.schedule("reminder", { cron: "0 7 * * 1-5" });
```

## How it works

```text
start / schedule -> stored task -> named step -> save result -> next step
                                      |
                               interrupted or failed
                                      |
                              save retry time -> alarm
waitForInput -> waiting -> resume(reply) -> queued
Node.js helper -> Firefox + persistent profile -> your extension
```

Step state is saved before execution and after completion.
An unfinished `running` step consumes a failed attempt when another owner resumes it.
An alarm wakes due sleeps, retry backoff, schedules, and interrupted work.
Completed step outputs feed later steps through `ctx.results`.

## Why it exists

Firefox extension event pages can unload before a long task finishes.
foxrunner stores progress in the extension's own storage and resumes work on the next wake.
Temporal and Inngest provide durable execution systems for application workflows beyond a browser extension.

## Compare

Scope checked on 2026-10-14 against the linked official documentation.

| Scope | foxrunner | [Temporal](https://docs.temporal.io/workflows) | [Inngest](https://www.inngest.com/docs/durable-execution) |
|---|---|---|---|
| Main role | Firefox task steps and schedules | Durable Workflow Executions | Coordinated durable functions |
| State model | Task and step records in supplied store | Workflow execution history | Saved completed-step results |
| Configuration | JavaScript step definitions | Workflow Definitions | Functions and step primitives |
| Browser support here | Extension library and Firefox helper | Application-defined browser work | Application-defined browser work |

## Coverage

| Surface | Status | Behavior |
|---|---|---|
| Firefox WebExtensions | Implemented | Alarms and startup listeners wake stored tasks |
| Firefox `storage.local` | Implemented adapter | Persistent task, schedule, and control records |
| Memory storage | Implemented adapter | Temporary records for examples and tests |
| Interval schedules | Implemented | At least 60,000 ms between slots |
| Cron schedules | Implemented | Five numeric fields in local time |
| Web Locks | Implemented | Task ownership across extension pages when available |
| Puppeteer / WebDriver BiDi | Implemented | Helper launches Firefox and installs an unpacked extension |
| Model Context Protocol (MCP) server | — | No server or tool registry exported |

Source inventory: two storage adapters, two schedule modes, and one CLI command with six flags.
WebDriver Bidirectional (BiDi) communication runs through `puppeteer-core` in the Node.js helper.
Local tests cover runner, records, cron, storage, and helper behavior.
No live vendor integration or credential verification applies to this package.
This rewrite does not run the separate Firefox end-to-end suite.

## Common use cases

1. Firefox agent authors: schedule a weekday check and resume unfinished steps after the next browser wake.
2. Extension authors: park a task with `waitForInput()` and resume it after their UI collects a reply.
3. API automation authors: pass `ctx.idempotencyKey` to an API that supports duplicate-request suppression.
4. Home-lab operators: run `foxrunner helper` under systemd with an unpacked Firefox extension.
5. QA engineers: launch Firefox through `foxrunner/helper` with a persistent test profile.

## Features

- **Saved step records:** persistent state through a supplied storage adapter.
- **Retries:** per-step limits and exponential backoff.
- **Waits:** alarm-backed sleep and explicit user-input pauses.
- **Schedules:** interval or cron slots, catch-up policy, and overlap control.
- **Task controls:** pause, resume, cancel, list, and event listeners.
- **Firefox helper:** persistent profile, stable extension universally unique identifier (UUID), and bounded crash restarts.

## Runtime surfaces

`createRunner(options)` returns a runner. Options:

| Option | Default | What it does |
|---|---|---|
| `store` | required | Where records live: `storageAreaStore(browser.storage.local)` or `memoryStore()` |
| `browser` | none | The `browser` object. The runner adds `alarms.onAlarm`, `runtime.onStartup` and `runtime.onInstalled` listeners. |
| `retry` | `{ maxAttempts: 3, backoffMs: 1000, factor: 2, maxBackoffMs: 60000 }` | Retry options for steps that set none |
| `watchdogMs` | `30000` | How far ahead the wake alarm is while a step runs |
| `graceMs` | `60000` | A schedule slot later than this counts as missed |
| `maxOutputBytes` | `1000000` | Largest step output, in JSON characters |
| `locks` | `navigator.locks` | Locks that give each task one owner across extension pages |
| `autoTick` | `true` | Check the stored tasks once, right after `createRunner()` |

| Method | What it does |
|---|---|
| `define(name, steps)` | Defines a task. A step is `{ name, run(ctx), retry? }`. |
| `start(name, input, { id }?)` | Saves and starts a task. With the same `id`, it returns the first task, also when two pages call it at once. |
| `schedule(name, { every \| cron, input, catchUp, overlap, id })` | Runs a task every `every` ms (at least 60000) or on a 5-field cron string in local time. `catchUp`: `"once"` (default) or `"skip"`. `overlap`: `"skip"` (default) or `"allow"`. Calling it again keeps the next slot. |
| `unschedule(id)`, `schedules()` | Removes or lists schedules. |
| `get(id)`, `list()` | Reads one task or all tasks, newest first. |
| `pause(id)`, `resume(id, reply?)`, `cancel(id)` | Controls a task. `resume` also answers a waiting step. |
| `tick()` | Runs every due task and schedule, and waits for the work in this page. |
| `on(event, fn)` | Events in this page: `change` (a saved task), `step` (a step ended), `error` (a skipped record or a failed write). Returns a function that removes the listener. |

A step's `run(ctx)` gets `taskId`, `input`, `results` (earlier outputs by step name), `attempt`, `idempotencyKey` (the same for every attempt), `signal` (aborts on pause or cancel) and `reply`. It returns JSON, `ctx.sleep(ms)`, or `ctx.waitForInput(prompt)`.

Also exported: `memoryStore`, `storageAreaStore`, `parseTask`, `parseCron`, `nextCron`, `Sleep`, `WaitForInput`, schema/status constants, and record types. `foxrunner/helper` exports `launchFirefox`, `runHelper`, `findFirefox`, `geckoId`, `stableUuid`, `SetupError`, and `EXIT` for Node.

### CLI

```bash
npx foxrunner helper --extension ./my-extension --profile ~/.foxrunner/profile
```

| Flag | Default | What it does |
|---|---|---|
| `--extension <dir>` | required | An unpacked extension folder with a gecko id in its manifest |
| `--profile <dir>` | `~/.foxrunner/profile` | The Firefox profile. The helper makes the folder if it is missing. |
| `--headed` | off | Show a Firefox window |
| `--firefox <path>` | `FIREFOX`, then the usual install paths | The Firefox binary |
| `--max-restarts <n>` | `5` | Crashes allowed in 10 minutes before the helper stops |
| `--restart-delay <ms>` | `2000` | Wait before a restart. It doubles for each recent crash, up to 60 s. |

The helper logs one line per event to stdout: `helper loading` once, `starting firefox` before each launch, and then, for example, `firefox started pid=4242 extension=moz-extension://…/`.

| Exit code | Meaning |
|---|---|
| 0 | Stopped by SIGINT or SIGTERM. Firefox is closed. The CLI registers signal handlers before loading the helper module. |
| 1 | Bad command line |
| 2 | Cannot find Firefox, cannot read the extension, or the first start failed |
| 3 | Crash loop: more than `--max-restarts` crashes in 10 minutes |

The helper installs the extension as a temporary add-on on each start. It pins the extension's UUID from its gecko id and sets Firefox to keep the storage of a removed temporary add-on, so tasks survive restarts.

## Delivery and behavior limits

- Nothing runs while Firefox is closed, unless the helper runs. foxrunner does not install the helper as a service. Run it under launchd, systemd or Task Scheduler yourself.
- An interrupted step can run again. Use `ctx.idempotencyKey` with a destination that supports deduplication, or track completed side effects yourself.
- A step must end before Firefox unloads the idle event page (30 seconds by default). Use `ctx.sleep()` for long waits. A step that always needs more time fails after `maxAttempts`.
- A cut-short step is found only at the next wake, up to `watchdogMs` later.
- Schedules run at most once a minute. Cron has 5 fields in local time, with no names such as `MON`.
- A cron slot in the hour that a spring-forward clock change skips (such as `0 2 * * *`) does not run that day. Vixie cron runs it after the change.
- Events from `on()` reach only the page that runs the runner. Other pages read storage or send a message.
- Finished tasks stay in storage. There is no delete or retention API yet.
- `list()` reads all of `storage.local`, so it slows down with many thousands of records.
- The helper loads unpacked extension folders only, not `.xpi` files.
- foxrunner does not use the `idle` API yet, so it cannot hold heavy steps until the user is away.

## Integration guides

- [Firefox extension setup](#run-your-first-task) shows permissions, persistent storage, and task registration.
- [Helper command reference](#cli) lists every command flag and exit code.
- [Scheduling and retry API](#runtime-surfaces) describes catch-up, overlap, sleep, and backoff.

### Demo and local verification

```bash
pnpm install
pnpm ci:local
pnpm e2e
```

`ci:local` checks lint, types, unit tests, library build, demo build, extension lint, and the add-on listing.
`e2e` requires Firefox and runs the demo and helper against local fixtures.
It writes dated JSON artifacts and a popup screenshot.
To inspect the demo manually, run `pnpm build:ext` and load `dist-ext/manifest.json` through Firefox's temporary add-on screen.

## Status

Version 0.1.3 is an early release. APIs and record behavior can change during the 0.x series.
Report problems through [GitHub issues](https://github.com/pooriaarab/foxrunner/issues).
Public case studies are not yet published in this repository.

## FAQ

### What is foxrunner?

foxrunner runs named task steps and schedules inside Firefox extensions.
It also includes a Node.js helper that keeps Firefox running with your unpacked extension.

### Which integrations are verified?

foxrunner includes storage, alarm, locking, and helper paths covered by local tests.
It has no vendor API catalog requiring credential verification.

### Does foxrunner provide a managed task service?

foxrunner runs in your extension and helper process.
You supply storage, task code, and any service manager used to keep the helper running.

### How is foxrunner different from Temporal?

foxrunner stores task and step records in a supplied store for Firefox work.
[Temporal](https://docs.temporal.io/workflows) represents durable work as Workflow Executions from Workflow Definitions.

### How is foxrunner different from Inngest?

foxrunner wakes extension tasks through Firefox alarms.
[Inngest](https://www.inngest.com/docs/durable-execution) coordinates durable functions and stores their completed step results.

### Does foxrunner prevent duplicate side effects?

foxrunner supplies a stable per-step `idempotencyKey` across attempts.
Your destination or application must use it to deduplicate repeated effects.

### Does foxrunner run while Firefox is closed?

foxrunner's extension library runs only while Firefox runs.
The helper launches Firefox, and you can run that helper under your own service manager.

### Can foxrunner wait for a user reply?

foxrunner parks a step when it returns `ctx.waitForInput(prompt)`.
Call `resume(id, reply)` to queue that step again with the reply in its context.

### Does foxrunner have an MCP server?

foxrunner exposes a library and the `helper` command.
It has no Model Context Protocol (MCP) server.

## License

MIT. See the [MIT license text](https://opensource.org/license/mit).
