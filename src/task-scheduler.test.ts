import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { CronExpressionParser } from "cron-parser";

const enqueue = vi.hoisted(() => vi.fn());
vi.mock("./group-queue.js", () => ({ enqueue }));
// Pin the cron timezone: AGENT_TIMEZONE is env-derived, and a developer .env
// with a non-UTC zone would shift every expected instant below.
vi.mock("./config.js", async (importActual) => ({
  ...(await importActual<typeof import("./config.js")>()),
  AGENT_TIMEZONE: "UTC",
}));

import { SCHEDULER_POLL_MS } from "./config.js";
import { getDb, getTasksByGroup, insertTask, resetDb, updateTaskNextRun } from "./db.js";
import { advanceNextRun, resetSchedulerForTest, startScheduler } from "./task-scheduler.js";
import type { Channel } from "./channels/registry.js";
import type { ScheduledTask } from "./types.js";

// Fixed "now" so every assertion is deterministic — injected via SchedulerDeps.now.
const NOW = new Date("2026-08-26T12:00:00.000Z").getTime();

function schedulerDeps() {
  return { secrets: {}, channel: {} as Channel, now: () => NOW };
}

function insertActive(
  scheduleType: "cron" | "interval" | "once",
  scheduleValue: string,
  nextRun: string,
): number {
  return insertTask("tg-123", "123", "prompt", scheduleType, scheduleValue, nextRun);
}

function taskById(id: number): ScheduledTask {
  const task = getTasksByGroup("tg-123").find((t) => t.id === id);
  if (!task) throw new Error(`task ${id} not found`);
  return task;
}

beforeEach(() => {
  resetDb(new Database(":memory:"));
  resetSchedulerForTest();
  enqueue.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  resetSchedulerForTest();
  vi.restoreAllMocks();
});

