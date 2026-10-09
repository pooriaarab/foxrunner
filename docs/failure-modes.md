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
