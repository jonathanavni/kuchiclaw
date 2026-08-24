// Authentication helpers — shared by cli.ts and index.ts.
// Priority: explicit CLAUDE_CODE_OAUTH_TOKEN > OAuth auto-refresh > ANTHROPIC_API_KEY > macOS keychain.

import { execSync } from "node:child_process";
import { getOAuthToken } from "./oauth-refresh.js";

/** Read OAuth token from macOS keychain where Claude Code stores it */
function readTokenFromKeychain(): string | null {
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    const creds = JSON.parse(raw);
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

/** Which credential path won — callers gate lineage-specific behavior on this */
export type AuthSource = "env-token" | "oauth-json" | "api-key" | "keychain";

/**
 * No usable credential was found. Thrown (never `process.exit`) so a transient
 * auth gap fails the one job instead of taking down the long-running orchestrator
 * — on the Cloudflare-blocked VPS a stale token with no fallback would otherwise
 * crash-loop the whole process. [M12 P3]
 */
export class AuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthUnavailableError";
  }
}

export interface AuthResult {
  secrets: Record<string, string>;
  /** True when using ANTHROPIC_API_KEY (paid) instead of OAuth (free with Claude Max) */
  isApiKeyFallback: boolean;
  source: AuthSource;
}

/** Resolve auth secrets. Priority: CLAUDE_CODE_OAUTH_TOKEN env > oauth.json (auto-refresh) > API key > keychain. */
export async function getSecrets(): Promise<AuthResult> {
  const secrets: Record<string, string> = {};
  let isApiKeyFallback = false;
  let source: AuthSource;

  // 1. Explicit env token (a dedicated `claude setup-token` grant — the VPS primary path).
  //    Must win over oauth.json: each grant has its own refresh lineage, and letting a stale
  //    oauth.json shadow an explicit grant is the documented cause of auth crash-loops.
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    secrets.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    source = "env-token";
  }
  // 2. OAuth auto-refresh (data/oauth.json)
  else {
    const oauthToken = await getOAuthToken();
    if (oauthToken) {
      secrets.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
      source = "oauth-json";
    }
    // 3. API key (paid fallback, use cheaper model)
    else if (process.env.ANTHROPIC_API_KEY) {
      secrets.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      isApiKeyFallback = true;
      source = "api-key";
      console.warn("[Auth] OAuth unavailable, falling back to ANTHROPIC_API_KEY (Sonnet)");
    }
    // 4. macOS keychain (local dev)
    else {
      const keychainToken = readTokenFromKeychain();
      if (keychainToken) {
        secrets.CLAUDE_CODE_OAUTH_TOKEN = keychainToken;
        source = "keychain";
      } else {
        throw new AuthUnavailableError(
          "No auth token found. Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY, " +
          "provide data/oauth.json (OAuth refresh), or log in to Claude Code."
        );
      }
    }
  }

  // Optional skill secrets — passed through to container environment
  if (process.env.FASTMAIL_API_TOKEN) {
    secrets.FASTMAIL_API_TOKEN = process.env.FASTMAIL_API_TOKEN;
  }

  return { secrets, isApiKeyFallback, source };
}
