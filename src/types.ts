// Shared type definitions for KuchiClaw

/** MCP server configuration — matches the format expected by Claude Agent SDK */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Input passed to the container via stdin */
// Keep ContainerInput/ContainerOutput in sync with ../container/prepare.ts and ../container/entrypoint.ts.
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  /** Chat ID where the message originated — used for IPC replies */
  chatId?: string;
  secrets: Record<string, string>;
  /** OAuth refresh token — passed so the container can refresh if the access token was rotated.
   *  Containers can reach platform.claude.com even when the VPS host is Cloudflare-blocked. */
  refreshToken?: string;
  /** System prompt built from living files (SOUL.md + TOOLS.md + MEMORY.md + CONTEXT.md) */
  systemPrompt?: string;
  /** Recent message history formatted for injection into the prompt */
  messageHistory?: string;
  /** Human-readable "now" in the agent's timezone, computed host-side at spawn */
  currentTime?: string;
  /** IANA timezone that governs both display and cron interpretation */
  timezone?: string;
  /** MCP server configs to pass to the SDK */
  mcpServers?: Record<string, McpServerConfig>;
  /** Model for the SDK query — unset lets the SDK pick its default */
  model?: string;
  /** Model the SDK falls back to when `model` is capacity-limited (e.g. the Opus weekly cap) */
  fallbackModel?: string;
}

/** IPC request written by the container to the mounted IPC directory */
export interface IpcRequest {
  /** Operation type */
  op: "message" | "task_create" | "task_pause" | "task_resume" | "task_cancel" | "task_list";
  /** Target chat ID */
  chatId: string;
  /** Message text (for "message" op) */
  text?: string;
  /** Optional debug echo; authorization derives from the mounted namespace. */
  group?: string;

  // Task fields (for task_* ops)
  /** Task prompt — what the agent should do when the task runs */
  prompt?: string;
  /** Schedule type */
  scheduleType?: "cron" | "interval" | "once";
  /** Cron expression, interval in ms, or ISO timestamp for one-shot */
  scheduleValue?: string;
  /** Human-readable task label */
  label?: string;
  /** Task ID (for pause/resume/cancel) */
  taskId?: number;
}

/** A scheduled task stored in SQLite */
export interface ScheduledTask {
  id: number;
  group_folder: string;
  chat_id: string;
  prompt: string;
  schedule_type: "cron" | "interval" | "once";
  schedule_value: string;
  next_run: string; // ISO 8601
  status: "active" | "paused" | "completed";
  created_at: string;
  label: string | null;
}

/** A log entry for a single task execution */
export interface TaskRunLog {
  id: number;
  task_id: number;
  run_at: string;
  duration_ms: number | null;
  status: "success" | "error";
  result: string | null;
  error: string | null;
}

/** Output received from the container via stdout sentinel markers */
export interface ContainerOutput {
  status: "success" | "error";
  result?: string;
  newSessionId?: string;
  error?: string;
  /** Refused secret names surfaced to the host even when the run succeeds. */
  warnings?: string[];
  /** Fresh OAuth tokens if the container refreshed them — host persists these to oauth.json */
  newTokens?: { accessToken: string; refreshToken: string; expiresAt: number };
}
