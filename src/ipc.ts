import { CronExpressionParser } from "cron-parser";
import { AGENT_TIMEZONE } from "./config.js";
import { assertDestinationAllowed } from "./ipc-auth.js";
import { getTaskById, getTasksByGroup, insertTask, updateTaskStatus } from "./db.js";
import type { IpcRequest } from "./types.js";

type Sender = (chatId: string, text: string) => Promise<void>;

let sendMessage: Sender | null = null;

export function registerSender(fn: Sender): void {
  sendMessage = fn;
}

/** Execute using namespace-derived identity; payload group is diagnostic only. */
export async function execute(
  request: IpcRequest,
  sourceGroup: string,
  isMain: boolean,
): Promise<void> {
  if (!request.op || !request.chatId) {
    throw new Error("Invalid IPC request: missing required fields (op, chatId)");
  }
  assertDestinationAllowed(sourceGroup, isMain, request.chatId);
  if (request.group && request.group !== sourceGroup) {
    console.warn(
      `[IPC] Payload group mismatch from "${sourceGroup}": claimed "${request.group}"`,
    );
  }

  switch (request.op) {
    case "message":
      if (!request.text) throw new Error("IPC message op requires 'text' field");
      if (!sendMessage) throw new Error("No message sender registered — is a channel connected?");
      await sendMessage(request.chatId, request.text);
      return;
    case "task_create":
      await handleTaskCreate(request, sourceGroup);
      return;
    case "task_pause":
    case "task_resume":
    case "task_cancel":
      await handleTaskStatusChange(request, sourceGroup, isMain);
      return;
    case "task_list":
      await handleTaskList(request, sourceGroup);
      return;
    default:
      throw new Error(`Unknown IPC operation: ${request.op}`);
  }
}

async function handleTaskCreate(req: IpcRequest, sourceGroup: string): Promise<void> {
  if (!req.prompt || !req.scheduleType || !req.scheduleValue) {
    throw new Error("task_create requires prompt, scheduleType, and scheduleValue");
  }

  let nextRun: string;
  if (req.scheduleType === "cron") {
    nextRun = CronExpressionParser.parse(req.scheduleValue, { tz: AGENT_TIMEZONE })
      .next().toDate().toISOString();
  } else if (req.scheduleType === "interval") {
    const ms = Number(req.scheduleValue);
    if (!Number.isInteger(ms) || ms <= 0) throw new Error(`Invalid interval: ${req.scheduleValue}`);
    nextRun = new Date(Date.now() + ms).toISOString();
  } else {
    const date = new Date(req.scheduleValue);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${req.scheduleValue}`);
    nextRun = date.toISOString();
  }

  const taskId = insertTask(
    sourceGroup,
    req.chatId,
    req.prompt,
    req.scheduleType,
    req.scheduleValue,
    nextRun,
    req.label,
  );
  const label = req.label ? ` "${req.label}"` : "";
  const message = `Task ${taskId}${label} created (${req.scheduleType}). Next run: ${nextRun}`;
  if (sendMessage) await sendMessage(req.chatId, message);
}

async function handleTaskStatusChange(
  req: IpcRequest,
  sourceGroup: string,
  isMain: boolean,
): Promise<void> {
  if (!req.taskId) throw new Error(`${req.op} requires 'taskId'`);
  const task = getTaskById(req.taskId);
  if (task && !isMain && task.group_folder !== sourceGroup) {
    throw new Error(`Authorization denied: group "${sourceGroup}" cannot modify task ${req.taskId}`);
  }
  const statuses = {
    task_pause: "paused",
    task_resume: "active",
    task_cancel: "completed",
  } as const;
  const status = statuses[req.op as keyof typeof statuses];
  if (!updateTaskStatus(req.taskId, status)) throw new Error(`Task ${req.taskId} not found`);
  if (sendMessage) await sendMessage(req.chatId, `Task ${req.taskId} → ${status}`);
}

async function handleTaskList(req: IpcRequest, sourceGroup: string): Promise<void> {
  const tasks = getTasksByGroup(sourceGroup);
  const message = tasks.length === 0
    ? "No scheduled tasks."
    : `Scheduled tasks:\n${tasks.map((task) => {
      const label = task.label ? ` "${task.label}"` : "";
      return `#${task.id}${label} [${task.status}] ${task.schedule_type}(${task.schedule_value}) next: ${task.next_run}`;
    }).join("\n")}`;
  if (sendMessage) await sendMessage(req.chatId, message);
}
