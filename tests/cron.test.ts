import { describe, expect, it } from "vitest";
import { nextCron, parseCron } from "../src/index.js";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const next = (expr: string, from: number) => new Date(nextCron(parseCron(expr), from));

describe("cron", () => {
  it.each([
    ["* * * *", /5 fields/],
    ["61 * * * *", /minute/],
    ["* 24 * * *", /hour/],
    ["* * 0 * *", /day of month/],
    ["* * * 13 *", /month/],
    ["* * * * 8", /day of week/],
    ["*/0 * * * *", /minute/],
    ["5-1 * * * *", /minute/],
    ["MON * * * *", /minute/],
  ])("Q2 rejects %s", (expr, error) => {
    expect(() => parseCron(expr)).toThrow(error);
  });

  it("finds the next minute after now, not now", () => {
    expect(next("* * * * *", at(2026, 1, 1, 10, 0))).toEqual(new Date(at(2026, 1, 1, 10, 1)));
  });

  it("handles steps, ranges and lists", () => {
    expect(next("*/15 9-17 * * *", at(2026, 1, 1, 17, 50))).toEqual(new Date(at(2026, 1, 2, 9, 0)));
    expect(next("0 8,20 * * *", at(2026, 1, 1, 9, 0))).toEqual(new Date(at(2026, 1, 1, 20, 0)));
  });

  it("Q8 skips days that do not exist", () => {
    expect(next("0 0 31 * *", at(2026, 2, 1))).toEqual(new Date(at(2026, 3, 31)));
    expect(next("0 0 29 2 *", at(2026, 3, 1))).toEqual(new Date(at(2028, 2, 29)));
  });

  it("Q8 matches weekdays, with 7 as Sunday", () => {
    // 2026-01-01 is a Thursday.
    expect(next("0 9 * * 1", at(2026, 1, 1))).toEqual(new Date(at(2026, 1, 5, 9)));
    expect(next("0 9 * * 7", at(2026, 1, 1))).toEqual(new Date(at(2026, 1, 4, 9)));
  });

  it("Q8 matches either day field when both are set", () => {
    expect(next("0 0 15 * 1", at(2026, 1, 1))).toEqual(new Date(at(2026, 1, 5)));
  });
});
