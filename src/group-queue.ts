// Per-group FIFO queue with concurrency control.
// Each group can run up to MAX_CONTAINERS_PER_GROUP containers simultaneously.
// Jobs within a group execute in FIFO order; across groups, concurrently.

import { runContainer } from "./container-runner.js";
import { ensureGroupFolder } from "./group-folder.js";
import { getSecrets } from "./auth.js";
import { getRefreshToken } from "./oauth-refresh.js";
import { insertMessage, getRecentMessages, formatHistory, updateMessageStatus } from "./db.js";
import {
  MAX_CONTAINERS_PER_GROUP,
  MAX_RETRIES,
  BASE_RETRY_MS,
  DELIVERY_MAX_RETRIES,
  DELIVERY_BASE_MS,
} from "./config.js";
import { assertDestinationAllowed } from "./ipc-auth.js";
import { AuthUnavailableError } from "./auth.js";
import type { ContainerInput, McpServerConfig } from "./types.js";
import type { Channel } from "./channels/registry.js";

export interface Job {
  group: string;
  chatId: string;
  senderName: string;
  text: string;
  secrets: Record<string, string>;
  channel: Channel;
  mcpServers?: Record<string, McpServerConfig>;
  /** Model override (e.g., cheaper model for API key fallback) */
  model?: string;
  attempt: number;
  /** Row ID in messages table — used for processing_status updates */
  messageId?: number;
  /** Called with agent result on success (used by scheduler for run logging) */
  onComplete?: (result: string) => void;
  /** Called with error message on final failure (used by scheduler for run logging) */
  onError?: (error: string) => void;
}

/** Tracks per-group queues and running counts */
const queues = new Map<string, Job[]>();
const running = new Map<string, number>();

/** All currently running job promises — used for graceful shutdown */
const activeJobs = new Set<Promise<void>>();

let accepting = true;

/** Enqueue a job and immediately try to drain. */
export function enqueue(job: Job): void {
  if (!accepting) return;

  const group = job.group;
  if (!queues.has(group)) queues.set(group, []);
  queues.get(group)!.push(job);
  drain(group);
}

/** Stop accepting new jobs. Returns a promise that resolves when all running jobs finish. */
export function shutdown(): Promise<void> {
  accepting = false;
  // Clear all pending queues — only wait for running jobs
  queues.clear();
  if (activeJobs.size === 0) return Promise.resolve();
  return Promise.all(activeJobs).then(() => {});
}

/**
 * Drain the queue for a group: start jobs up to the per-group concurrency cap.
 * Called after enqueue and after a job completes.
 */
function drain(group: string): void {
  const queue = queues.get(group);
  if (!queue || queue.length === 0) return;

  const count = running.get(group) ?? 0;
  if (count >= MAX_CONTAINERS_PER_GROUP) return;

  const job = queue.shift()!;
  running.set(group, count + 1);

  const promise = executeJob(job).finally(() => {
    activeJobs.delete(promise);
    running.set(group, (running.get(group) ?? 1) - 1);
    drain(group);
  });

  activeJobs.add(promise);
}

