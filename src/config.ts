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
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE?.trim() || "kuchiclaw-agent";

/** Container result transport: the agent's output is written to an HMAC-signed
 *  file on a per-run rw mount, not stdout — a prompt-injected agent shares the
 *  entrypoint's uid and could otherwise forge the whole ContainerOutput
 *  (including newTokens) by writing the process's stdout fd. Keep these in sync
 *  with the container-side copies in container/prepare.ts (a parity test pins it). */
export const RESULT_FILENAME = "result.json";
export const RESULT_TMP_FILENAME = "result.json.tmp";
export const RESULT_ENVELOPE_VERSION = 1;
/** Mount destination for the per-run output directory, inside the container. */
export const CONTAINER_OUTPUT_DIR = "/workspace/.out";
/** Host read cap for the signed result file. */
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
/** Cap on retained stdout/stderr diagnostics (tail kept) so an agent that
 *  floods either stream can't exhaust orchestrator memory. */
export const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

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
const DEFAULT_INSTANCE_LOCK_PORT = 47_671;
export const INSTANCE_LOCK_PORT = parsePortEnv("INSTANCE_LOCK_PORT", DEFAULT_INSTANCE_LOCK_PORT);

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

/** Agent model on the OAuth (Claude Max) paths. Aliases track the latest model
 *  in each family — full IDs would silently pin to a stale snapshot. */
export const AGENT_MODEL = process.env.AGENT_MODEL?.trim() || "opus";

/** Load-bearing, not an optimization: the Max plan's Opus-only weekly cap is
 *  shared with the operator's own coding sessions — without a fallback, hitting
 *  the cap silently drops Telegram replies. */
export const AGENT_FALLBACK_MODEL = process.env.AGENT_FALLBACK_MODEL?.trim() || "sonnet";

/** Cheaper model for the pay-per-token ANTHROPIC_API_KEY fallback path. */
export const API_KEY_MODEL = "claude-sonnet-5";

/** The one model-selection policy, shared by the queue and the CLI.
 *  The API-key path gets the cheap model and no fallback (it pays per token);
 *  a fallback equal to the primary is omitted — the SDK rejects that pair, and
 *  e.g. AGENT_MODEL=sonnet with the default fallback would otherwise crash
 *  every container before startup. */
export function selectModels(
  isApiKeyFallback: boolean,
  override?: string,
): { model: string; fallbackModel?: string } {
  if (isApiKeyFallback) return { model: API_KEY_MODEL };
  const model = override ?? AGENT_MODEL;
  return AGENT_FALLBACK_MODEL === model
    ? { model }
    : { model, fallbackModel: AGENT_FALLBACK_MODEL };
}

/** IANA timezone for the agent's session context AND cron interpretation.
 *  Default UTC preserves pre-P5 behavior until the operator opts in via .env.
 *  Cron and display must share one zone — advertising a local zone while
 *  parsing cron in UTC is the wrong-hour regression P5.2 exists to prevent. */
export const AGENT_TIMEZONE = parseTimezoneEnv("AGENT_TIMEZONE", "UTC");

/** Human-readable "now" in AGENT_TIMEZONE for the container session context. */
export function formatAgentTime(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: AGENT_TIMEZONE,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${p.timeZoneName}`;
}

/** Injected message history budgets (chars, not bytes — applied pre-serialization). */
export const HISTORY_MESSAGE_MAX_CHARS = 2000;
export const HISTORY_TOTAL_MAX_CHARS = 16_000;
export const HISTORY_SENDER_NAME_MAX_CHARS = 64;

/** Channel-qualified chat ID that maps to the "main" group (e.g., "tg-123456789"). */
export const MAIN_CHAT_ID = process.env.MAIN_CHAT_ID ?? "";

/** Telegram user IDs allowed to interact with the bot. Empty = fail closed at
 *  startup; the literal entry "*" is the explicit allow-anyone opt-out. */
export const ALLOWED_SENDER_IDS: string[] = process.env.ALLOWED_SENDER_IDS
  ? process.env.ALLOWED_SENDER_IDS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

function parseTimezoneEnv(name: string, fallback: string): string {
  const configured = process.env[name]?.trim();
  if (!configured) return fallback;
  try {
    // Intl throws RangeError on any non-IANA zone name — the validation itself.
    new Intl.DateTimeFormat("en-US", { timeZone: configured });
    return configured;
  } catch {
    console.warn(`[Config] Invalid ${name}=${JSON.stringify(configured)}; using default ${fallback}`);
    return fallback;
  }
}

function parsePortEnv(name: string, fallback: number): number {
  const configured = process.env[name];
  if (configured === undefined || configured === "") return fallback;
  if (/^\d+$/.test(configured)) {
    const value = Number(configured);
    if (Number.isSafeInteger(value) && value >= 1 && value <= 65_535) return value;
  }
  console.warn(`[Config] Invalid ${name}=${JSON.stringify(configured)}; using default ${fallback}`);
  return fallback;
}
