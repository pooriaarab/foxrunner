# Failure modes

This file lists every way foxrunner can fail. Each row names the wanted
behavior and the test that checks it. The rows come before the code, and the
tests commit before the code that makes them pass.

## Store and records

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| S1 | The storage area holds keys that other code wrote. | `entries(prefix)` returns only keys with that prefix. | `tests/store.test.ts` |
| S2 | The caller changes an object that the store returned. | The stored value does not change. | `tests/store.test.ts` |
| S3 | A write fails, for example because the quota is full. | The store rejects with the original error. Nothing hides it. | `tests/store.test.ts` |
| R1 | A task record is corrupted: not an object, a missing field, or an unknown status. | `parseTask` returns an error that names the problem. The record stays in storage for a person to read. | `tests/record.test.ts` |
| R2 | A record comes from a newer foxrunner (schema version above 1). | `parseTask` reports it as newer and does not change it. | `tests/record.test.ts` |
| R3 | A record has no schema version. | `parseTask` reports it as corrupted. | `tests/record.test.ts` |
| R4 | A step record has a negative or non-integer attempt count. | `parseTask` reports it as corrupted. | `tests/record.test.ts` |

## Running steps

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| T1 | The event page unloads in the middle of a step. | The next wake finds the step `running` with no owner. It counts one failure, "interrupted", and retries the step. | `tests/runner.test.ts`, E2E |
| T2 | Firefox is killed in the middle of a step. | Same as T1 when Firefox starts again with the same profile. | E2E |
| T3 | A step runs twice after a resume. | `ctx.idempotencyKey` is the same for every attempt of a step, so step code can skip work it already did. `ctx.attempt` grows. | `tests/runner.test.ts`, E2E |
| T4 | A step throws. | The task waits for the backoff time, then retries. After `maxAttempts` failures the task is `failed` with the last error. | `tests/runner.test.ts`, E2E |
| T5 | A step kills the page every time it runs. | Each cut-short attempt counts as a failure, so the task fails after `maxAttempts`. It does not loop forever. | `tests/runner.test.ts` |
| T6 | `start()` is called twice with the same task id. | One task. The step runs once. | `tests/runner.test.ts` |
| T7 | A task name has no definition. | `start()` throws. A stored task with no definition stays `queued` and the runner emits `error`. | `tests/runner.test.ts` |
| T8 | The definition changed and a stored step name is gone. | The task fails with an error that names the step. | `tests/runner.test.ts` |
| T9 | A step returns a value that is not JSON, or is larger than `maxOutputBytes`. | The step fails with no retry. A retry would give the same result. | `tests/runner.test.ts` |
| T10 | Two wakes (for example an alarm and startup) try to run the same task. | A lock lets one of them run it. The step runs once. | `tests/runner.test.ts` |
| T11 | The write that marks a step `running` fails. | The step does not run. The runner emits `error`. | `tests/runner.test.ts` |
| T12 | A corrupted record sits next to good records. | The runner emits `error` for it, leaves it in storage, and runs the good tasks. `list()` leaves it out. | `tests/runner.test.ts` |

## Pause, cancel, sleep and wake

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| C1 | The user pauses a task during a step. | `ctx.signal` aborts. The task becomes `paused` and runs no more steps. An error caused by the abort does not count as a failure. | `tests/control.test.ts`, E2E |
| C2 | The user cancels a task while it sleeps. | The task becomes `cancelled`. It stays cancelled when the wake time comes. | `tests/control.test.ts`, E2E |
| C3 | The user resumes a paused task. | It goes on from the step where it stopped. | `tests/control.test.ts`, E2E |
| C4 | A step needs a person to answer. | The task parks in `waiting` with the question. `resume(id, reply)` runs the step again with `ctx.reply`. | `tests/control.test.ts` |
| C5 | Pause, resume or cancel targets a finished task or an unknown id. | A finished task does not change. An unknown id throws. | `tests/control.test.ts` |
| C6 | A step must wait longer than the event page lives (for example 2 minutes). | The step returns `ctx.sleep(ms)`. The runner saves the wake time and sets an alarm. It does not hold a timer. | `tests/control.test.ts`, E2E |
| C7 | An alarm fires early. | Nothing runs early. The runner sets the alarm again for the saved time. | `tests/control.test.ts` |
| C8 | An alarm fires late, for example after the computer slept. | The task runs on that wake. | `tests/control.test.ts` |
| C9 | The clock moves back after a sleep starts. | The runner keeps the time that was left, so the task does not wait hours too long. | `tests/control.test.ts` |
| C10 | Alarms are lost, for example after an extension reload. | Every wake sets the alarm again from the stored tasks. | `tests/control.test.ts`, E2E |
| C11 | The event page unloads during a step, and no alarm is set to wake it. | While a step runs, the runner keeps a watchdog alarm `watchdogMs` ahead. | `tests/control.test.ts`, E2E |

