#!/usr/bin/env node

// Main orchestrator entrypoint — connects Telegram channel, routes messages
// through the per-group queue, starts IPC polling, and handles graceful shutdown.
// Usage: npx tsx src/index.ts (reads TELEGRAM_BOT_TOKEN from .env)

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TelegramChannel } from "./channels/telegram.js";
import { getSecrets, AuthUnavailableError } from "./auth.js";
import { enforceStartupBackoff } from "./circuit-breaker.js";
import {
  initializeIpcLayoutEpoch,
  insertMessage,
  getOrphanedMessages,
  getStuckProcessingMessages,
  incrementRecoveryCount,
  inspectDbAttestation,
  IPC_LAYOUT_DB_VERSION,
  updateMessageStatus,
  type DbAttestation,
  type Message,
} from "./db.js";
import { enqueue, shutdown as shutdownQueue } from "./group-queue.js";
import { registerSender } from "./ipc.js";
import {
  quarantineLooseRootRequests,
  startPolling,
  stopPolling,
} from "./ipc-poll.js";
import { startScheduler, stopScheduler } from "./task-scheduler.js";
import { chatIdToGroup, groupToChatId } from "./group-mapping.js";
import {
  ALLOWED_SENDER_IDS,
  IPC_DIR,
  IPC_LAYOUT_MARKER,
  MAIN_CHAT_ID,
  SHUTDOWN_TIMEOUT_MS,
  MCP_SERVERS_PATH,
  STUCK_SWEEP_MS,
  STUCK_THRESHOLD_SEC,
  MAX_RECOVERY_ATTEMPTS,
} from "./config.js";
import {
  assertDestinationAllowed,
  isValidMainChatId,
} from "./ipc-auth.js";
import type { Channel } from "./channels/registry.js";
import type { McpServerConfig } from "./types.js";

const CUTOVER_INSTRUCTION = "run deploy/cutover-m12-p1.sh before starting KuchiClaw";

export interface StartupGateOptions {
  mainChatId?: string;
  allowedSenderIds?: string[];
  ipcDir?: string;
  markerPath?: string;
  inspectDb?: () => DbAttestation;
  initializeEpoch?: () => void;
  /** Tests skip the crash-loop backoff (which would otherwise read/write real breaker state). */
  skipBackoff?: boolean;
  /** Override the breaker state-file path so tests never touch the real data/ file. */
  cbPath?: string;
}

