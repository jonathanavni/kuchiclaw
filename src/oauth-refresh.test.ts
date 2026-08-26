import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOAuthToken,
  getRefreshToken,
  resetOAuthForTest,
  updateOAuthData,
  type OAuthData,
} from "./oauth-refresh.js";

const NOW = 1_700_000_000_000;
const BUFFER_MS = 5 * 60 * 1000;

let tmpRoot: string;
let oauthPath: string;

function writeTokens(data: Partial<OAuthData> | string) {
  fs.writeFileSync(oauthPath, typeof data === "string" ? data : JSON.stringify(data));
}

function fetchResponding(body: unknown, ok = true) {
  const impl = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 400,
    statusText: ok ? "OK" : "Bad Request",
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  vi.stubGlobal("fetch", impl);
  return impl;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kuchiclaw-oauth-"));
  oauthPath = path.join(tmpRoot, "oauth.json");
  resetOAuthForTest(oauthPath);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetOAuthForTest();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("getOAuthToken expiry boundary", () => {
  it("returns the cached token while strictly inside the refresh buffer", async () => {
    writeTokens({ accessToken: "live", refreshToken: "rt", expiresAt: NOW + BUFFER_MS + 1 });
    const fetchSpy = fetchResponding({});

    await expect(getOAuthToken()).resolves.toBe("live");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refreshes once the buffer boundary is reached", async () => {
    writeTokens({ accessToken: "old", refreshToken: "rt", expiresAt: NOW + BUFFER_MS });
    const fetchSpy = fetchResponding({ access_token: "fresh", expires_in: 3600 });

    await expect(getOAuthToken()).resolves.toBe("fresh");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const persisted = JSON.parse(fs.readFileSync(oauthPath, "utf-8"));
    expect(persisted).toEqual({ accessToken: "fresh", refreshToken: "rt", expiresAt: NOW + 3600 * 1000 });
  });

  it("returns null when no oauth.json exists or it is malformed", async () => {
    await expect(getOAuthToken()).resolves.toBeNull();
    writeTokens("{ not json");
    resetOAuthForTest(oauthPath);
    await expect(getOAuthToken()).resolves.toBeNull();
    writeTokens({ accessToken: "a" }); // missing fields
    resetOAuthForTest(oauthPath);
    await expect(getOAuthToken()).resolves.toBeNull();
  });
});

describe("single-flight refresh", () => {
  it("coalesces concurrent expired-token calls into one fetch", async () => {
    writeTokens({ accessToken: "old", refreshToken: "rt", expiresAt: NOW - 1 });
    let release!: (v: unknown) => void;
    const gate = new Promise((done) => { release = done; });
    const fetchSpy = vi.fn(async () => {
      await gate;
      return { ok: true, status: 200, statusText: "OK", json: async () => ({ access_token: "fresh", expires_in: 3600 }) };
    });
    vi.stubGlobal("fetch", fetchSpy);

    const calls = [getOAuthToken(), getOAuthToken(), getOAuthToken()];
    release(undefined);
    await expect(Promise.all(calls)).resolves.toEqual(["fresh", "fresh", "fresh"]);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("clears the cache on a failed refresh so the next call re-reads disk", async () => {
    writeTokens({ accessToken: "old", refreshToken: "rt", expiresAt: NOW - 1 });
    fetchResponding({}, false);
    await expect(getOAuthToken()).resolves.toBeNull();

    // A repaired oauth.json is picked up without a process restart.
    writeTokens({ accessToken: "repaired", refreshToken: "rt2", expiresAt: NOW + BUFFER_MS * 2 });
    await expect(getOAuthToken()).resolves.toBe("repaired");
  });
});

describe("refresh response validation (parity with container/prepare.ts)", () => {
  const cases: Array<[string, unknown]> = [
    ["non-object body", "oops"],
    ["missing access token", { expires_in: 3600 }],
    ["empty access token", { access_token: "  ", expires_in: 3600 }],
    ["malformed rotated refresh token", { access_token: "a", refresh_token: 42, expires_in: 3600 }],
    ["access token echoing the refresh token", { access_token: "rt", expires_in: 3600 }],
    ["missing expires_in", { access_token: "a" }],
    ["non-numeric expires_in (NaN expiresAt)", { access_token: "a", expires_in: "3600" }],
    ["non-finite expires_in", { access_token: "a", expires_in: Infinity }],
    ["non-positive expires_in", { access_token: "a", expires_in: 0 }],
  ];

  it.each(cases)("rejects a response with %s", async (_label, body) => {
    writeTokens({ accessToken: "old", refreshToken: "rt", expiresAt: NOW - 1 });
    fetchResponding(body);

    await expect(getOAuthToken()).resolves.toBeNull();
    // Nothing invalid may be persisted — the file still holds the old tokens.
    expect(JSON.parse(fs.readFileSync(oauthPath, "utf-8")).accessToken).toBe("old");
  });

  it("adopts a rotated refresh token and falls back to the old one when absent", async () => {
    writeTokens({ accessToken: "old", refreshToken: "rt", expiresAt: NOW - 1 });
    fetchResponding({ access_token: "fresh", refresh_token: "rt-rotated", expires_in: 3600 });
    await getOAuthToken();
    expect(getRefreshToken()).toBe("rt-rotated");

    vi.setSystemTime(NOW + 3600 * 1000);
    fetchResponding({ access_token: "fresher", expires_in: 3600 });
    await getOAuthToken();
    expect(getRefreshToken()).toBe("rt-rotated");
  });
});

describe("updateOAuthData (container-returned tokens)", () => {
  it("persists newer tokens with 0o600 and rejects stale or equal-expiry writes", () => {
    updateOAuthData({ accessToken: "a1", refreshToken: "r1", expiresAt: NOW + 1000 });
    expect(fs.statSync(oauthPath).mode & 0o777).toBe(0o600);

    updateOAuthData({ accessToken: "a0", refreshToken: "r0", expiresAt: NOW + 1000 });
    updateOAuthData({ accessToken: "a-1", refreshToken: "r-1", expiresAt: NOW - 5 });
    expect(JSON.parse(fs.readFileSync(oauthPath, "utf-8")).accessToken).toBe("a1");

    updateOAuthData({ accessToken: "a2", refreshToken: "r2", expiresAt: NOW + 2000 });
    expect(JSON.parse(fs.readFileSync(oauthPath, "utf-8")).accessToken).toBe("a2");
  });
});
