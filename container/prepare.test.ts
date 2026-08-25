import { afterEach, describe, expect, it, vi } from "vitest";
import { SKILL_SECRET_SPECS } from "../src/auth.js";
import {
  AGENT_VISIBLE_SECRET_KEYS,
  applySecretsToEnv,
  parseInput,
  refreshAuth,
  type ContainerInput,
} from "./prepare.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("prepare input and secrets", () => {
  it("parses an object and rejects malformed or non-object JSON", () => {
    expect(parseInput('{"prompt":"hello","secrets":{}}')).toEqual({ prompt: "hello", secrets: {} });
    expect(() => parseInput("not-json")).toThrow();
    expect(() => parseInput("null")).toThrow(/JSON object/);
  });

  it("rejects array input with a clear error", () => {
    expect(() => parseInput("[]")).toThrow("Container input must be a JSON object");
  });

  it("requires secrets to be a JSON object", () => {
    expect(() => parseInput('{"prompt":"hello"}')).toThrow(
      "Container input secrets must be a JSON object",
    );
    expect(() => parseInput('{"prompt":"hello","secrets":[]}')).toThrow(
      "Container input secrets must be a JSON object",
    );
  });

  it("applies only allowlisted keys and reports names without values", () => {
    const env: Record<string, string | undefined> = {};
    const warnings = applySecretsToEnv({
      CLAUDE_CODE_OAUTH_TOKEN: "short-oauth",
      ANTHROPIC_API_KEY: "short-api",
      FASTMAIL_API_TOKEN: "fastmail",
      UNKNOWN_SECRET: "unknown-value-never-log",
      GOOGLE_SAFE_KEY: "future-value-never-log",
    }, env, []);

    expect(env).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "short-oauth",
      ANTHROPIC_API_KEY: "short-api",
      FASTMAIL_API_TOKEN: "fastmail",
    });
    expect(warnings).toEqual([
      "refused secret key: UNKNOWN_SECRET",
      "refused secret key: GOOGLE_SAFE_KEY",
    ]);
    expect(JSON.stringify(warnings)).not.toContain("value-never-log");
  });

  it("refuses an allowlisted key when its value is forbidden", () => {
    const env: Record<string, string | undefined> = {};
    expect(applySecretsToEnv(
      { FASTMAIL_API_TOKEN: "long-lived-refresh" },
      env,
      ["long-lived-refresh"],
    )).toEqual(["refused secret key: FASTMAIL_API_TOKEN"]);
    expect(env).toEqual({});
  });
});

describe("refreshAuth scrubbing", () => {
  it("sets the refreshed access token and always deletes the input refresh token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 60 }),
    }));
    const input = makeInput("old-refresh");
    const env: Record<string, string | undefined> = {};

    const tokens = await refreshAuth(input, env);

    expect(tokens).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("new-access");
    expect(input.refreshToken).toBeUndefined();
  });

  it.each(["failure", "absent"])("scrubs on %s", async (kind) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const input = makeInput(kind === "failure" ? "old-refresh" : undefined);

    expect(await refreshAuth(input, {})).toBeUndefined();
    expect(input).not.toHaveProperty("refreshToken");
  });

  it.each([
    ["missing access token", { refresh_token: "new-refresh", expires_in: 60 }],
    ["empty access token", { access_token: "", refresh_token: "new-refresh", expires_in: 60 }],
    ["non-string access token", { access_token: 123, refresh_token: "new-refresh", expires_in: 60 }],
    ["empty returned refresh token", { access_token: "new-access", refresh_token: "", expires_in: 60 }],
    ["non-string returned refresh token", { access_token: "new-access", refresh_token: 123, expires_in: 60 }],
    ["missing expires_in", { access_token: "new-access", refresh_token: "new-refresh" }],
    ["non-numeric expires_in", { access_token: "new-access", refresh_token: "new-refresh", expires_in: "60" }],
    ["non-positive expires_in", { access_token: "new-access", refresh_token: "new-refresh", expires_in: 0 }],
  ])("rejects a response with %s and preserves the original access token", async (_name, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => body,
    }));
    const input = makeInput("old-refresh");
    const env = { CLAUDE_CODE_OAUTH_TOKEN: "original-access" };

    expect(await refreshAuth(input, env)).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("original-access");
    expect(input).not.toHaveProperty("refreshToken");
  });
});

it("keeps the skill-secret registry within the container allowlist", () => {
  expect(SKILL_SECRET_SPECS.every((spec) =>
    (AGENT_VISIBLE_SECRET_KEYS as readonly string[]).includes(spec.env)
  )).toBe(true);
});

function makeInput(refreshToken?: string): ContainerInput {
  return { prompt: "hello", groupFolder: "tg-123", secrets: {}, refreshToken };
}