/** Execute a single job: run container, store result, send response. Retry on failure. */
async function executeJob(job: Job): Promise<void> {
  const { group, chatId, senderName, text, channel } = job;

  try {
    assertDestinationAllowed(group, group === "main", chatId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Queue] Invalid job identity: ${message}`);
    if (job.messageId) updateMessageStatus(job.messageId, "failed");
    job.onError?.(message);
    return;
  }

  if (job.messageId) updateMessageStatus(job.messageId, "processing");

  // Refresh auth on every job — tokens expire and the process is long-lived.
  // A missing credential is transient on the VPS (blocked refresh, stale token),
  // so fail THIS job — never take the whole orchestrator down (getSecrets throws
  // instead of process.exit now). No retry: retrying an auth gap just spins.
  let secrets: Record<string, string>;
  let isApiKeyFallback: boolean;
  let source: string;
  try {
    ({ secrets, isApiKeyFallback, source } = await getSecrets());
  } catch (err) {
    const message = err instanceof AuthUnavailableError ? err.message : String(err);
    console.error(`[Queue] Auth unavailable, failing job: ${message}`);
    if (job.messageId) updateMessageStatus(job.messageId, "failed");
    await deliver(channel, chatId, "I couldn't process that — authentication is temporarily unavailable.");
    job.onError?.(message);
    return;
  }

  const paths = ensureGroupFolder(group);
  const model = isApiKeyFallback ? "claude-sonnet-4-6" : job.model;

  // Load history before this run (user message already stored by caller)
  const recentMessages = getRecentMessages(group);
  const messageHistory = formatHistory(recentMessages);

  const input: ContainerInput = {
    prompt: text,
    groupFolder: group,
    chatId,
    secrets,
    // Refresh token lets the container self-heal when the access token is stale —
    // containers can reach platform.claude.com even when the VPS host is blocked.
    // Only on the oauth.json path: a container refresh overrides the access token
    // (entrypoint), so passing it alongside a dedicated env-token grant would let a
    // stale oauth.json lineage clobber the grant — the exact crash-loop P4.1 removes.
    refreshToken: source === "oauth-json" ? getRefreshToken() ?? undefined : undefined,
    messageHistory: messageHistory || undefined,
    mcpServers: job.mcpServers,
    model,
  };

  console.log(`[Queue] Running job for ${senderName} (group: ${group}, attempt: ${job.attempt}/${MAX_RETRIES})`);

  // The container run and the reply delivery are separate failure domains. A send
  // failure must never roll back or re-run the agent (duplicate work), so we only
  // retry the *container* here; delivery has its own bounded retry in deliver().
  let output;
  try {
    output = await runContainer(input, paths);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Queue] Container error (attempt ${job.attempt}/${MAX_RETRIES}): ${errMsg}`);

    // Don't retry auth failures — they won't fix themselves on a retry.
    if (isAuthError(errMsg)) {
      if (job.messageId) updateMessageStatus(job.messageId, "failed");
      await deliver(channel, chatId, `Authentication error: ${errMsg}`);
      job.onError?.(errMsg);
      return;
    }

    if (job.attempt < MAX_RETRIES) {
      const delay = BASE_RETRY_MS * Math.pow(2, job.attempt - 1);
      console.log(`[Queue] Retrying in ${delay}ms...`);
      await sleep(delay);
      enqueue({ ...job, attempt: job.attempt + 1 });
    } else {
      if (job.messageId) updateMessageStatus(job.messageId, "failed");
      await deliver(channel, chatId, `Failed after ${MAX_RETRIES} attempts: ${errMsg}`);
      job.onError?.(errMsg);
    }
    return;
  }

  // Container ran to completion — persist the result FIRST, then deliver. If
  // delivery fails, the result is already stored and onComplete still fires.
  if (output.status === "success") {
    const result = output.result ?? "(no response)";
    if (job.messageId) updateMessageStatus(job.messageId, "done");
    insertMessage(group, "assistant", result);
    await deliver(channel, chatId, result);
    job.onComplete?.(result);
  } else {
    // Agent-level error (not a container crash) — don't retry
    if (job.messageId) updateMessageStatus(job.messageId, "failed");
    const errMsg = `Error: ${output.error ?? "unknown error"}`;
    console.error(`[Queue] Agent error: ${errMsg}`);
    await deliver(channel, chatId, errMsg);
    job.onError?.(errMsg);
  }
}

/**
 * Send a message with bounded exponential backoff. Never throws and never
 * re-runs the container — delivery is a separate failure domain from the agent
 * run, so a transient channel failure (e.g. Telegram 429) can't duplicate work.
 * The agent result is already persisted before this is called.
 */
async function deliver(channel: Channel, chatId: string, text: string): Promise<void> {
  for (let attempt = 1; attempt <= DELIVERY_MAX_RETRIES; attempt++) {
    try {
      await channel.sendMessage(chatId, text);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt >= DELIVERY_MAX_RETRIES) {
        console.error(`[Queue] Delivery to ${chatId} failed after ${DELIVERY_MAX_RETRIES} attempts: ${msg}`);
        return; // Give up — result is persisted; do not rethrow (would reject the job promise).
      }
      const delay = DELIVERY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`[Queue] Delivery attempt ${attempt} to ${chatId} failed (${msg}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

function isAuthError(msg: string): boolean {
  const patterns = ["oauth", "unauthorized", "401", "auth", "token expired", "invalid token"];
  const lower = msg.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
