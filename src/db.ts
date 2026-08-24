// SQLite database for persistent message history.
// Uses better-sqlite3 (synchronous API) — fine for a single-process orchestrator.

import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { DATA_DIR } from "./config.js";
import type { ScheduledTask, TaskRunLog } from "./types.js";

export const DB_PATH = path.join(DATA_DIR, "kuchiclaw.db");
export const IPC_LAYOUT_DB_VERSION = 2;

export type ProcessingStatus = "pending" | "processing" | "done" | "failed";

/** A stored message (user prompt or agent response) */
export interface Message {
  id: number;
  group_folder: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string; // ISO 8601
  processing_status: ProcessingStatus;
  chat_id: string | null;
  sender_name: string | null;
  /** Times this message has been re-enqueued by crash recovery / the stuck sweep. */
  recovery_count: number;
}

let db: Database.Database | null = null;

/** Reset the DB connection. If a new Database is provided, schema is initialized
 *  on it. Used by tests to inject an in-memory DB without touching disk. */
export function resetDb(override?: Database.Database): void {
  if (db) db.close();
  db = null;
  if (override) {
    db = override;
    initSchema(db);
  }
}

/** Get or create the database connection, initializing schema if needed. */
export function getDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);

  // WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  initSchema(db);

  return db;
}

export interface DbAttestation {
  exists: boolean;
  userVersion: number;
  scheduledTaskCount: number;
}

/** Read the cutover state without running schema creation or migrations. */
export function inspectDbAttestation(databasePath = DB_PATH): DbAttestation {
  if (!fs.existsSync(databasePath)) {
    return { exists: false, userVersion: 0, scheduledTaskCount: 0 };
  }

  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const userVersion = database.pragma("user_version", { simple: true }) as number;
    const table = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_tasks'",
    ).get();
    const scheduledTaskCount = table
      ? (database.prepare("SELECT COUNT(*) AS count FROM scheduled_tasks").get() as { count: number }).count
      : 0;
    return { exists: true, userVersion, scheduledTaskCount };
  } finally {
    database.close();
  }
}

/** Stamp a fresh database only after startup has proved there is no legacy state. */
export function initializeIpcLayoutEpoch(): void {
  const database = getDb();
  database.transaction(() => {
    database.pragma(`user_version = ${IPC_LAYOUT_DB_VERSION}`);
  })();
}

function initSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_group_time
      ON messages (group_folder, timestamp DESC);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL CHECK (schedule_type IN ('cron', 'interval', 'once')),
      schedule_value TEXT NOT NULL,
      next_run TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      label TEXT
    );

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES scheduled_tasks(id),
      run_at TEXT NOT NULL DEFAULT (datetime('now')),
      duration_ms INTEGER,
      status TEXT NOT NULL CHECK (status IN ('success', 'error')),
      result TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs_task
      ON task_run_logs (task_id, run_at DESC);
  `);

  // M10 migration: crash recovery columns on messages table.
  // ALTER TABLE throws if column already exists — catch to stay idempotent.
  const migrations = [
    `ALTER TABLE messages ADD COLUMN processing_status TEXT NOT NULL DEFAULT 'done'`,
    `ALTER TABLE messages ADD COLUMN chat_id TEXT`,
    `ALTER TABLE messages ADD COLUMN sender_name TEXT`,
    // M12 P3: cap how many times a message is replayed across restarts/sweeps.
    `ALTER TABLE messages ADD COLUMN recovery_count INTEGER NOT NULL DEFAULT 0`,
  ];
  for (const sql of migrations) {
    try { database.exec(sql); } catch { /* column already exists */ }
  }
}

/** Store a message. Returns the row ID for status tracking. */
export function insertMessage(
  groupFolder: string,
  role: "user" | "assistant",
  content: string,
  opts?: { chatId?: string; senderName?: string },
): number {
  const status: ProcessingStatus = role === "user" ? "pending" : "done";
  const stmt = getDb().prepare(
    "INSERT INTO messages (group_folder, role, content, processing_status, chat_id, sender_name) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const result = stmt.run(groupFolder, role, content, status, opts?.chatId ?? null, opts?.senderName ?? null);
  return result.lastInsertRowid as number;
}

/** Update a message's processing status. */
export function updateMessageStatus(messageId: number, status: ProcessingStatus): void {
  const stmt = getDb().prepare("UPDATE messages SET processing_status = ? WHERE id = ?");
  stmt.run(status, messageId);
}

/** Find orphaned user messages: pending/processing, older than minAgeSec, younger than maxAgeSec. */
export function getOrphanedMessages(minAgeSec = 10, maxAgeSec = 3600): Message[] {
  const stmt = getDb().prepare(`
    SELECT * FROM messages
    WHERE role = 'user'
      AND processing_status IN ('pending', 'processing')
      AND timestamp < datetime('now', '-' || ? || ' seconds')
      AND timestamp > datetime('now', '-' || ? || ' seconds')
    ORDER BY timestamp ASC
  `);
  return stmt.all(minAgeSec, maxAgeSec) as Message[];
}

/**
 * Find messages stranded in 'processing' while the orchestrator is LIVE — older
 * than a ceiling well beyond the container timeout, so a legitimately in-flight
 * job (which finishes within the timeout) is never swept. Uses the creation
 * timestamp as the stuck proxy (a status-change column would be exact but adds
 * surface; a backlog older than the ceiling is negligible for a single-operator bot).
 */
export function getStuckProcessingMessages(minAgeSec: number): Message[] {
  const stmt = getDb().prepare(`
    SELECT * FROM messages
    WHERE role = 'user'
      AND processing_status = 'processing'
      AND timestamp < datetime('now', '-' || ? || ' seconds')
    ORDER BY timestamp ASC
  `);
  return stmt.all(minAgeSec) as Message[];
}

/** Increment a message's recovery counter and return the new value. */
export function incrementRecoveryCount(messageId: number): number {
  const row = getDb()
    .prepare("UPDATE messages SET recovery_count = recovery_count + 1 WHERE id = ? RETURNING recovery_count")
    .get(messageId) as { recovery_count: number } | undefined;
  return row?.recovery_count ?? 0;
}

/** Get the most recent N messages for a group, oldest first. */
export function getRecentMessages(groupFolder: string, limit = 20): Message[] {
  const stmt = getDb().prepare(`
    SELECT id, group_folder, role, content, timestamp, processing_status, chat_id, sender_name
    FROM messages
    WHERE group_folder = ?
    ORDER BY timestamp DESC, id DESC
    LIMIT ?
  `);
  const rows = stmt.all(groupFolder, limit) as Message[];
  // Reverse so oldest is first (chronological order for the prompt)
  return rows.reverse();
}

/** Format messages into a string suitable for injection into the system prompt. */
export function formatHistory(messages: Message[]): string {
  if (messages.length === 0) return "";

  const lines = messages.map((m) => {
    const role = m.role === "user" ? "User" : "Assistant";
    return `[${m.timestamp}] ${role}: ${m.content}`;
  });

  return "# Recent Conversation History\n\n" + lines.join("\n\n");
}

// --- Scheduled Tasks ---

/** Insert a new scheduled task. Returns the new task ID. */
export function insertTask(
  groupFolder: string,
  chatId: string,
  prompt: string,
  scheduleType: "cron" | "interval" | "once",
  scheduleValue: string,
  nextRun: string,
  label?: string,
): number {
  const stmt = getDb().prepare(`
    INSERT INTO scheduled_tasks (group_folder, chat_id, prompt, schedule_type, schedule_value, next_run, label)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(groupFolder, chatId, prompt, scheduleType, scheduleValue, nextRun, label ?? null);
  return result.lastInsertRowid as number;
}

/** Get all active tasks whose next_run is at or before the given ISO timestamp. */
export function getDueTasks(now: string): ScheduledTask[] {
  const stmt = getDb().prepare(`
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run <= ?
    ORDER BY next_run ASC
  `);
  return stmt.all(now) as ScheduledTask[];
}

/** Get all tasks for a group (any status). */
export function getTasksByGroup(groupFolder: string): ScheduledTask[] {
  const stmt = getDb().prepare(`
    SELECT * FROM scheduled_tasks
    WHERE group_folder = ?
    ORDER BY created_at DESC
  `);
  return stmt.all(groupFolder) as ScheduledTask[];
}

/** Get a single task by ID (for authorization checks). */
export function getTaskById(taskId: number): ScheduledTask | undefined {
  const stmt = getDb().prepare("SELECT * FROM scheduled_tasks WHERE id = ?");
  return stmt.get(taskId) as ScheduledTask | undefined;
}

/** Update a task's status. */
export function updateTaskStatus(taskId: number, status: "active" | "paused" | "completed"): boolean {
  const stmt = getDb().prepare("UPDATE scheduled_tasks SET status = ? WHERE id = ?");
  return stmt.run(status, taskId).changes > 0;
}

/** Update a task's next_run time. */
export function updateTaskNextRun(taskId: number, nextRun: string): void {
  const stmt = getDb().prepare("UPDATE scheduled_tasks SET next_run = ? WHERE id = ?");
  stmt.run(nextRun, taskId);
}

/** Log a task run. */
export function insertTaskRunLog(
  taskId: number,
  durationMs: number | null,
  status: "success" | "error",
  result?: string,
  error?: string,
): void {
  const stmt = getDb().prepare(`
    INSERT INTO task_run_logs (task_id, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(taskId, durationMs, status, result ?? null, error ?? null);
}
