// advanceNextRun itself under a real non-UTC timezone (post-impl review gap:
// the DST block in task-scheduler.test.ts pins cron-parser directly; this file
// pins OUR code path — max(anchor, now) + tz — across the same transitions).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

vi.mock("./group-queue.js", () => ({ enqueue: vi.fn() }));
vi.mock("./config.js", async (importActual) => ({
  ...(await importActual<typeof import("./config.js")>()),
  AGENT_TIMEZONE: "Asia/Jerusalem",
}));

import { getTasksByGroup, insertTask, resetDb } from "./db.js";
import { advanceNextRun, resetSchedulerForTest } from "./task-scheduler.js";

beforeEach(() => {
  resetDb(new Database(":memory:"));
  resetSchedulerForTest();
});

afterEach(() => {
  resetSchedulerForTest();
});

function insertCron(expr: string, nextRun: string): number {
  return insertTask("tg-123", "123", "p", "cron", expr, nextRun);
}

function nextRunOf(id: number): string {
  return getTasksByGroup("tg-123").find((t) => t.id === id)!.next_run;
}

describe("advanceNextRun under Asia/Jerusalem (2026 spring-forward 03-27)", () => {
  it("on-time advance across the transition skips the nonexistent 03:00 slot", () => {
    // Firing at 03:00 IST on 03-26 (01:00Z); the next 03:00 local is 03-28 IDT.
    const id = insertCron("0 3 * * *", "2026-03-26T01:00:00.000Z");
    expect(advanceNextRun(getTasksByGroup("tg-123")[0], new Date("2026-03-26T01:00:00Z").getTime())).toBe(true);
    expect(nextRunOf(id)).toBe("2026-03-28T00:00:00.000Z");
  });

  it("multi-day-stale catch-up across the transition lands on the correct local slot", () => {
    // Anchored 03-24, process down until 03-28 06:00Z: one catch-up run fires
    // (the task is due), and next_run must be 03-29 03:00 IDT (00:00Z) — not a
    // replay of each missed day, and not a UTC-offset-drifted hour.
    const id = insertCron("0 3 * * *", "2026-03-24T01:00:00.000Z");
    expect(advanceNextRun(getTasksByGroup("tg-123")[0], new Date("2026-03-28T06:00:00Z").getTime())).toBe(true);
    expect(nextRunOf(id)).toBe("2026-03-29T00:00:00.000Z");
  });
});
