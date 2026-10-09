import { describe, expect, it } from "vitest";
import { memoryStore, storageAreaStore } from "../src/index.js";

function fakeArea(data: Record<string, unknown> = {}, failSet = false) {
  return {
    data,
    async get(keys: string | null) {
      if (keys === null) return structuredClone(data);
      return keys in data ? { [keys]: structuredClone(data[keys]) } : {};
    },
    async set(items: Record<string, unknown>) {
      if (failSet) throw new Error("QuotaExceededError");
      Object.assign(data, structuredClone(items));
    },
    async remove(key: string) {
      delete data[key];
    },
  };
}

describe("memoryStore", () => {
  it("S1 returns only keys with the prefix", async () => {
    const store = memoryStore();
    await store.set("frn:task:a", { n: 1 });
    await store.set("other", { n: 2 });
    expect(await store.entries("frn:task:")).toEqual([["frn:task:a", { n: 1 }]]);
  });

  it("S2 keeps its own copy of values", async () => {
    const store = memoryStore();
    const value = { n: 1 };
    await store.set("k", value);
    value.n = 2;
    const read = (await store.get("k")) as { n: number };
    read.n = 3;
    expect(await store.get("k")).toEqual({ n: 1 });
  });

  it("removes a key", async () => {
    const store = memoryStore();
    await store.set("k", 1);
    await store.remove("k");
    expect(await store.get("k")).toBeUndefined();
  });
});

describe("storageAreaStore", () => {
  it("S1 returns only keys with the prefix", async () => {
    const store = storageAreaStore(fakeArea({ "frn:task:a": 1, "frn:schedule:b": 2, theme: "dark" }));
    expect(await store.entries("frn:task:")).toEqual([["frn:task:a", 1]]);
    expect(await store.get("theme")).toBe("dark");
    expect(await store.get("missing")).toBeUndefined();
  });

  it("S3 passes a failed write to the caller", async () => {
    const store = storageAreaStore(fakeArea({}, true));
    await expect(store.set("k", 1)).rejects.toThrow("QuotaExceededError");
  });

  it("writes and removes through the area", async () => {
    const area = fakeArea();
    const store = storageAreaStore(area);
    await store.set("k", { a: 1 });
    expect(area.data.k).toEqual({ a: 1 });
    await store.remove("k");
    expect("k" in area.data).toBe(false);
  });
});
