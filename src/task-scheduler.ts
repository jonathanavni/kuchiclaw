// Task scheduler — polls SQLite every 60s for due tasks, enqueues them into
// GroupQueue (same execution path as Telegram messages). Supports cron, interval,
// and one-shot schedules. Interval tasks use drift prevention (advance from
// previous next_run, not Date.now()).

import { CronExpressionParser } from "cron-parser";
import { SCHEDULER_POLL_MS } from "./config.js";
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
  model?: string;
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

function poll(): void {
  if (!deps) return;

  const now = new Date().toISOString();
  const dueTasks = getDueTasks(now);

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

    inFlight.add(task.id);
    const startTime = Date.now();

    // Compute next_run before enqueuing (so the DB is updated even if the job takes a while)
    advanceNextRun(task);

    const taskLabel = task.label ?? `task-${task.id}`;
    console.log(`[Scheduler] Enqueuing task ${task.id} (${taskLabel})`);

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
        const durationMs = Date.now() - startTime;
        insertTaskRunLog(task.id, durationMs, "success", result);
        clearInFlight(task.id);
      },
      onError: (error) => {
        const durationMs = Date.now() - startTime;
        insertTaskRunLog(task.id, durationMs, "error", undefined, error);
        clearInFlight(task.id);
      },
    });
  }
}

/** Advance a task's next_run (or mark completed for one-shot). */
function advanceNextRun(task: ScheduledTask): void {
  switch (task.schedule_type) {
    case "once":
      updateTaskStatus(task.id, "completed");
      break;

    case "interval": {
      const ms = parseInt(task.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        console.error(`[Scheduler] Invalid interval value for task ${task.id}: ${task.schedule_value}`);
        updateTaskStatus(task.id, "paused");
        return;
      }
      // Drift prevention: advance from previous next_run, skip forward if behind
      const now = Date.now();
      let next = new Date(task.next_run).getTime() + ms;
      while (next <= now) next += ms;
      updateTaskNextRun(task.id, new Date(next).toISOString());
      break;
    }

    case "cron": {
      try {
        const expr = CronExpressionParser.parse(task.schedule_value, {
          currentDate: new Date(task.next_run),
          tz: "UTC",
        });
        const next = expr.next().toDate().toISOString();
        updateTaskNextRun(task.id, next);
      } catch (err) {
        console.error(`[Scheduler] Invalid cron expression for task ${task.id}: ${task.schedule_value}`, err);
        updateTaskStatus(task.id, "paused");
      }
      break;
    }
  }
}
