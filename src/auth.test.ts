import { describe, it, expect, afterEach, vi } from "vitest";

// Mock the oauth.json path so tests control whether it "exists"
vi.mock("./oauth-refresh.js", () => ({
  getOAuthToken: vi.fn(),
}));

import { getOAuthToken } from "./oauth-refresh.js";
import { getSecrets } from "./auth.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("getSecrets priority order", () => {
  it("explicit CLAUDE_CODE_OAUTH_TOKEN env wins over oauth.json", async () => {
    // A stale-but-readable oauth.json must not shadow a dedicated setup-token grant —
    // the token-lineage crash-loop P4.1 exists to prevent
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "env-grant-token");
    vi.mocked(getOAuthToken).mockResolvedValue("oauth-json-token");

    const result = await getSecrets();

    expect(result.source).toBe("env-token");
    expect(result.secrets.CLAUDE_CODE_OAUTH_TOKEN).toBe("env-grant-token");
    expect(result.isApiKeyFallback).toBe(false);
    expect(getOAuthToken).not.toHaveBeenCalled();
  });

  it("falls back to oauth.json when no env token is set", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    vi.mocked(getOAuthToken).mockResolvedValue("oauth-json-token");

    const result = await getSecrets();

    expect(result.source).toBe("oauth-json");
    expect(result.secrets.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-json-token");
    expect(result.isApiKeyFallback).toBe(false);
  });

  it("falls back to ANTHROPIC_API_KEY when OAuth paths are unavailable", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.mocked(getOAuthToken).mockResolvedValue(null);

    const result = await getSecrets();

    expect(result.source).toBe("api-key");
    expect(result.secrets.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(result.secrets.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(result.isApiKeyFallback).toBe(true);
  });

  it("passes FASTMAIL_API_TOKEN through regardless of auth source", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "env-grant-token");
    vi.stubEnv("FASTMAIL_API_TOKEN", "fm-token");

    const result = await getSecrets();

    expect(result.secrets.FASTMAIL_API_TOKEN).toBe("fm-token");
  });
});
