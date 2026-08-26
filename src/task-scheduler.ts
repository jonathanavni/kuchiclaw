// Task scheduler — polls SQLite every 60s for due tasks, enqueues them into
// GroupQueue (same execution path as Telegram messages). Supports cron, interval,
// and one-shot schedules. Interval tasks use drift prevention (advance from
// previous next_run, not Date.now()).

import { CronExpressionParser } from "cron-parser";
import { AGENT_TIMEZONE, SCHEDULER_POLL_MS } from "./config.js";
import { getDueTasks, updateTaskNextRun, updateTaskStatus, insertTaskRunLog } from "./db.js";
import { enqueue } from "./group-queue.js";
import { assertDestinationAllowed } from "./ipc-auth.js";
import type { Channel } from "./channels/registry.js";
import type { McpServerConfig, ScheduledTask } from "./types.js";

/** Dependencies injected by the orchestrator at startup */
interface SchedulerDeps {
  secrets: Record<string, string>;
  channel: Channel;
  mcpServers?: Record<string, McpServerConfig>;
  /** Deliberate reserve seam (no caller sets it today): running scheduled/
   *  heartbeat tasks on a cheaper model than interactive chat. Unset ⇒ the
   *  queue's AGENT_MODEL default applies. */
  model?: string;
  /** Injectable clock for tests (mirrors ipc-poll's `now` parameter). */
  now?: () => number;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let deps: SchedulerDeps | null = null;

/** Task IDs currently queued or running — prevents double-enqueue */
const inFlight = new Set<number>();

export function startScheduler(d: SchedulerDeps): void {
  deps = d;
  pollTimer = setInterval(poll, SCHEDULER_POLL_MS);
  console.log(`[Scheduler] Polling every ${SCHEDULER_POLL_MS / 1000}s`);
  // Run once immediately so tasks don't wait up to 60s on startup
  poll();
}

export function stopScheduler(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log("[Scheduler] Stopped");
  }
}

/** Mark a task as no longer in-flight (called by job completion callback) */
export function clearInFlight(taskId: number): void {
  inFlight.delete(taskId);
}

/** Clear all module state between tests (mirrors resetQueueForTest). */
export function resetSchedulerForTest(): void {
  stopScheduler();
  deps = null;
  inFlight.clear();
}

function poll(): void {
  if (!deps) return;

  const nowMs = (deps.now ?? Date.now)();
  const dueTasks = getDueTasks(new Date(nowMs).toISOString());

  for (const task of dueTasks) {
    try {
      assertDestinationAllowed(task.group_folder, task.group_folder === "main", task.chat_id);
    } catch (err) {
      console.error(
        `[Scheduler] REFUSING task ${task.id} with invalid destination identity: ${err}`,
      );
      updateTaskStatus(task.id, "paused");
      continue;
    }

    if (inFlight.has(task.id)) {
      console.log(`[Scheduler] Task ${task.id} (${task.label ?? "unlabeled"}) still in flight, skipping`);
      continue;
    }

    // Compute next_run before enqueuing (so the DB is updated even if the job
    // takes a while). A task whose schedule fails validation here is paused and
    // must NOT run — pre-P7 it fell through and ran once anyway.
    if (!advanceNextRun(task, nowMs)) continue;

    inFlight.add(task.id);
    const startTime = (deps.now ?? Date.now)();

    const taskLabel = task.label ?? `task-${task.id}`;
    console.log(`[Scheduler] Enqueuing task ${task.id} (${taskLabel})`);

    try {
      enqueue({
        group: task.group_folder,
        chatId: task.chat_id,
        senderName: `scheduler:${taskLabel}`,
        text: task.prompt,
        secrets: deps.secrets,
        channel: deps.channel,
        mcpServers: deps.mcpServers,
        model: deps.model,
        attempt: 1,
        // Callback fields for task tracking
        onComplete: (result) => {
          const durationMs = (deps?.now ?? Date.now)() - startTime;
          insertTaskRunLog(task.id, durationMs, "success", result);
          clearInFlight(task.id);
        },
        onError: (error) => {
          const durationMs = (deps?.now ?? Date.now)() - startTime;
          insertTaskRunLog(task.id, durationMs, "error", undefined, error);
          clearInFlight(task.id);
        },
      });
    } catch (err) {
      // One task's enqueue failure must not skip the rest of the due set.
      console.error(`[Scheduler] Failed to enqueue task ${task.id}: ${err}`);
      clearInFlight(task.id);
    }
  }
}

/**
 * Advance a task's next_run (or mark completed for one-shot). Returns true when
 * the task is eligible to run now; false when it was paused as invalid.
 *
 * The scheduler is at-most-once per occurrence: missed occurrences (downtime)
 * collapse into the single run that fires when the task is next seen due —
 * for cron by anchoring the parser at max(stored next_run, now), for interval
 * by the skip-forward loop. Pre-P7, cron advanced one occurrence per poll and
 * replayed every missed occurrence ~60s apart.
 */
export function advanceNextRun(task: ScheduledTask, nowMs: number = Date.now()): boolean {
  switch (task.schedule_type) {
    case "once":
      updateTaskStatus(task.id, "completed");
      return true;

    case "interval": {
      // Strict parse, matching creation-time validation in ipc.ts — parseInt
      // would accept rows like "5000abc" written by any non-IPC path.
      const ms = Number(task.schedule_value);
      if (!Number.isInteger(ms) || ms <= 0) {
        console.error(`[Scheduler] Invalid interval value for task ${task.id}: ${task.schedule_value}`);
        updateTaskStatus(task.id, "paused");
        return false;
      }
      // Drift prevention: advance from previous next_run, skip forward if behind
      const anchor = new Date(task.next_run).getTime();
      if (!Number.isFinite(anchor)) {
        console.error(`[Scheduler] Invalid next_run anchor for task ${task.id}: ${task.next_run}`);
        updateTaskStatus(task.id, "paused");
        return false;
      }
      let next = anchor + ms;
      while (next <= nowMs) next += ms;
      updateTaskNextRun(task.id, new Date(next).toISOString());
      return true;
    }

    case "cron": {
      try {
        // Anchor at max(stored next_run, now): on time this preserves drift
        // anchoring; after downtime it lands the follow-up strictly in the
        // future instead of replaying each missed occurrence.
        const anchorMs = Math.max(new Date(task.next_run).getTime(), nowMs);
        const expr = CronExpressionParser.parse(task.schedule_value, {
          currentDate: new Date(anchorMs),
          tz: AGENT_TIMEZONE,
        });
        updateTaskNextRun(task.id, expr.next().toDate().toISOString());
        return true;
      } catch (err) {
        console.error(`[Scheduler] Invalid cron expression for task ${task.id}: ${task.schedule_value}`, err);
        updateTaskStatus(task.id, "paused");
        return false;
      }
    }
  }
}
