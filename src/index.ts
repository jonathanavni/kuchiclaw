#!/usr/bin/env node

// Main orchestrator entrypoint — connects Telegram channel, routes messages
// through the per-group queue, starts IPC polling, and handles graceful shutdown.
// Usage: npx tsx src/index.ts (reads TELEGRAM_BOT_TOKEN from .env)

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TelegramChannel } from "./channels/telegram.js";
import { getSecrets } from "./auth.js";
import {
  initializeIpcLayoutEpoch,
  insertMessage,
  getOrphanedMessages,
  inspectDbAttestation,
  IPC_LAYOUT_DB_VERSION,
  updateMessageStatus,
  type DbAttestation,
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
  console.log("[Orchestrator] KuchiClaw is running. Press Ctrl+C to stop.");

  // Graceful shutdown: stop accepting → stop IPC → wait for running containers → exit
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // Prevent double-shutdown from rapid signals
    shuttingDown = true;
    console.log("\n[Orchestrator] Shutting down...");

    // Stop receiving new messages, IPC polling, and scheduler
    await channel.disconnect();
    stopPolling();
    stopScheduler();

    // Wait for running containers to finish, with a hard timeout
    const finished = shutdownQueue();
    const timeout = new Promise<void>((resolve) =>
      setTimeout(() => {
        console.warn(`[Orchestrator] Shutdown timeout (${SHUTDOWN_TIMEOUT_MS}ms) — forcing exit`);
        resolve();
      }, SHUTDOWN_TIMEOUT_MS),
    );

    await Promise.race([finished, timeout]);
    console.log("[Orchestrator] Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

interface RecoveryOptions {
  secrets: Record<string, string>;
  channel: Channel;
  mcpServers?: Record<string, McpServerConfig>;
  model?: string;
}

export function recoverOrphanedMessages(options: RecoveryOptions): void {
  const orphans = getOrphanedMessages();
  if (orphans.length > 0) {
    console.log(`[Recovery] Found ${orphans.length} orphaned message(s) — re-enqueueing`);
    for (const msg of orphans) {
      const chatId = msg.chat_id ?? groupToChatId(msg.group_folder);
      try {
        if (!chatId) throw new Error("chat ID cannot be resolved");
        assertDestinationAllowed(
          msg.group_folder,
          msg.group_folder === "main",
          chatId,
        );
      } catch (err) {
        console.error(
          `[Recovery] REFUSING message ${msg.id} with invalid destination identity: ${err}`,
        );
        updateMessageStatus(msg.id, "failed");
        continue;
      }
      console.log(`[Recovery] Re-enqueueing message ${msg.id} (group: ${msg.group_folder}): "${msg.content.slice(0, 60)}..."`);
      updateMessageStatus(msg.id, "pending");
      enqueue({
        group: msg.group_folder,
        chatId,
        senderName: msg.sender_name ?? "Unknown",
        text: msg.content,
        secrets: options.secrets,
        channel: options.channel,
        mcpServers: options.mcpServers,
        model: options.model,
        attempt: 1,
        messageId: msg.id,
      });
    }
  }

}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[Orchestrator] Startup failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