describe("poll() end-to-end: cron catch-up after downtime", () => {
  it("fires a multi-day-stale daily cron exactly once and lands next_run in the future", () => {
    // Daily at 09:00 UTC, last scheduled 3 days ago — pre-P7 this replayed
    // once per poll for every missed day.
    const id = insertActive("cron", "0 9 * * *", "2026-08-23T09:00:00.000Z");
    startScheduler(schedulerDeps());

    expect(enqueue).toHaveBeenCalledTimes(1);
    const after = taskById(id);
    expect(after.status).toBe("active");
    // Next occurrence strictly after NOW (12:00Z): tomorrow 09:00, not 08-24.
    expect(after.next_run).toBe("2026-08-27T09:00:00.000Z");

    // A second poll immediately after must not re-fire (nothing due).
    enqueue.mockClear();
    resetSchedulerForTest();
    startScheduler(schedulerDeps());
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("preserves drift anchoring when the task is due on time", () => {
    // Due exactly now: anchor == now, next comes from the schedule, not from
    // poll jitter.
    const id = insertActive("cron", "0 12 * * *", "2026-08-26T12:00:00.000Z");
    startScheduler(schedulerDeps());

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(taskById(id).next_run).toBe("2026-08-27T12:00:00.000Z");
  });
});

describe("advanceNextRun (exported unit)", () => {
  it("interval: skips forward past missed occurrences from the stored anchor", () => {
    const hour = 3_600_000;
    // Anchored 2.5 intervals in the past → next lands 0.5 intervals ahead.
    const anchor = new Date(NOW - 2.5 * hour).toISOString();
    const id = insertActive("interval", String(hour), anchor);

    expect(advanceNextRun(taskById(id), NOW)).toBe(true);
    expect(new Date(taskById(id).next_run).getTime()).toBe(NOW + 0.5 * hour);
  });

  it("interval: exact boundary (next === now) advances one more step", () => {
    const hour = 3_600_000;
    const anchor = new Date(NOW - hour).toISOString(); // anchor + ms === NOW
    const id = insertActive("interval", String(hour), anchor);

    advanceNextRun(taskById(id), NOW);
    // `next <= now` must advance again — flipping <= to < double-fires.
    expect(new Date(taskById(id).next_run).getTime()).toBe(NOW + hour);
  });

  it.each([
    ["non-numeric", "abc"],
    ["negative", "-5"],
    ["zero", "0"],
    ["trailing garbage parseInt would accept", "5000abc"],
    ["non-integer", "1000.5"],
  ])("interval: %s value pauses the task and returns false", (_label, value) => {
    const id = insertActive("interval", value, "2026-08-26T11:00:00.000Z");
    expect(advanceNextRun(taskById(id), NOW)).toBe(false);
    expect(taskById(id).status).toBe("paused");
  });

  it("interval: malformed next_run anchor pauses instead of throwing", () => {
    const id = insertActive("interval", "1000", "2026-08-26T11:00:00.000Z");
    updateTaskNextRun(id, "not-a-date");
    expect(advanceNextRun(taskById(id), NOW)).toBe(false);
    expect(taskById(id).status).toBe("paused");
  });

  it("cron: invalid expression pauses the task and returns false", () => {
    const id = insertActive("cron", "not a cron", "2026-08-26T11:00:00.000Z");
    expect(advanceNextRun(taskById(id), NOW)).toBe(false);
    expect(taskById(id).status).toBe("paused");
  });

  it("cron: a slightly-future anchor stays the anchor (no drift reset)", () => {
    // next_run a minute ahead of now (clock skew): anchor wins over now.
    const id = insertActive("cron", "0 9 * * *", "2026-08-26T12:01:00.000Z");
    expect(advanceNextRun(taskById(id), NOW)).toBe(true);
    expect(taskById(id).next_run).toBe("2026-08-27T09:00:00.000Z");
  });

  it("once: marks completed via the real path", () => {
    const id = insertActive("once", "2026-08-26T11:00:00.000Z", "2026-08-26T11:00:00.000Z");
    expect(advanceNextRun(taskById(id), NOW)).toBe(true);
    expect(taskById(id).status).toBe("completed");
  });
});

describe("poll() invalid-input handling (P7: paused tasks must not run)", () => {
  it.each([
    ["cron", "not a cron"],
    ["interval", "abc"],
  ] as const)("a due %s task with an invalid schedule is paused WITHOUT enqueue", (type, value) => {
    const id = insertActive(type, value, "2026-08-26T11:00:00.000Z");
    startScheduler(schedulerDeps());

    // Pre-P7 the task was paused but still ran once (enqueue after pause).
    expect(enqueue).not.toHaveBeenCalled();
    expect(taskById(id).status).toBe("paused");
  });

  it("a valid task still runs when an earlier task's enqueue throws", () => {
    insertActive("once", "x", "2026-08-26T10:00:00.000Z");
    insertActive("once", "x", "2026-08-26T11:00:00.000Z");
    enqueue.mockImplementationOnce(() => { throw new Error("queue closed"); });
    startScheduler(schedulerDeps());

    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});

describe("poll() ordering and in-flight dedup", () => {
  it("advances next_run BEFORE enqueue (at-most-once claim ordering)", () => {
    const id = insertActive("cron", "0 9 * * *", "2026-08-26T09:00:00.000Z");
    let nextRunAtEnqueue = "";
    enqueue.mockImplementationOnce(() => {
      nextRunAtEnqueue = taskById(id).next_run;
    });
    startScheduler(schedulerDeps());

    // The occurrence was claimed (next_run advanced) before the job existed.
    expect(nextRunAtEnqueue).toBe("2026-08-27T09:00:00.000Z");
  });

  it("skips a still-in-flight task on later polls, then re-fires after completion", () => {
    vi.useFakeTimers();
    try {
      // Mutable clock: each poll sees a later "now" so the 1s-interval task is
      // always due again by the next poll.
      let clock = NOW;
      const id = insertActive("interval", "1000", "2026-08-26T11:59:00.000Z");
      startScheduler({ secrets: {}, channel: {} as Channel, now: () => clock });
      expect(enqueue).toHaveBeenCalledTimes(1);

      // Next poll: task due again, but the first run hasn't completed → skipped.
      clock += SCHEDULER_POLL_MS;
      vi.advanceTimersByTime(SCHEDULER_POLL_MS);
      expect(enqueue).toHaveBeenCalledTimes(1);

      // Completion clears in-flight; the next poll fires it again.
      enqueue.mock.calls[0][0].onComplete("done");
      clock += SCHEDULER_POLL_MS;
      vi.advanceTimersByTime(SCHEDULER_POLL_MS);
      expect(enqueue).toHaveBeenCalledTimes(2);

      const logs = getDb().prepare("SELECT * FROM task_run_logs WHERE task_id = ?").all(id);
      expect(logs).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes success and error run logs via the job callbacks", () => {
    const id = insertActive("once", "x", "2026-08-26T11:00:00.000Z");
    startScheduler(schedulerDeps());
    const job = enqueue.mock.calls[0][0];

    job.onComplete("all good");
    job.onError("boom");
    const logs = getDb()
      .prepare("SELECT status, result, error FROM task_run_logs WHERE task_id = ? ORDER BY id")
      .all(id) as Array<{ status: string; result: string | null; error: string | null }>;
    expect(logs).toEqual([
      { status: "success", result: "all good", error: null },
      { status: "error", result: null, error: "boom" },
    ]);
  });
});

// P5.2 (Codex F5): cron-parser's Asia/Jerusalem DST behavior is pinned here so a
// cron-parser upgrade that changes it is caught. These are the ACCEPTED policy:
// a spring-forward day can skip a firing; a fall-back ambiguous time fires once.
describe("cron DST policy under a real timezone (P5.2)", () => {
  const tz = "Asia/Jerusalem"; // 2026: spring 03-27 02:00→03:00, fall 10-25 02:00→01:00

  it("skips the spring-forward day for a 03:00 daily task", () => {
    const it = CronExpressionParser.parse("0 3 * * *", {
      currentDate: new Date("2026-03-26T00:00:00Z"),
      tz,
    });
    const fires = [it.next().toDate().toISOString(), it.next().toDate().toISOString()];
    // 03:00 IST on 03-26, then 03:00 IDT on 03-28 — 2026-03-27 is skipped.
    expect(fires).toEqual(["2026-03-26T01:00:00.000Z", "2026-03-28T00:00:00.000Z"]);
  });

  it("fires an ambiguous fall-back time exactly once", () => {
    const it = CronExpressionParser.parse("30 1 * * *", {
      currentDate: new Date("2026-10-24T00:00:00Z"),
      tz,
    });
    const fires = [
      it.next().toDate().toISOString(),
      it.next().toDate().toISOString(),
      it.next().toDate().toISOString(),
    ];
    // 01:30 occurs twice on 10-25 (IDT then IST); only the second instant fires.
    expect(fires).toEqual([
      "2026-10-24T22:30:00.000Z",
      "2026-10-25T23:30:00.000Z",
      "2026-10-26T23:30:00.000Z",
    ]);
  });
});
