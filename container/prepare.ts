import { existsSync, readFileSync } from "node:fs";

export const AGENT_VISIBLE_SECRET_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "FASTMAIL_API_TOKEN",
] as const;

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
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
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

/** Truncate to the byte budget with a notice the agent can act on. Exported for tests. */
export function capLivingFile(content: string, path: string): string {
  if (Buffer.byteLength(content, "utf8") <= LIVING_FILE_MAX_BYTES) return content;
  const truncated = Buffer.from(content, "utf8")
    .subarray(0, LIVING_FILE_MAX_BYTES)
    .toString("utf8")
    .replace(/�+$/, ""); // a byte-boundary cut can split the last code point
  return `${truncated}\n\n> [TRUNCATED] ${path} exceeds the ${LIVING_FILE_MAX_BYTES / 1024}KB context budget — ` +
    "the rest of this file was not loaded. Tighten it per your memory-housekeeping rules.";
}

function readIfExists(path: string): string {
  return existsSync(path) ? capLivingFile(readFileSync(path, "utf-8"), path) : "";
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
    if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
    return {
      accessToken,
      refreshToken: returnedRefreshToken ?? refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  } catch {
    return null;
  }
}
