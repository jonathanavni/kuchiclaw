import { createHmac } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, openSync, readSync } from "node:fs";

export const AGENT_VISIBLE_SECRET_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "FASTMAIL_API_TOKEN",
] as const;

// Result-transport constants — kept byte-identical to src/config.ts (parity test).
export const RESULT_FILENAME = "result.json";
export const RESULT_TMP_FILENAME = "result.json.tmp";
export const RESULT_ENVELOPE_VERSION = 1;
export const CONTAINER_OUTPUT_DIR = "/workspace/.out";

/** Build the signed result envelope. The HMAC covers the serialized payload;
 *  the host verifies it with the same per-run key, so a same-uid agent that
 *  overwrites the file cannot forge a passing envelope without the key. */
export function signEnvelope(payload: unknown, outputKey: string): string {
  const payloadString = JSON.stringify(payload);
  const hmac = createHmac("sha256", Buffer.from(outputKey, "hex"))
    .update(payloadString, "utf8")
    .digest("hex");
  return JSON.stringify({ v: RESULT_ENVELOPE_VERSION, hmac, payload: payloadString });
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// Keep ContainerInput in sync with ../src/types.ts across the host/container boundary.
export interface ContainerInput {
  prompt: string;
  groupFolder: string;
  chatId?: string;
  secrets: Record<string, string>;
  refreshToken?: string;
  systemPrompt?: string;
  messageHistory?: string;
  currentTime?: string;
  timezone?: string;
  mcpServers?: Record<string, McpServerConfig>;
  model?: string;
  fallbackModel?: string;
  outputKey?: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export type ContainerErrorKind =
  | "auth"
  | "rate_limit"
  | "max_turns"
  | "container_crash"
  | "other";

export interface ErrorEvidence {
  source: "sdk_result" | "entrypoint_catch";
  assistantErrors?: readonly string[];
  resultErrors?: readonly string[];
  subtype?: string;
  message?: string;
  stderr?: string;
}

const AUTH_ERROR_VALUES = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "billing_error",
]);

/** Classify from typed SDK evidence first; text is a bounded compatibility
 *  fallback for older/untyped SDK failures. */
export function classifyError(evidence: ErrorEvidence): ContainerErrorKind {
  if (evidence.source === "entrypoint_catch") return "container_crash";

  for (const value of evidence.assistantErrors ?? []) {
    if (AUTH_ERROR_VALUES.has(value)) return "auth";
    if (value === "rate_limit") return "rate_limit";
  }

  const structuredTextKind = classifyText(evidence.resultErrors ?? [], 16, 2048);
  if (structuredTextKind) return structuredTextKind;

  if (evidence.subtype === "error_max_turns") return "max_turns";

  return classifyText([evidence.message ?? "", evidence.stderr ?? ""], 2, 8192) ?? "other";
}

function classifyText(
  values: readonly string[],
  maxValues: number,
  maxChars: number,
): "auth" | "rate_limit" | undefined {
  const text = values.slice(0, maxValues).map((value) => value.slice(0, maxChars)).join("\n").toLowerCase();
  if (/authentication[_ -]failed|oauth|unauthorized|\b401\b|invalid (?:access )?token|token (?:has )?expired|credentials? (?:are )?invalid/.test(text)) {
    return "auth";
  }
  if (/rate[_ -]limit|too many requests|\b429\b/.test(text)) return "rate_limit";
  return undefined;
}

export type AgentEnv = Record<string, string | undefined>;

export function parseInput(raw: string): ContainerInput {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Container input must be a JSON object");
  }
  const secrets = (parsed as { secrets?: unknown }).secrets;
  if (!secrets || typeof secrets !== "object" || Array.isArray(secrets)) {
    throw new Error("Container input secrets must be a JSON object");
  }
  return parsed as ContainerInput;
}

export function applySecretsToEnv(
  secrets: Record<string, string>,
  env: AgentEnv,
  forbiddenValues: Iterable<string | undefined>,
): string[] {
  const allowed = new Set<string>(AGENT_VISIBLE_SECRET_KEYS);
  const forbidden = new Set(
    [...forbiddenValues].filter((value): value is string => value !== undefined),
  );
  const warnings: string[] = [];

  for (const [key, value] of Object.entries(secrets)) {
    if (!allowed.has(key) || forbidden.has(value)) {
      warnings.push(`refused secret key: ${forbidden.has(key) ? "<redacted>" : key}`);
      continue;
    }
    env[key] = value;
  }
  return warnings;
}

/** The refresh credential is scrubbed before any untrusted agent code runs. */
export async function refreshAuth(
  input: ContainerInput,
  env: AgentEnv,
): Promise<OAuthTokens | undefined> {
  const refreshToken = input.refreshToken;
  try {
    if (!refreshToken) return undefined;
    const refreshed = await refreshOAuthToken(refreshToken);
    if (!refreshed) return undefined;
    env.CLAUDE_CODE_OAUTH_TOKEN = refreshed.accessToken;
    return refreshed;
  } finally {
    delete input.refreshToken;
  }
}

