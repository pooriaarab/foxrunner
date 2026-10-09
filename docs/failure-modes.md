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
