import { describe, expect, it } from "vitest";
import { parseTask, SCHEMA_VERSION } from "../src/index.js";

const good = () => ({
  v: SCHEMA_VERSION,
  id: "t1",
  name: "demo",
  input: { a: 1 },
  status: "queued",
  createdAt: 1,
  updatedAt: 1,
  steps: [{ name: "one", status: "pending", attempt: 0, failures: 0 }],
});

describe("parseTask", () => {
  it("accepts a good record", () => {
    const result = parseTask(good());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.task.id).toBe("t1");
  });

  it.each([
    ["not an object", "text"],
    ["null", null],
    ["no id", { ...good(), id: undefined }],
    ["no name", { ...good(), name: 3 }],
    ["unknown status", { ...good(), status: "stuck" }],
    ["steps not a list", { ...good(), steps: {} }],
    ["unknown step status", { ...good(), steps: [{ name: "one", status: "zzz", attempt: 0, failures: 0 }] }],
    ["step without a name", { ...good(), steps: [{ status: "pending", attempt: 0, failures: 0 }] }],
  ])("R1 reports a corrupted record: %s", (_label, value) => {
    const result = parseTask(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("corrupt");
  });

  it("R2 reports a record from a newer version and does not change it", () => {
    const value = { ...good(), v: SCHEMA_VERSION + 1, extra: "keep" };
    const copy = structuredClone(value);
    const result = parseTask(value);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("newer");
      expect(result.message).toContain(String(SCHEMA_VERSION + 1));
    }
    expect(value).toEqual(copy);
  });

  it("R3 reports a record with no version as corrupted", () => {
    const { v: _v, ...rest } = good();
    const result = parseTask(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("corrupt");
  });

  it.each([-1, 1.5, "2"])("R4 reports a bad attempt count: %s", (attempt) => {
    const result = parseTask({ ...good(), steps: [{ name: "one", status: "pending", attempt, failures: 0 }] });
    expect(result.ok).toBe(false);
  });
});
