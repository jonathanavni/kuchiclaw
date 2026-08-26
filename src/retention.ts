// Retention (M12 P7): the growth surfaces with no readers past a horizon —
// terminal message rows, task_run_logs, and data/ipc-errors/ quarantine files —
// get age-pruned. Non-terminal (pending/processing) message rows are NEVER
// age-pruned: they are recovery/sweep inventory. The one exception path,
// failStrandedPending, runs ONLY at startup before intake (post-recovery, queue
// provably empty), because at runtime a pending row of any age can be a live
// deep-backlog job still waiting in the in-memory queue.

import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db.js";
import {
  IPC_ERRORS_DIR,
  IPC_ERRORS_RETENTION_DAYS,
  MESSAGES_KEEP_NEWEST,
  MESSAGES_RETENTION_DAYS,
  RETENTION_SWEEP_MS,
  STRANDED_PENDING_MAX_AGE_SEC,
  TASK_RUN_LOGS_RETENTION_DAYS,
} from "./config.js";

/** Terminalize user messages stranded in 'pending' past the recovery ceiling.
 *  STARTUP-ONLY (pre-intake): see the module comment. Returns rows updated. */
export function failStrandedPending(maxAgeSec: number = STRANDED_PENDING_MAX_AGE_SEC): number {
  const result = getDb().prepare(`
    UPDATE messages SET processing_status = 'failed'
    WHERE role = 'user'
      AND processing_status = 'pending'
      AND timestamp < datetime('now', '-' || ? || ' seconds')
  `).run(maxAgeSec);
  return result.changes;
}

/** Delete terminal (done/failed) messages older than `days`, always keeping the
 *  newest `keepNewestPerGroup` rows of each group regardless of age. */
export function pruneMessages(
  days: number = MESSAGES_RETENTION_DAYS,
  keepNewestPerGroup: number = MESSAGES_KEEP_NEWEST,
): number {
  if (days <= 0) return 0;
  const result = getDb().prepare(`
    DELETE FROM messages WHERE id IN (
      SELECT id FROM (
        SELECT id, processing_status, timestamp,
               ROW_NUMBER() OVER (
                 PARTITION BY group_folder ORDER BY timestamp DESC, id DESC
               ) AS newest_rank
        FROM messages
      )
      WHERE newest_rank > ?
        AND processing_status IN ('done', 'failed')
        AND timestamp < datetime('now', '-' || ? || ' days')
    )
  `).run(keepNewestPerGroup, days);
  return result.changes;
}

/** Delete task run logs older than `days`. */
export function pruneTaskRunLogs(days: number = TASK_RUN_LOGS_RETENTION_DAYS): number {
  if (days <= 0) return 0;
  const result = getDb().prepare(
    "DELETE FROM task_run_logs WHERE run_at < datetime('now', '-' || ? || ' days')",
  ).run(days);
  return result.changes;
}

/** Delete quarantined IPC request files older than `days` (host-written names;
 *  mtime is host-controlled — the quarantine dir is never container-mounted). */
export function pruneIpcErrors(
  days: number = IPC_ERRORS_RETENTION_DAYS,
  dir: string = IPC_ERRORS_DIR,
): number {
  if (days <= 0) return 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  const cutoffMs = Date.now() - days * 24 * 60 * 60_000;
  let removed = 0;
  for (const name of entries) {
    const filePath = path.join(dir, name);
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isFile() && stat.mtimeMs < cutoffMs) {
        fs.unlinkSync(filePath);
        removed++;
      }
    } catch {
      // A concurrently-removed or unreadable entry is not this sweep's problem.
    }
  }
  return removed;
}

function runPrunes(): void {
  try {
    const messages = pruneMessages();
    const runLogs = pruneTaskRunLogs();
    const ipcErrors = pruneIpcErrors();
    if (messages || runLogs || ipcErrors) {
      console.log(`[Prune] Removed ${messages} messages, ${runLogs} task run logs, ${ipcErrors} quarantined IPC files`);
    }
  } catch (err) {
    // Growth control must never take the orchestrator down.
    console.error(`[Prune] Sweep failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Startup pass: terminalize ownerless pending rows (safe only here), then prune.
 *  Call AFTER recoverOrphanedMessages() and BEFORE channel connect/intake. */
export function runStartupRetention(): void {
  try {
    const stranded = failStrandedPending();
    if (stranded > 0) {
      console.warn(`[Prune] Failed ${stranded} pending message(s) older than the recovery ceiling (never picked up)`);
    }
  } catch (err) {
    console.error(`[Prune] Stranded-pending pass failed: ${err instanceof Error ? err.message : err}`);
  }
  runPrunes();
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Daily runtime sweep: age-pruning of terminal rows/files only. */
export function startRetentionSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(runPrunes, RETENTION_SWEEP_MS);
  console.log(`[Prune] Retention sweep every ${RETENTION_SWEEP_MS / 3_600_000}h`);
}

export function stopRetentionSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
