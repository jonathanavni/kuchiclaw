// Per-group FIFO queue with concurrency control.
// Each group can run up to MAX_CONTAINERS_PER_GROUP containers simultaneously.
// Jobs within a group execute in FIFO order; across groups, concurrently.

import { runContainer, type ContainerLifecycle } from "./container-runner.js";
import { ContainerTerminationUnknownError, OutputVerificationError } from "./container-errors.js";
import { ensureGroupFolder } from "./group-folder.js";
import { getSecrets, getSkillSecrets } from "./auth.js";
import { getRefreshToken } from "./oauth-refresh.js";
import { insertMessage, getRecentMessages, formatHistory, updateMessageStatus } from "./db.js";
import {
  AGENT_TIMEZONE,
  MAX_CONTAINERS_PER_GROUP,
  MAX_RETRIES,
  BASE_RETRY_MS,
  DELIVERY_MAX_RETRIES,
  DELIVERY_BASE_MS,
  formatAgentTime,
  selectModels,
} from "./config.js";
import { assertDestinationAllowed } from "./ipc-auth.js";
import { AuthUnavailableError } from "./auth.js";
import type { ContainerInput, McpServerConfig } from "./types.js";
import { PermanentDeliveryError } from "./channels/registry.js";
import type { Channel } from "./channels/registry.js";

