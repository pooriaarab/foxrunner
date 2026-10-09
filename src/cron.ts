// A small 5-field cron: minute hour day-of-month month day-of-week, in local
// time. Fields take *, numbers, a-b ranges, /steps and comma lists. Names
// such as MON or JAN are not supported.

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

function parseField(text: string, field: (typeof FIELDS)[number]): Set<number> {
  const bad = () => new Error(`cron ${field.name} field "${text}" is not valid (${field.min}-${field.max})`);
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!match) throw bad();
    const step = match[4] === undefined ? 1 : Number(match[4]);
    let lo: number = field.min;
    let hi: number = field.max;
    if (match[1] !== "*") {
      lo = Number(match[2]);
      hi = match[3] === undefined ? (match[4] === undefined ? lo : field.max) : Number(match[3]);
    }
    if (step < 1 || lo < field.min || hi > field.max || lo > hi) throw bad();
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron "${expr}" needs 5 fields: minute hour day-of-month month day-of-week`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]!)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (dow.has(7)) dow.add(0);
  return { minute, hour, dom, month, dow, domAny: parts[2]!.startsWith("*"), dowAny: parts[4]!.startsWith("*") };
}

// As in Vixie cron: a day field that starts with * (such as */2) does not
// switch the two day fields to "either matches".
function dayMatches(cron: Cron, d: Date) {
  const dom = cron.dom.has(d.getDate());
  const dow = cron.dow.has(d.getDay());
  return cron.domAny || cron.dowAny ? dom && dow : dom || dow;
}

/** The first matching minute strictly after `after` (ms since epoch). */
export function nextCron(cron: Cron, after: number): number {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after + 5 * 366 * 86_400_000;
  while (d.getTime() <= limit) {
    if (!cron.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0);
    } else if (!dayMatches(cron, d)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0);
    } else if (!cron.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0);
    } else if (!cron.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1);
    } else {
      return d.getTime();
    }
  }
  throw new Error("cron has no matching time in the next 5 years");
}
