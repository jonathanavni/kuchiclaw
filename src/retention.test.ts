import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { getDb, insertMessage, insertTask, insertTaskRunLog, resetDb, updateMessageStatus } from "./db.js";
import {
  failStrandedPending,
  pruneIpcErrors,
  pruneMessages,
  pruneTaskRunLogs,
} from "./retention.js";

function backdateMessage(id: number, ageDays: number): void {
  getDb().prepare("UPDATE messages SET timestamp = datetime('now', '-' || ? || ' days') WHERE id = ?")
    .run(ageDays, id);
}

function messageById(id: number) {
  return getDb().prepare("SELECT * FROM messages WHERE id = ?").get(id) as
    | { id: number; processing_status: string }
    | undefined;
}

beforeEach(() => {
  resetDb(new Database(":memory:"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("failStrandedPending (startup-only pass)", () => {
  it("fails only user rows pending past the ceiling", () => {
    const oldPending = insertMessage("tg-1", "user", "old"); // user rows default 'pending'
    const freshPending = insertMessage("tg-1", "user", "fresh");
    const oldProcessing = insertMessage("tg-1", "user", "live");
    updateMessageStatus(oldProcessing, "processing");
    getDb().prepare("UPDATE messages SET timestamp = datetime('now', '-2 hours') WHERE id IN (?, ?)")
      .run(oldPending, oldProcessing);

    expect(failStrandedPending(3600)).toBe(1);
    expect(messageById(oldPending)?.processing_status).toBe("failed");
    expect(messageById(freshPending)?.processing_status).toBe("pending");
    // 'processing' rows belong to the stuck sweep, never to this pass.
    expect(messageById(oldProcessing)?.processing_status).toBe("processing");
  });
});

describe("pruneMessages (terminal rows only, round-1 F3 / round-3 F1)", () => {
  it("never deletes pending/processing rows regardless of age", () => {
    const pending = insertMessage("tg-1", "user", "p");
    const processing = insertMessage("tg-1", "user", "w");
    updateMessageStatus(processing, "processing");
    backdateMessage(pending, 400);
    backdateMessage(processing, 400);

    expect(pruneMessages(30, 0)).toBe(0);
    expect(messageById(pending)).toBeDefined();
    expect(messageById(processing)).toBeDefined();
  });

  it("deletes old terminal rows but keeps the newest N per group", () => {
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      const id = insertMessage("tg-1", "assistant", `m${i}`);
      backdateMessage(id, 100 - i); // all far past 30 days, strictly ordered
      ids.push(id);
    }
    const otherGroup = insertMessage("tg-2", "assistant", "other");
    backdateMessage(otherGroup, 100);

    // Keep newest 3 per group: tg-1 loses its 3 oldest, tg-2 keeps its only row.
    expect(pruneMessages(30, 3)).toBe(3);
    expect(ids.map((id) => messageById(id) !== undefined)).toEqual([
      false, false, false, true, true, true,
    ]);
    expect(messageById(otherGroup)).toBeDefined();
  });

  it("keeps recent terminal rows and honors days=0 as disabled", () => {
    const recent = insertMessage("tg-1", "assistant", "recent");
    backdateMessage(recent, 5);
    expect(pruneMessages(30, 0)).toBe(0);

    const ancient = insertMessage("tg-1", "assistant", "ancient");
    backdateMessage(ancient, 400);
    expect(pruneMessages(0, 0)).toBe(0); // disabled
    expect(messageById(ancient)).toBeDefined();
  });
});

describe("pruneTaskRunLogs", () => {
  it("deletes only logs past the horizon", () => {
    const taskId = insertTask("tg-1", "1", "p", "once", "x", "2020-01-01T00:00:00Z");
    insertTaskRunLog(taskId, 10, "success", "old");
    insertTaskRunLog(taskId, 10, "success", "new");
    getDb().prepare("UPDATE task_run_logs SET run_at = datetime('now', '-60 days') WHERE result = 'old'").run();

    expect(pruneTaskRunLogs(30)).toBe(1);
    const remaining = getDb().prepare("SELECT result FROM task_run_logs").all() as Array<{ result: string }>;
    expect(remaining).toEqual([{ result: "new" }]);
  });
});

describe("pruneIpcErrors", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kuchiclaw-ipc-errors-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removes only files older than the horizon, ignores subdirs, tolerates a missing dir", () => {
    const oldFile = path.join(dir, "1-old.json");
    const newFile = path.join(dir, "2-new.json");
    fs.writeFileSync(oldFile, "{}");
    fs.writeFileSync(newFile, "{}");
    fs.mkdirSync(path.join(dir, "subdir"));
    const past = new Date(Date.now() - 40 * 24 * 60 * 60_000);
    fs.utimesSync(oldFile, past, past);

    expect(pruneIpcErrors(30, dir)).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
    expect(fs.existsSync(path.join(dir, "subdir"))).toBe(true);

    expect(pruneIpcErrors(30, path.join(dir, "does-not-exist"))).toBe(0);
  });
});