export interface Job {
  group: string;
  chatId: string;
  senderName: string;
  text: string;
  secrets: Record<string, string>;
  channel: Channel;
  mcpServers?: Record<string, McpServerConfig>;
  /** Per-job model override (reserved seam, e.g. scheduled tasks on sonnet).
   *  Ignored on the API-key path — executeJob downgrades unconditionally there. */
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

let lifecycle: ContainerLifecycle = { owner: "orchestrator" };

/** Configure the entrypoint-owned containment notification forwarded to each run. */
export function configureLifecycle(options: ContainerLifecycle): void {
  lifecycle = options;
}

/** Ref-count of live jobs handling each message — the stuck sweep skips these so
 *  it can't re-execute a message that's only slow (deep backlog), not stranded.
 *  A count (not a set) because a container-error retry briefly overlaps the
 *  outgoing job for the same message. */
const inFlightMessageIds = new Map<number, number>();

function addInFlight(id: number): void {
  inFlightMessageIds.set(id, (inFlightMessageIds.get(id) ?? 0) + 1);
}
function removeInFlight(id: number): void {
  const n = (inFlightMessageIds.get(id) ?? 1) - 1;
  if (n <= 0) inFlightMessageIds.delete(id);
  else inFlightMessageIds.set(id, n);
}

/** Is a live in-process job currently handling this message? (Used by the stuck sweep.) */
export function isMessageInFlight(messageId: number): boolean {
  return inFlightMessageIds.has(messageId);
}

let accepting = true;

/** Enqueue a job and immediately try to drain. */
export function enqueue(job: Job): void {
  if (!accepting) return;

  const group = job.group;
  if (!queues.has(group)) queues.set(group, []);
  queues.get(group)!.push(job);
  drain(group);
}

/** Reset module state for isolated tests only — shutdown() otherwise closes
 *  queue acceptance for every test that runs after it. */
export function resetQueueForTest(): void {
  accepting = true;
  queues.clear();
  running.clear();
  activeJobs.clear();
  inFlightMessageIds.clear();
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
  if (job.messageId !== undefined) addInFlight(job.messageId);

  const promise = executeJob(job)
    .catch((err) => {
      // executeJob handles its own failures; this is a last-resort backstop so an
      // unexpected throw can never surface as an unhandled rejection.
      console.error(`[Queue] Unexpected job failure: ${err instanceof Error ? err.message : err}`);
    })
    .finally(() => {
      activeJobs.delete(promise);
      if (job.messageId !== undefined) removeInFlight(job.messageId);
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
  let authSecrets: Record<string, string>;
  let isApiKeyFallback: boolean;
  let source: string;
  try {
    ({ secrets: authSecrets, isApiKeyFallback, source } = await getSecrets());
  } catch (err) {
    const message = err instanceof AuthUnavailableError ? err.message : String(err);
    console.error(`[Queue] Auth unavailable, failing job: ${message}`);
    if (job.messageId) updateMessageStatus(job.messageId, "failed");
    await deliver(channel, chatId, "I couldn't process that — authentication is temporarily unavailable.");
    job.onError?.(message);
    return;
  }

  const paths = ensureGroupFolder(group);
  // Model is decided here (not at startup) because auth is re-resolved per job.
  const { model, fallbackModel } = selectModels(isApiKeyFallback, job.model);

  // Load history before this run (user message already stored by caller)
  const recentMessages = getRecentMessages(group);
  const messageHistory = formatHistory(recentMessages);

  const input: ContainerInput = {
    prompt: text,
    groupFolder: group,
    chatId,
    secrets: { ...getSkillSecrets(group), ...authSecrets },
    // Refresh token lets the container self-heal when the access token is stale —
    // containers can reach platform.claude.com even when the VPS host is blocked.
    // Only on the oauth.json path: a container refresh overrides the access token
    // (entrypoint), so passing it alongside a dedicated env-token grant would let a
    // stale oauth.json lineage clobber the grant — the exact crash-loop P4.1 removes.
    refreshToken: source === "oauth-json" ? getRefreshToken() ?? undefined : undefined,
    messageHistory: messageHistory || undefined,
    currentTime: formatAgentTime(),
    timezone: AGENT_TIMEZONE,
    mcpServers: job.mcpServers,
    model,
    fallbackModel,
  };

  console.log(`[Queue] Running job for ${senderName} (group: ${group}, attempt: ${job.attempt}/${MAX_RETRIES})`);

  // The container run and the reply delivery are separate failure domains. A send
  // failure must never roll back or re-run the agent (duplicate work), so we only
  // retry the *container* here; delivery has its own bounded retry in deliver().
  let output;
  try {
    output = await runContainer(input, paths, lifecycle);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Queue] Container error (attempt ${job.attempt}/${MAX_RETRIES}): ${errMsg}`);

    // Unknown termination is process-level containment; retrying here could put a
    // second container onto rw mounts still held by the first.
    if (err instanceof ContainerTerminationUnknownError) {
      if (job.messageId) updateMessageStatus(job.messageId, "failed");
      await deliver(channel, chatId, `Container containment error: ${errMsg}`);
      job.onError?.(errMsg);
      return;
    }

    // The container ran but produced no verifiable result. Non-retryable: a
    // re-run would repeat any side effects the agent already performed (an IPC
    // send/task is executed by the host independently of the result), and only
    // a pre-start failure (spawn/stdin) is safe to retry.
    if (err instanceof OutputVerificationError) {
      if (job.messageId) updateMessageStatus(job.messageId, "failed");
      await deliver(channel, chatId, `Container produced no valid result: ${errMsg}`);
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

  // Container ran to completion. Persisting/delivering can still throw (e.g. a
  // SQLite error); catch it so it never becomes an unhandled rejection that the
  // process-level guard has to absorb. We deliberately do NOT touch message
  // status here — leaving a half-processed message as 'processing' lets crash
  // recovery replay it rather than silently dropping the reply.
  try {
    if (output.status === "success") {
      const result = output.result ?? "(no response)";
      // Persist the result BEFORE marking the user message done. If we marked done
      // first and crashed before the insert, recovery would skip a message that has
      // no stored reply (a silent drop). This order downgrades that to at worst a
      // re-run (duplicate reply) on crash — strictly safer.
      insertMessage(group, "assistant", result);
      if (job.messageId) updateMessageStatus(job.messageId, "done");
      await deliver(channel, chatId, result);
      job.onComplete?.(result);
    } else {
      // A verified error envelope may follow side effects, so every kind is terminal.
      if (job.messageId) updateMessageStatus(job.messageId, "failed");
      const errMsg = `Error: ${output.error ?? "unknown error"}`;
      const userMessage = output.errorKind === "auth"
        ? "I couldn't process that — the agent credentials need attention."
        : output.errorKind === "rate_limit"
          ? "I couldn't process that — the agent is rate limited. Please try again later."
          : errMsg;
      console.error(`[Queue] Agent ${output.errorKind ?? "unclassified"} error: ${errMsg}`);
      await deliver(channel, chatId, userMessage);
      job.onError?.(errMsg);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Queue] Post-run handling failed (result may be unstored/undelivered): ${errMsg}`);
    job.onError?.(errMsg);
  }
}

/**
 * Send a message with bounded exponential backoff. Never throws and never
 * re-runs the container — delivery is a separate failure domain from the agent
 * run, so a transient channel failure (e.g. Telegram 429) can't duplicate work.
 * The agent result is already persisted before this is called.
 *
 * Retry is not idempotent: a send that Telegram accepted but whose ack was lost
 * (network timeout after delivery) will be resent, so a rare duplicate message is
 * possible. Accepted — a duplicate reply beats a dropped one for this use case.
 */
async function deliver(channel: Channel, chatId: string, text: string): Promise<void> {
  for (let attempt = 1; attempt <= DELIVERY_MAX_RETRIES; attempt++) {
    try {
      await channel.sendMessage(chatId, text);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof PermanentDeliveryError) {
        // The channel already exhausted its own per-chunk handling and proved
        // the failure permanent — an outer retry would only duplicate the
        // chunks the platform already accepted.
        console.error(`[Queue] Delivery to ${chatId} failed permanently: ${msg}`);
        return;
      }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