## Schedules

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| Q1 | `every` is shorter than one minute, or not a whole number. | `schedule()` throws a `RangeError`. Alarms are not a fast timer. | `tests/schedule.test.ts` |
| Q2 | A cron string is wrong. | `parseCron` throws an error that names the bad field. | `tests/cron.test.ts` |
| Q3 | Runs were missed while Firefox was closed, and `catchUp` is `"once"`. | One run at the next wake, not one run for each missed slot. | `tests/schedule.test.ts` |
| Q4 | Runs were missed, and `catchUp` is `"skip"`. | No run. The next slot is planned. | `tests/schedule.test.ts` |
| Q5 | The run before is still going when the next slot comes. | With `overlap: "skip"` (the default) the slot is skipped and counted. With `"allow"` a second task starts. | `tests/schedule.test.ts` |
| Q6 | Two wakes in one page handle the same due slot. | One task. The task id comes from the schedule id and the slot time. | `tests/schedule.test.ts` |
| Q7 | The clock moves back. | The next slot is worked out again from the new time. | `tests/schedule.test.ts` |
| Q8 | A cron slot falls at a month end, on a weekday rule, or on a day that does not exist. | The next slot is a real time that matches every field. | `tests/cron.test.ts` |
| Q9 | The event page calls `schedule()` again on every wake. | The call keeps the planned next slot. It only plans again when the timing changes. | `tests/schedule.test.ts` |
| Q10 | Two schedules start the same task name at the same time. | Each starts its own task with its own id. | `tests/schedule.test.ts` |

## Headless helper

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| H1 | The command line is wrong: no `--extension`, an unknown flag, or a bad number. | Print the usage and exit with code 1. | `e2e/helper.mjs` |
| H2 | Firefox is not found. | Print where it looked and exit with code 2. | `e2e/helper.mjs` |
| H3 | The extension folder has no `manifest.json` or no gecko id. | Print the problem and exit with code 2. | `e2e/helper.mjs` |
| H4 | Firefox crashes or is killed. | Log the exit, wait, and start Firefox again with the same profile and extension. | `e2e/helper.mjs` |
| H5 | Firefox crashes again and again. | After more than `--max-restarts` crashes in 10 minutes, stop and exit with code 3. | `e2e/helper.mjs` |
| H6 | The helper gets SIGTERM or SIGINT. | Close Firefox and exit with code 0. | `e2e/helper.mjs` |
| H7 | The profile folder does not exist. | Create it. | `e2e/helper.mjs` |
| H8 | A restart gives the extension a new internal UUID, so its storage looks empty. | The helper pins the UUID from the gecko id and keeps storage when Firefox removes the temporary add-on. | `e2e/run.mjs` (restart check) |
| H9 | The helper gets SIGINT (Ctrl-C). Puppeteer's own SIGINT handler exits with code 130 before the helper can stop. | The helper turns off puppeteer's signal handlers and owns shutdown. It closes Firefox and exits with code 0. | `e2e/helper.mjs` |
| H10 | The helper gets SIGTERM while Firefox is still starting. | The helper waits for the start to end, closes Firefox, and exits with code 0, not 2. No Firefox is left on that profile. | `e2e/helper.mjs` |

## Demo extension in Firefox

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| E1 | The event page unloads for real in the middle of a step (idle timeout). | The watchdog alarm starts a new event page. The step runs again as attempt 2, and the idempotency ledger has one entry. | `e2e/run.mjs` |
| E2 | A step fails twice, then works. | The task waits for the backoff each time and ends `done`. The step shows 3 attempts and 2 failures. | `e2e/run.mjs` |
| E3 | Firefox is killed while one task sleeps and another is in a step. | After a restart with the same profile, the sleeping task wakes at its time without running the sleep step again. The cut-short step runs again. Both end `done`. | `e2e/run.mjs` |
| E4 | The extension reloads while a task sleeps. | The new event page sets the alarm again and the task ends `done`. | `e2e/run.mjs` |
| E5 | The popup sends pause, resume and cancel. | A paused task stays paused past its wake time, then ends `done` after resume. A cancelled task stays `cancelled`. | `e2e/run.mjs` |

## Wake alarm spin

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| W1 | A queued task has no definition in this page, for example after an update renamed it. | The wake alarm does not fire again at once. A due item this page cannot run gets a wake `watchdogMs` later. | `tests/wake.test.ts` |
| W2 | Another page holds the lock of a due task. | Same as W1. This page does not set the alarm to "now" again and again. | `tests/wake.test.ts` |
| W3 | A due schedule names a task that has no definition. | Same as W1. | `tests/wake.test.ts` |

## Review fixes

| # | Failure mode | Wanted behavior | Test |
|---|---|---|---|
| V1 | A waiting task is paused, then resumed with a reply. | The step runs again with `ctx.reply` set to that reply. | `tests/control.test.ts` |
| V2 | Two pages call `start()` with the same id at the same time. | Both get the one task. Neither throws. | `tests/runner.test.ts` |
| V3 | A cron day field has a step, such as `*/2`, and the other day field is set. | Both day fields must match, as in Vixie cron, because the field starts with `*`. | `tests/cron.test.ts` |
| V4 | A cron slot falls in the hour that a spring-forward clock change skips. | That day has no run. Vixie cron runs it after the change; foxrunner does not. The README lists this in Limits. | README Limits |
