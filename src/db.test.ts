import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resetDb,
  getDb,
  insertMessage,
  getRecentMessages,
  updateMessageStatus,
  getOrphanedMessages,
  insertTask,
  getDueTasks,
  getTasksByGroup,
  updateTaskStatus,
  updateTaskNextRun,
  insertTaskRunLog,
  initializeIpcLayoutEpoch,
  inspectDbAttestation,
} from "./db.js";

// Each test gets a fresh in-memory DB with schema applied
beforeEach(() => {
  resetDb(new Database(":memory:"));
});

describe("IPC layout database epoch", () => {
  it("initializes user_version 2 on a fresh database", () => {
    initializeIpcLayoutEpoch();
    expect(getDb().pragma("user_version", { simple: true })).toBe(2);
  });

  it("reads the epoch and legacy task count without schema initialization", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kuchiclaw-db-state-"));
    const databasePath = path.join(directory, "state.db");
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE scheduled_tasks (id INTEGER PRIMARY KEY);
      INSERT INTO scheduled_tasks DEFAULT VALUES;
      PRAGMA user_version = 1;
    `);
    database.close();

    expect(inspectDbAttestation(databasePath)).toEqual({
      exists: true,
      userVersion: 1,
      scheduledTaskCount: 1,
    });
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

describe("scheduled_tasks CRUD", () => {
  it("inserts a task and returns its ID", () => {
    const id = insertTask("main", "chat1", "do stuff", "once", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "test task");
    expect(id).toBe(1);
  });

  it("getDueTasks returns tasks whose next_run is in the past", () => {
    insertTask("main", "chat1", "past task", "once", "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z");
    insertTask("main", "chat1", "future task", "once", "2099-01-01T00:00:00Z", "2099-01-01T00:00:00Z");

    const due = getDueTasks(new Date().toISOString());
    expect(due).toHaveLength(1);
    expect(due[0].prompt).toBe("past task");
  });

  it("getDueTasks excludes paused and completed tasks", () => {
    const id1 = insertTask("main", "chat1", "paused", "once", "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z");
    const id2 = insertTask("main", "chat1", "completed", "once", "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z");
    insertTask("main", "chat1", "active", "once", "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z");

    updateTaskStatus(id1, "paused");
    updateTaskStatus(id2, "completed");

    const due = getDueTasks(new Date().toISOString());
    expect(due).toHaveLength(1);
    expect(due[0].prompt).toBe("active");
  });

  it("getTasksByGroup returns all tasks for a group regardless of status", () => {
    insertTask("main", "chat1", "task1", "cron", "0 * * * *", "2020-01-01T00:00:00Z");
    insertTask("main", "chat1", "task2", "interval", "3600000", "2020-01-01T00:00:00Z");
    insertTask("other", "chat2", "task3", "once", "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z");

    expect(getTasksByGroup("main")).toHaveLength(2);
    expect(getTasksByGroup("other")).toHaveLength(1);
    expect(getTasksByGroup("nonexistent")).toHaveLength(0);
  });

  it("updateTaskStatus returns false for nonexistent task", () => {
    expect(updateTaskStatus(999, "paused")).toBe(false);
  });

  it("updateTaskNextRun changes the next_run value", () => {
    const id = insertTask("main", "chat1", "task", "interval", "60000", "2026-01-01T00:00:00Z");
    updateTaskNextRun(id, "2026-01-01T01:00:00Z");

    const tasks = getTasksByGroup("main");
    expect(tasks[0].next_run).toBe("2026-01-01T01:00:00Z");
  });
});

describe("task_run_logs", () => {
  it("logs a successful run", () => {
    const taskId = insertTask("main", "chat1", "task", "once", "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z");
    insertTaskRunLog(taskId, 1500, "success", "all good");

    // Verify via raw query (no dedicated getter needed yet)
    const db = getDb();
    const logs = db.prepare("SELECT * FROM task_run_logs WHERE task_id = ?").all(taskId) as any[];
    expect(logs).toHaveLength(1);
    expect(logs[0].duration_ms).toBe(1500);
    expect(logs[0].status).toBe("success");
    expect(logs[0].result).toBe("all good");
  });

  it("logs an error run", () => {
    const taskId = insertTask("main", "chat1", "task", "once", "2020-01-01T00:00:00Z", "2020-01-01T00:00:00Z");
    insertTaskRunLog(taskId, 500, "error", undefined, "container crashed");

    const db = getDb();
    const logs = db.prepare("SELECT * FROM task_run_logs WHERE task_id = ?").all(taskId) as any[];
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("error");
    expect(logs[0].error).toBe("container crashed");
  });
});

// --- M10: Crash Recovery ---

describe("message processing_status", () => {
  it("insertMessage sets pending for user, done for assistant", () => {
    const userId = insertMessage("main", "user", "hello");
    insertMessage("main", "assistant", "hi back");

    const msgs = getRecentMessages("main");
    expect(msgs).toHaveLength(2);
    expect(msgs[0].processing_status).toBe("pending");
    expect(msgs[1].processing_status).toBe("done");
  });

  it("insertMessage returns row ID", () => {
    const id1 = insertMessage("main", "user", "first");
    const id2 = insertMessage("main", "user", "second");
    expect(id1).toBe(1);
    expect(id2).toBe(2);
  });

  it("insertMessage stores chat_id and sender_name", () => {
    insertMessage("main", "user", "hello", { chatId: "123", senderName: "Alice" });

    const msgs = getRecentMessages("main");
    expect(msgs[0].chat_id).toBe("123");
    expect(msgs[0].sender_name).toBe("Alice");
  });

  it("updateMessageStatus transitions correctly", () => {
    const id = insertMessage("main", "user", "hello");

    updateMessageStatus(id, "processing");
    let msg = getRecentMessages("main")[0];
    expect(msg.processing_status).toBe("processing");

    updateMessageStatus(id, "done");
    msg = getRecentMessages("main")[0];
    expect(msg.processing_status).toBe("done");
  });

  it("updateMessageStatus can set failed", () => {
    const id = insertMessage("main", "user", "hello");
    updateMessageStatus(id, "failed");

    const msg = getRecentMessages("main")[0];
    expect(msg.processing_status).toBe("failed");
  });
});

describe("getOrphanedMessages", () => {
  it("finds pending/processing user messages within age window", () => {
    const db = getDb();

    // Insert messages with manually set timestamps to simulate age
    db.prepare(`
      INSERT INTO messages (group_folder, role, content, processing_status, chat_id, sender_name, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-30 seconds'))
    `).run("main", "user", "orphan1", "pending", "123", "Alice");

    db.prepare(`
      INSERT INTO messages (group_folder, role, content, processing_status, chat_id, sender_name, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-60 seconds'))
    `).run("main", "user", "orphan2", "processing", "123", "Bob");

    const orphans = getOrphanedMessages();
    expect(orphans).toHaveLength(2);
    expect(orphans[0].content).toBe("orphan2"); // older first
    expect(orphans[1].content).toBe("orphan1");
  });

  it("excludes messages newer than minAge", () => {
    // Insert a fresh message (just now) — should be excluded by 10s min age
    insertMessage("main", "user", "too fresh", { chatId: "123", senderName: "Alice" });

    const orphans = getOrphanedMessages();
    expect(orphans).toHaveLength(0);
  });

  it("excludes messages older than maxAge", () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO messages (group_folder, role, content, processing_status, chat_id, sender_name, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-2 hours'))
    `).run("main", "user", "too old", "pending", "123", "Alice");

    const orphans = getOrphanedMessages();
    expect(orphans).toHaveLength(0);
  });

  it("excludes done and failed messages", () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO messages (group_folder, role, content, processing_status, timestamp)
      VALUES (?, ?, ?, ?, datetime('now', '-30 seconds'))
    `).run("main", "user", "already done", "done");

    db.prepare(`
      INSERT INTO messages (group_folder, role, content, processing_status, timestamp)
      VALUES (?, ?, ?, ?, datetime('now', '-30 seconds'))
    `).run("main", "user", "already failed", "failed");

    const orphans = getOrphanedMessages();
    expect(orphans).toHaveLength(0);
  });

  it("excludes assistant messages", () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO messages (group_folder, role, content, processing_status, timestamp)
      VALUES (?, ?, ?, ?, datetime('now', '-30 seconds'))
    `).run("main", "assistant", "stale response", "pending");

    const orphans = getOrphanedMessages();
    expect(orphans).toHaveLength(0);
  });
});
