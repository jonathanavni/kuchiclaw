import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authConfig = vi.hoisted(() => ({ MAIN_CHAT_ID: "tg-999" }));
vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js");
  return {
    ...actual,
    get MAIN_CHAT_ID() { return authConfig.MAIN_CHAT_ID; },
  };
});
vi.mock("./oauth-refresh.js", () => ({ getOAuthToken: vi.fn() }));
vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => { throw new Error("no keychain in test"); }),
}));

import { getOAuthToken } from "./oauth-refresh.js";
import {
  AuthUnavailableError,
  getSecrets,
  getSkillSecrets,
  resetSkillSecretWarningsForTest,
} from "./auth.js";

beforeEach(() => {
  resetSkillSecretWarningsForTest();
  authConfig.MAIN_CHAT_ID = "tg-999";
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("FASTMAIL_API_TOKEN", "");
  vi.stubEnv("FASTMAIL_GROUPS", "");
  vi.mocked(getOAuthToken).mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("getSecrets priority order", () => {
  it("explicit CLAUDE_CODE_OAUTH_TOKEN env wins over oauth.json", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "env-grant-token");
    vi.mocked(getOAuthToken).mockResolvedValue("oauth-json-token");

    const result = await getSecrets();

    expect(result).toMatchObject({ source: "env-token", isApiKeyFallback: false });
    expect(result.secrets.CLAUDE_CODE_OAUTH_TOKEN).toBe("env-grant-token");
    expect(getOAuthToken).not.toHaveBeenCalled();
  });

  it("falls back to oauth.json when no env token is set", async () => {
    vi.mocked(getOAuthToken).mockResolvedValue("oauth-json-token");

    const result = await getSecrets();

    expect(result).toMatchObject({ source: "oauth-json", isApiKeyFallback: false });
    expect(result.secrets.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-json-token");
  });

  it("falls back to ANTHROPIC_API_KEY when OAuth paths are unavailable", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");

    const result = await getSecrets();

    expect(result).toMatchObject({ source: "api-key", isApiKeyFallback: true });
    expect(result.secrets).toEqual({ ANTHROPIC_API_KEY: "sk-ant-test" });
  });

  it("throws AuthUnavailableError (never exits) when no credential is found", async () => {
    await expect(getSecrets()).rejects.toBeInstanceOf(AuthUnavailableError);
  });

  it("never includes FASTMAIL_API_TOKEN in auth secrets", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "env-grant-token");
    vi.stubEnv("FASTMAIL_API_TOKEN", "fm-token");
    vi.stubEnv("FASTMAIL_GROUPS", "main");

    expect((await getSecrets()).secrets.FASTMAIL_API_TOKEN).toBeUndefined();
  });
});

describe("getSkillSecrets explicit entitlement", () => {
  it("injects nowhere when FASTMAIL_GROUPS is unset and warns only once", () => {
    vi.stubEnv("FASTMAIL_API_TOKEN", "fm-secret-never-log");
    vi.stubEnv("FASTMAIL_GROUPS", undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(getSkillSecrets("main")).toEqual({});
    expect(getSkillSecrets("tg-123")).toEqual({});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[Auth] FASTMAIL_API_TOKEN is set but FASTMAIL_GROUPS entitles no group — injecting it nowhere",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("fm-secret-never-log");
  });

  it("treats an empty group list as no entitlement", () => {
    vi.stubEnv("FASTMAIL_API_TOKEN", "fm-token");
    vi.stubEnv("FASTMAIL_GROUPS", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(getSkillSecrets("main")).toEqual({});
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[Auth] FASTMAIL_API_TOKEN is set but FASTMAIL_GROUPS entitles no group — injecting it nowhere",
    );
  });

  it("trims entries and tolerates duplicates", () => {
    vi.stubEnv("FASTMAIL_API_TOKEN", "fm-token");
    vi.stubEnv("FASTMAIL_GROUPS", "main, tg-123 ,main");

    expect(getSkillSecrets("main")).toEqual({ FASTMAIL_API_TOKEN: "fm-token" });
    expect(getSkillSecrets("tg-123")).toEqual({ FASTMAIL_API_TOKEN: "fm-token" });
    expect(getSkillSecrets("tg-456")).toEqual({});
  });

  it("warns on invalid group names and skips them", () => {
    vi.stubEnv("FASTMAIL_API_TOKEN", "fm-secret-never-log");
    vi.stubEnv("FASTMAIL_GROUPS", "main,../etc,tg-9x");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(getSkillSecrets("main")).toEqual({ FASTMAIL_API_TOKEN: "fm-secret-never-log" });
    expect(getSkillSecrets("../etc")).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"../etc"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"tg-9x"'));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("fm-secret-never-log");
  });

  it("rejects main when MAIN_CHAT_ID is unset", () => {
    authConfig.MAIN_CHAT_ID = "";
    vi.stubEnv("FASTMAIL_API_TOKEN", "fm-token");
    vi.stubEnv("FASTMAIL_GROUPS", "main");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(getSkillSecrets("main")).toEqual({});
  });
});
