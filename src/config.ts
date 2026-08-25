// Configuration constants for KuchiClaw

import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Project root directory */
export const PROJECT_ROOT = path.resolve(__dirname, "..");

/** Directory where group folders live */
export const GROUPS_DIR = path.join(PROJECT_ROOT, "groups");

/** Directory for persistent data (SQLite, IPC) */
export const DATA_DIR = path.join(PROJECT_ROOT, "data");

/** Docker image name for agent containers */
export const CONTAINER_IMAGE = "kuchiclaw-agent";

/** Sentinel markers for parsing container output */
export const OUTPUT_START_MARKER = "---KUCHICLAW_OUTPUT_START---";
export const OUTPUT_END_MARKER = "---KUCHICLAW_OUTPUT_END---";

/** Container timeout in milliseconds (5 minutes default) */
export const CONTAINER_TIMEOUT_MS = 5 * 60 * 1000;

/** Maximum time to wait for docker's attach client to flush after termination. */
export const TERMINATION_DRAIN_MS = 5 * 1000;

/** Container process ceiling. Empty or zero disables the Docker flag. */
const configuredPidsLimit = process.env.CONTAINER_PIDS_LIMIT;
export const CONTAINER_PIDS_LIMIT = configuredPidsLimit === "" || configuredPidsLimit === "0"
  ? undefined
  : configuredPidsLimit ?? "256";

/** Resource limits are opt-in because aggregate host budgeting is a separate concern. */
export const CONTAINER_MEMORY = process.env.CONTAINER_MEMORY?.trim() || undefined;
export const CONTAINER_CPUS = process.env.CONTAINER_CPUS?.trim() || undefined;

/** Max concurrent containers per group (per-group FIFO queue) */
export const MAX_CONTAINERS_PER_GROUP = 2;

/** Max retry attempts for failed container runs */
export const MAX_RETRIES = 3;

/** Base delay for exponential backoff on retries (ms). Delay = BASE_RETRY_MS * 2^(attempt-1) */
export const BASE_RETRY_MS = 2000;

/** Delivery (channel send) is retried independently of the container run, so a
 *  transient send failure (e.g. Telegram 429) never re-runs the agent. */
export const DELIVERY_MAX_RETRIES = 3;
export const DELIVERY_BASE_MS = 1000;

/** Hard timeout for graceful shutdown — kill remaining containers after this (ms) */
export const SHUTDOWN_TIMEOUT_MS = 60 * 1000;

/** Final bounded wait for close handlers after shutdown reaps live containers. */
export const SHUTDOWN_REAP_DRAIN_MS = 5 * 1000;

/** Kernel-owned orchestrator singleton backstop. */
export const INSTANCE_LOCK_PORT = Number.parseInt(process.env.INSTANCE_LOCK_PORT ?? "47671", 10);

/** Directory for IPC request files (containers write here, host polls) */
export const IPC_DIR = path.join(DATA_DIR, "ipc");

/** IPC polling interval (ms) */
export const IPC_POLL_MS = 1000;

/** Directory for failed IPC requests */
export const IPC_ERRORS_DIR = path.join(DATA_DIR, "ipc-errors");

/** Filesystem half of the IPC layout attestation; containers never mount this path. */
export const IPC_LAYOUT_MARKER = path.join(DATA_DIR, "ipc-layout-v2");

/** Maximum accepted IPC request size, excluding the one-byte overflow probe. */
export const MAX_REQUEST_BYTES = 64 * 1024;

/** Maximum directory entries considered per namespace during one poll cycle. */
export const MAX_REQUESTS_PER_NAMESPACE = 64;

/** Grace period for a writer to atomically finish and rename an IPC request. */
export const IPC_PARSE_GRACE_MS = 10_000;

/** Skills directory — CLI scripts/API wrappers mounted into containers */
export const SKILLS_DIR = path.join(PROJECT_ROOT, "skills");

/** MCP server config file */
export const MCP_SERVERS_PATH = path.join(PROJECT_ROOT, "mcp-servers.json");

/** Task scheduler polling interval (ms) */
export const SCHEDULER_POLL_MS = 60_000;

/** How often the runtime sweep looks for messages stranded in 'processing' (ms). */
export const STUCK_SWEEP_MS = 5 * 60_000;

/** A 'processing' message older than this (s) has no live job — the sweep re-enqueues it.
 *  Must exceed the container timeout by a comfortable margin so live jobs are never swept. */
export const STUCK_THRESHOLD_SEC = 15 * 60;

/** Max times a message may be re-enqueued by recovery/sweep before it's failed permanently. */
export const MAX_RECOVERY_ATTEMPTS = 3;

/** Channel-qualified chat ID that maps to the "main" group (e.g., "tg-123456789"). */
export const MAIN_CHAT_ID = process.env.MAIN_CHAT_ID ?? "";

/** Telegram user IDs allowed to interact with the bot. Empty = allow all. */
export const ALLOWED_SENDER_IDS: string[] = process.env.ALLOWED_SENDER_IDS
  ? process.env.ALLOWED_SENDER_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];
