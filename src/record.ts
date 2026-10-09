// The stored shape of a task, and the check that every record passes before
// foxrunner acts on it. A record that fails the check stays in storage
// untouched, so a person can read it.

export const SCHEMA_VERSION = 1;

export const TASK_STATUSES = ["queued", "running", "waiting", "paused", "done", "failed", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STEP_STATUSES = ["pending", "running", "sleeping", "waiting", "done", "failed"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface StepRecord {
  name: string;
  status: StepStatus;
  /** How many times the step started. */
  attempt: number;
  /** How many attempts failed, including attempts cut short by an unload. */
  failures: number;
  output?: unknown;
  error?: string;
  startedAt?: number;
  endedAt?: number;
  /** When a sleeping step ends. */
  wakeAt?: number;
  /** The value given to `resume()` for a waiting step. */
  reply?: unknown;
}

export interface TaskRecord {
  v: number;
  id: string;
  name: string;
  input: unknown;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  /** The task does not run before this time (a sleep or a retry backoff). */
  runAt?: number;
  /** When runAt was set. A clock that moves back is found with it. */
  scheduledAt?: number;
  /** The question of a waiting step. */
  prompt?: unknown;
  error?: string;
  scheduleId?: string;
  steps: StepRecord[];
}

export type ParseResult =
  | { ok: true; task: TaskRecord }
  | { ok: false; reason: "corrupt" | "newer"; message: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;

function stepProblem(step: unknown, index: number): string | undefined {
  if (!isObject(step)) return `step ${index} is not an object`;
  if (typeof step.name !== "string" || !step.name) return `step ${index} has no name`;
  if (!STEP_STATUSES.includes(step.status as StepStatus)) return `step ${step.name} has unknown status ${String(step.status)}`;
  if (!isCount(step.attempt) || !isCount(step.failures)) return `step ${step.name} has a bad attempt count`;
  return undefined;
}

const corrupt = (message: string): ParseResult => ({ ok: false, reason: "corrupt", message });

/** Check a stored value. Never changes it. */
export function parseTask(value: unknown): ParseResult {
  if (!isObject(value)) return corrupt("the record is not an object");
  if (typeof value.v !== "number") return corrupt("the record has no schema version");
  if (value.v > SCHEMA_VERSION) {
    return { ok: false, reason: "newer", message: `the record has schema version ${value.v}; this foxrunner reads version ${SCHEMA_VERSION}` };
  }
  if (value.v !== SCHEMA_VERSION) return corrupt(`the record has unknown schema version ${value.v}`);
  if (typeof value.id !== "string" || !value.id) return corrupt("the record has no id");
  if (typeof value.name !== "string" || !value.name) return corrupt("the record has no task name");
  if (!TASK_STATUSES.includes(value.status as TaskStatus)) return corrupt(`the record has unknown status ${String(value.status)}`);
  if (typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") return corrupt("the record has no times");
  if (!Array.isArray(value.steps)) return corrupt("the record has no step list");
  for (const [index, step] of value.steps.entries()) {
    const problem = stepProblem(step, index);
    if (problem) return corrupt(problem);
  }
  return { ok: true, task: value as unknown as TaskRecord };
}