export function buildSystemPrompt(): string {
  const parts = [
    "/workspace/SOUL.md",
    "/workspace/TOOLS.md",
    "/workspace/HEARTBEAT.md",
    "/workspace/MEMORY.md",
    "/workspace/CONTEXT.md",
  ].map(readIfExists).filter(Boolean);
  return parts.join("\n\n---\n\n");
}

export function buildSessionContext(input: ContainerInput): string {
  const parts: string[] = [];
  if (input.groupFolder) parts.push(`Group: ${input.groupFolder}`);
  if (input.chatId) parts.push(`Chat ID: ${input.chatId}`);
  if (input.currentTime) parts.push(`Current time: ${input.currentTime}`);
  if (input.timezone) {
    // One zone governs both display and cron — stating it here prevents the
    // agent from converting to UTC before writing task_create cron expressions.
    parts.push(`Timezone: ${input.timezone} (scheduled-task cron expressions are interpreted in this timezone)`);
  }
  return parts.join("\n");
}

export function assembleSystemPrompt(input: ContainerInput): string {
  let prompt = input.systemPrompt || buildSystemPrompt();
  const sessionContext = buildSessionContext(input);
  if (sessionContext) {
    prompt += `\n\n---\n\n## Session Context\n${sessionContext}`;
  }
  if (input.messageHistory) prompt += `\n\n---\n\n${input.messageHistory}`;
  return prompt;
}

/** Per-file context budget for injected living files. The agent grows MEMORY.md
 *  and CONTEXT.md without bound (rw mounts); this is the mechanism behind the
 *  SOUL.md housekeeping instruction, not a replacement for it. */
export const LIVING_FILE_MAX_BYTES = 64 * 1024;

/** Truncate to the byte budget with a notice the agent can act on. The notice's
 *  own bytes are reserved so the returned value never exceeds the budget.
 *  Exported for tests. */
export function capLivingFile(content: string, path: string): string {
  if (Buffer.byteLength(content, "utf8") <= LIVING_FILE_MAX_BYTES) return content;
  const notice = `\n\n> [TRUNCATED] ${path} exceeds the ${LIVING_FILE_MAX_BYTES / 1024}KB context ` +
    "budget — the rest of this file was not loaded. Tighten it per your memory-housekeeping rules.";
  const budget = Math.max(0, LIVING_FILE_MAX_BYTES - Buffer.byteLength(notice, "utf8"));
  const truncated = Buffer.from(content, "utf8")
    .subarray(0, budget)
    .toString("utf8")
    .replace(/�+$/, ""); // a byte-boundary cut can split the last code point
  return truncated + notice;
}

/** Read at most LIVING_FILE_MAX_BYTES+1 bytes so a same-uid agent that grows its
 *  rw-mounted MEMORY.md/CONTEXT.md to gigabytes can't OOM the entrypoint before
 *  it signs a result — the whole file is never loaded into memory. */
function readCappedFile(path: string): string {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(LIVING_FILE_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const bytesRead = readSync(fd, buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function readIfExists(path: string): string {
  return existsSync(path) ? capLivingFile(readCappedFile(path), path) : "";
}

/** Existing in-container refresh request, kept byte-for-byte in behavior. */
async function refreshOAuthToken(refreshToken: string): Promise<OAuthTokens | null> {
  try {
    const response = await fetch("https://platform.claude.com/v1/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        scope: "user:profile user:inference user:sessions:claude_code user:mcp_servers",
      }),
    });
    if (!response.ok) return null;
    const body = await response.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const {
      access_token: accessToken,
      refresh_token: returnedRefreshToken,
      expires_in: expiresIn,
    } = body as Record<string, unknown>;
    if (typeof accessToken !== "string" || accessToken.trim().length === 0) return null;
    if (returnedRefreshToken !== undefined &&
        (typeof returnedRefreshToken !== "string" || returnedRefreshToken.trim().length === 0)) {
      return null;
    }
    if (accessToken === refreshToken || accessToken === returnedRefreshToken) return null;
    // A non-numeric expires_in would mint a NaN expiresAt that slips through the
    // host's monotonic guard (NaN compares false) into oauth.json.
    // Cap at one year — parity with src/oauth-refresh.ts: an overflowing
    // expires_in must not mint an out-of-range expiresAt on either side.
    if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) ||
        expiresIn <= 0 || expiresIn > 365 * 24 * 3600) return null;
    return {
      accessToken,
      refreshToken: returnedRefreshToken ?? refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  } catch {
    return null;
  }
}
