// OAuth token auto-refresh for Claude Max.
// Reads/writes data/oauth.json with accessToken, refreshToken, expiresAt.
// Refreshes on demand when token is within 5 minutes of expiry.
// Returns null on failure — caller falls back to ANTHROPIC_API_KEY or keychain.

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

let oauthPath = path.join(DATA_DIR, "oauth.json");

// Refresh 5 minutes before expiry to avoid mid-request failures
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers";

export interface OAuthData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms since epoch
}

/** Cached in memory to avoid re-reading file on every call */
let cached: OAuthData | null = null;

/** Single-flight guard: concurrent jobs needing a refresh share one request so
 *  they can't clobber each other's token via racing writes. */
let refreshInFlight: Promise<OAuthData | null> | null = null;

/** Test seam: point the module at a scratch oauth.json and clear all module
 *  state (path, cache, single-flight promise) — the resetDb() convention. */
export function resetOAuthForTest(pathOverride?: string): void {
  oauthPath = pathOverride ?? path.join(DATA_DIR, "oauth.json");
  cached = null;
  refreshInFlight = null;
}

function loadFromDisk(): OAuthData | null {
  try {
    if (!fs.existsSync(oauthPath)) return null;
    const raw = JSON.parse(fs.readFileSync(oauthPath, "utf-8"));
    if (!raw.accessToken || !raw.refreshToken || !raw.expiresAt) return null;
    return raw as OAuthData;
  } catch {
    return null;
  }
}

function saveToDisk(data: OAuthData): void {
  fs.mkdirSync(path.dirname(oauthPath), { recursive: true });
  fs.writeFileSync(oauthPath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

async function refreshToken(refreshToken: string): Promise<OAuthData | null> {
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        scope: SCOPES,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      console.error(`[OAuth] Refresh failed: ${res.status} ${res.statusText} — ${body}`);
      return null;
    }

    // Validate the response shape before trusting it — mirrors the container's
    // refreshOAuthToken (container/prepare.ts). Without the expires_in check, a
    // malformed response mints a NaN expiresAt that slips through the monotonic
    // guard in updateOAuthData (NaN compares false) into oauth.json.
    const body = await res.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      console.error("[OAuth] Refresh response is not an object");
      return null;
    }
    const {
      access_token: accessToken,
      refresh_token: returnedRefreshToken,
      expires_in: expiresIn,
    } = body as Record<string, unknown>;
    if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
      console.error("[OAuth] Refresh response has no access token");
      return null;
    }
    if (returnedRefreshToken !== undefined &&
        (typeof returnedRefreshToken !== "string" || returnedRefreshToken.trim().length === 0)) {
      console.error("[OAuth] Refresh response has a malformed refresh token");
      return null;
    }
    if (accessToken === refreshToken || accessToken === returnedRefreshToken) {
      console.error("[OAuth] Refresh response echoes the refresh token as access token");
      return null;
    }
    if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      console.error("[OAuth] Refresh response has an invalid expires_in");
      return null;
    }

    return {
      accessToken,
      refreshToken: returnedRefreshToken ?? refreshToken, // may rotate
      expiresAt: Date.now() + expiresIn * 1000,
    };
  } catch (err) {
    console.error(`[OAuth] Refresh error: ${err}`);
    return null;
  }
}

/** Get the current refresh token from disk (or cache). Used to pass to containers. */
export function getRefreshToken(): string | null {
  if (!cached) cached = loadFromDisk();
  return cached?.refreshToken ?? null;
}

/**
 * Persist new OAuth tokens from a container refresh — updates cache and disk.
 * Monotonic: ignores a write whose token expires no later than the one we
 * already hold, so a slower container returning an older token can't clobber a
 * newer one when two finish near-simultaneously.
 *
 * Ordering by access-token expiry is a heuristic, not a true refresh-lineage
 * sequence — it can't perfectly resolve a rotated refresh token. On the actual
 * VPS this is low-risk: the host is Cloudflare-blocked from platform.claude.com,
 * so host-side refresh never runs there and the container is the sole refresher;
 * and the P4.1 primary path (a dedicated setup-token grant) passes no refresh
 * token to containers at all, so no container refresh happens. The full
 * compare-and-swap/generation fix is deferred as disproportionate here.
 */
export function updateOAuthData(data: OAuthData): void {
  if (!cached) cached = loadFromDisk();
  if (cached && data.expiresAt <= cached.expiresAt) {
    console.warn("[OAuth] Ignoring stale token write (not newer than current)");
    return;
  }
  cached = data;
  saveToDisk(data);
}

/**
 * Get a valid OAuth access token, refreshing if needed.
 * Returns null if no oauth.json exists or refresh fails.
 */
export async function getOAuthToken(): Promise<string | null> {
  if (!cached) cached = loadFromDisk();
  if (!cached) return null;

  // Token still valid — return it
  if (Date.now() < cached.expiresAt - REFRESH_BUFFER_MS) {
    return cached.accessToken;
  }

  // Needs refresh — single-flight so N concurrent jobs trigger ONE refresh and
  // share its result, rather than each racing a write to oauth.json.
  if (!refreshInFlight) {
    const rt = cached.refreshToken;
    refreshInFlight = (async () => {
      console.log("[OAuth] Token expiring soon, refreshing...");
      const refreshed = await refreshToken(rt);
      if (refreshed) {
        cached = refreshed;
        saveToDisk(refreshed);
        console.log("[OAuth] Token refreshed, expires at", new Date(refreshed.expiresAt).toISOString());
      } else {
        cached = null;
      }
      return refreshed;
    })().finally(() => { refreshInFlight = null; });
  }

  const refreshed = await refreshInFlight;
  return refreshed?.accessToken ?? null;
}
