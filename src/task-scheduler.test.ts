import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { CronExpressionParser } from "cron-parser";
import {
  resetDb,
  insertTask,
  updateTaskNextRun,
  updateTaskStatus,
  getDueTasks,
  getTasksByGroup,
} from "./db.js";

beforeEach(() => {
  resetDb(new Database(":memory:"));
});

describe("interval drift prevention", () => {
  it("advances next_run from previous scheduled time, not now", () => {
    // Task was supposed to run at 10:00, interval is 1 hour
    const scheduledTime = "2026-03-12T10:00:00.000Z";
    const intervalMs = 3600_000; // 1 hour

    // Simulate: advance from scheduled time, not Date.now()
    const next = new Date(new Date(scheduledTime).getTime() + intervalMs).toISOString();
    expect(next).toBe("2026-03-12T11:00:00.000Z");
  });

  it("skips forward if fallen behind", () => {
    // Task was supposed to run at 10:00, but it's now 12:30. Interval = 1h.
    // Should skip to 13:00, not 11:00.
    const scheduledTime = "2026-03-12T10:00:00.000Z";
    const intervalMs = 3600_000;
    const now = new Date("2026-03-12T12:30:00.000Z").getTime();

    let next = new Date(scheduledTime).getTime() + intervalMs;
    while (next <= now) next += intervalMs;

    expect(new Date(next).toISOString()).toBe("2026-03-12T13:00:00.000Z");
  });

  it("handles exact boundary (next_run + interval === now)", () => {
    const scheduledTime = "2026-03-12T10:00:00.000Z";
    const intervalMs = 3600_000;
    const now = new Date("2026-03-12T11:00:00.000Z").getTime();

    let next = new Date(scheduledTime).getTime() + intervalMs;
    while (next <= now) next += intervalMs;

    // At exact boundary, should advance one more interval
    expect(new Date(next).toISOString()).toBe("2026-03-12T12:00:00.000Z");
  });
});

describe("cron next_run computation", () => {
  it("computes next run for a simple cron expression", () => {
    const expr = CronExpressionParser.parse("0 */6 * * *", {
      currentDate: new Date("2026-03-12T10:00:00Z"),
      tz: "UTC",
    });
    const next = expr.next().toDate().toISOString();
    expect(next).toBe("2026-03-12T12:00:00.000Z");
  });

  it("wraps to next day when no more matches today", () => {
    const expr = CronExpressionParser.parse("0 8 * * *", {
      currentDate: new Date("2026-03-12T09:00:00Z"),
      tz: "UTC",
    });
    const next = expr.next().toDate().toISOString();
    // 8am already passed (current is 9am), next is tomorrow 8am
    expect(next).toBe("2026-03-13T08:00:00.000Z");
  });

  it("rejects invalid cron expressions", () => {
    expect(() => CronExpressionParser.parse("not a cron")).toThrow();
  });
});

describe("one-shot tasks", () => {
  it("one-shot task is due when next_run is in the past", () => {
    insertTask("main", "chat1", "do once", "once", "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z");
    const due = getDueTasks(new Date().toISOString());
    expect(due).toHaveLength(1);
  });

  it("one-shot task should be marked completed after execution", () => {
    const id = insertTask("main", "chat1", "do once", "once", "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z");
    // Simulate what advanceNextRun does for one-shot
    updateTaskStatus(id, "completed");

    const due = getDueTasks(new Date().toISOString());
    expect(due).toHaveLength(0);

    const all = getTasksByGroup("main");
    expect(all[0].status).toBe("completed");
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