/** Validate both cutover factors before any orchestrator side effect. */
export function enforceStartupGate(options: StartupGateOptions = {}): void {
  const mainChatId = options.mainChatId ?? MAIN_CHAT_ID;
  const allowedSenderIds = options.allowedSenderIds ?? ALLOWED_SENDER_IDS;
  const ipcDir = options.ipcDir ?? IPC_DIR;
  const markerPath = options.markerPath ?? IPC_LAYOUT_MARKER;
  const inspectDb = options.inspectDb ?? inspectDbAttestation;
  const initializeEpoch = options.initializeEpoch ?? initializeIpcLayoutEpoch;

  if (mainChatId && !isValidMainChatId(mainChatId)) {
    throw new Error(`Invalid MAIN_CHAT_ID "${mainChatId}"; expected tg-<canonicalChatId>`);
  }

  const markerPresent = hasValidMarker(markerPath);
  const dbState = inspectDb();
  if (markerPresent) {
    if (!dbState.exists || dbState.userVersion !== IPC_LAYOUT_DB_VERSION) {
      throw new Error(`IPC cutover attestation mismatch; ${CUTOVER_INSTRUCTION}`);
    }
  } else {
    if (dbState.exists || !isAbsent(ipcDir)) {
      throw new Error(`IPC cutover attestation missing; ${CUTOVER_INSTRUCTION}`);
    }
    initializeEpoch();
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    const fd = fs.openSync(
      markerPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.closeSync(fd);
  }

  if (allowedSenderIds.length === 0) {
    console.warn(
      "[SECURITY] WARNING: ALLOWED_SENDER_IDS is empty; any Telegram user who can reach the bot is allowed.",
    );
  }
}

function hasValidMarker(markerPath: string): boolean {
  try {
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Invalid IPC layout marker; ${CUTOVER_INSTRUCTION}`);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function isAbsent(targetPath: string): boolean {
  try {
    fs.lstatSync(targetPath);
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
}

/** Load MCP server configs from mcp-servers.json (if it exists) */
function loadMcpServers(): Record<string, McpServerConfig> | undefined {
  if (!fs.existsSync(MCP_SERVERS_PATH)) return undefined;
  try {
    const raw = fs.readFileSync(MCP_SERVERS_PATH, "utf-8");
    const servers = JSON.parse(raw) as Record<string, McpServerConfig>;
    const count = Object.keys(servers).length;
    if (count > 0) {
      console.log(`[Orchestrator] Loaded ${count} MCP server(s) from mcp-servers.json`);
      return servers;
    }
  } catch (err) {
    console.warn(`[Orchestrator] Failed to load mcp-servers.json: ${err}`);
  }
  return undefined;
}

export async function main(startupOptions: StartupGateOptions = {}): Promise<void> {
  // Back off inside the process when crash-looping, so systemd's StartLimit
  // never trips the unit into a permanent `failed` state. First thing we do —
  // it only touches its own state file. Skippable in tests via startupOptions.
  if (startupOptions.skipBackoff !== true) {
    await enforceStartupBackoff(startupOptions.cbPath ? { cbPath: startupOptions.cbPath } : {});
  }

  enforceStartupGate(startupOptions);
  quarantineLooseRootRequests();

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error("Error: TELEGRAM_BOT_TOKEN environment variable is required.");
    process.exit(1);
  }

  const { secrets, isApiKeyFallback } = await getSecrets();
  const mcpServers = loadMcpServers();
  // Use cheaper model when paying per-token via API key
  const model = isApiKeyFallback ? "claude-sonnet-4-6" : undefined;
  const channel = new TelegramChannel(botToken);

  // Register the channel's sendMessage for IPC to use
  registerSender((chatId, text) => channel.sendMessage(chatId, text));

  const knownGroups = new Set<string>();

  channel.onMessage((msg) => {
    const group = chatIdToGroup("tg", msg.chatId);
    try {
      assertDestinationAllowed(group, group === "main", msg.chatId);
    } catch (err) {
      console.error(`[Orchestrator] Refusing message with invalid identity: ${err}`);
      return;
    }

    // Log first message from a new group
    if (!knownGroups.has(group)) {
      knownGroups.add(group);
      console.log(`[Orchestrator] New group: ${group} (chat ${msg.chatId})`);
    }

    // Store user message immediately (before queuing) — starts as "pending"
    const messageId = insertMessage(group, "user", `[${msg.senderName}] ${msg.text}`, {
      chatId: msg.chatId,
      senderName: msg.senderName,
    });

    console.log(`[Orchestrator] ${msg.senderName} (group: ${group}): "${msg.text.slice(0, 80)}${msg.text.length > 80 ? "..." : ""}"`);

    // Send typing indicator while message waits in queue / runs
    channel.sendTyping(msg.chatId).catch(() => {});

    enqueue({
      group,
      chatId: msg.chatId,
      senderName: msg.senderName,
      text: msg.text,
      secrets,
      channel,
      mcpServers,
      model,
      attempt: 1,
      messageId,
    });
  });

  recoverOrphanedMessages({ secrets, channel, mcpServers, model });

  await channel.connect();
  startPolling();
  startScheduler({ secrets, channel, mcpServers, model });
  startStuckSweep({ secrets, channel, mcpServers, model });
  console.log("[Orchestrator] KuchiClaw is running. Press Ctrl+C to stop.");

  // Graceful shutdown: stop accepting → stop IPC → wait for running containers → exit
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // Prevent double-shutdown from rapid signals
    shuttingDown = true;
    console.log("\n[Orchestrator] Shutting down...");

    // Stop receiving new messages, IPC polling, scheduler, and the stuck sweep
    await channel.disconnect();
    stopPolling();
    stopScheduler();
    stopStuckSweep();

    // Wait for running containers to finish, with a hard timeout
    const finished = shutdownQueue();
    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        console.warn(`[Orchestrator] Shutdown timeout (${SHUTDOWN_TIMEOUT_MS}ms) — forcing exit`);
        resolve();
      }, SHUTDOWN_TIMEOUT_MS),
    );

    await Promise.race([finished, timeout]);
    // No breaker reset here: the breaker's start-ledger is time-pruned to the same
    // window systemd counts over, so a clean restart stays in sync with systemd
    // instead of desyncing it (a reset would let systemd trip on the next crash).
    console.log("[Orchestrator] Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Keep the long-running orchestrator alive through stray async failures.
 * - unhandledRejection is almost always a detached fire-and-forget promise
 *   (e.g. a Telegram send/typing call) — log loudly and carry on; crashing the
 *   whole process over one dropped reply is the audited crash-loop bug.
 * - uncaughtException leaves the process in an undefined state, so log and let
 *   systemd restart it — the circuit breaker prevents a tight restart loop.
 */
export function installProcessGuards(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("[Orchestrator] Unhandled promise rejection (continuing):", reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[Orchestrator] Uncaught exception — exiting for a clean restart:", err);
    process.exit(1);
  });
}

interface RecoveryOptions {
  secrets: Record<string, string>;
  channel: Channel;
  mcpServers?: Record<string, McpServerConfig>;
  model?: string;
}

/**
 * Re-enqueue one orphaned/stuck message, applying the replay cap. A message that
 * has already been recovered MAX_RECOVERY_ATTEMPTS times is failed permanently
 * instead of re-enqueued, so one that reliably crashes the container (or has an
 * unresolvable destination) can't replay forever across restarts and sweeps.
 * Returns true if it was re-enqueued.
 */
function reEnqueueOrphan(msg: Message, options: RecoveryOptions, source: string): boolean {
  const chatId = msg.chat_id ?? groupToChatId(msg.group_folder);
  try {
    if (!chatId) throw new Error("chat ID cannot be resolved");
    assertDestinationAllowed(msg.group_folder, msg.group_folder === "main", chatId);
  } catch (err) {
    console.error(`[${source}] REFUSING message ${msg.id} with invalid destination identity: ${err}`);
    updateMessageStatus(msg.id, "failed");
    return false;
  }

  if (msg.recovery_count >= MAX_RECOVERY_ATTEMPTS) {
    console.error(`[${source}] Message ${msg.id} exhausted ${MAX_RECOVERY_ATTEMPTS} recovery attempts — failing permanently`);
    updateMessageStatus(msg.id, "failed");
    return false;
  }

  const attempt = incrementRecoveryCount(msg.id);
  console.log(`[${source}] Re-enqueueing message ${msg.id} (group: ${msg.group_folder}, recovery ${attempt}/${MAX_RECOVERY_ATTEMPTS})`);
  updateMessageStatus(msg.id, "pending");
  enqueue({
    group: msg.group_folder,
    chatId: chatId!,
    senderName: msg.sender_name ?? "Unknown",
    text: msg.content,
    secrets: options.secrets,
    channel: options.channel,
    mcpServers: options.mcpServers,
    model: options.model,
    attempt: 1,
    messageId: msg.id,
  });
  return true;
}

export function recoverOrphanedMessages(options: RecoveryOptions): void {
  const orphans = getOrphanedMessages();
  if (orphans.length > 0) {
    console.log(`[Recovery] Found ${orphans.length} orphaned message(s) — re-enqueueing`);
    for (const msg of orphans) reEnqueueOrphan(msg, options, "Recovery");
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Periodic sweep for messages stranded in 'processing' while the orchestrator is
 * live (e.g. a container was killed but its status never reset, or a post-run DB
 * throw left it half-done). Startup recovery only runs once; this catches strays
 * that appear during a long-running session.
 */
export function startStuckSweep(options: RecoveryOptions): void {
  const sweep = () => {
    const stuck = getStuckProcessingMessages(STUCK_THRESHOLD_SEC);
    if (stuck.length > 0) {
      console.log(`[Sweep] Found ${stuck.length} stuck 'processing' message(s)`);
      for (const msg of stuck) reEnqueueOrphan(msg, options, "Sweep");
    }
  };
  sweepTimer = setInterval(sweep, STUCK_SWEEP_MS);
}

export function stopStuckSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installProcessGuards();
  main().catch((err) => {
    console.error(`[Orchestrator] Startup failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
