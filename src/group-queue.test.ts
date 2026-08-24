import { describe, it, expect, beforeEach, vi } from "vitest";

// Fast retry delays so the retry/backoff paths don't make the suite slow.
vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js");
  return { ...actual, BASE_RETRY_MS: 1, DELIVERY_BASE_MS: 1, MAX_CONTAINERS_PER_GROUP: 2 };
});

// Authorization always passes here — identity validation is covered by ipc-auth tests.
vi.mock("./ipc-auth.js", () => ({ assertDestinationAllowed: vi.fn() }));

vi.mock("./container-runner.js", () => ({ runContainer: vi.fn() }));
vi.mock("./group-folder.js", () => ({ ensureGroupFolder: vi.fn(() => ({})) }));
vi.mock("./oauth-refresh.js", () => ({ getRefreshToken: vi.fn(() => null) }));
vi.mock("./db.js", () => ({
  insertMessage: vi.fn(() => 1),
  updateMessageStatus: vi.fn(),
  getRecentMessages: vi.fn(() => []),
  formatHistory: vi.fn(() => ""),
}));

// Real AuthUnavailableError, mockable getSecrets.
vi.mock("./auth.js", async () => {
  const actual = await vi.importActual<typeof import("./auth.js")>("./auth.js");
  return { ...actual, getSecrets: vi.fn() };
});

import { runContainer } from "./container-runner.js";
import { getSecrets, AuthUnavailableError } from "./auth.js";
import { updateMessageStatus, insertMessage } from "./db.js";
import { enqueue } from "./group-queue.js";

const okAuth = { secrets: {}, isApiKeyFallback: false, source: "keychain" as const };

function makeChannel(sendImpl?: (chatId: string, text: string) => Promise<void>) {
  return {
    sendMessage: vi.fn(sendImpl ?? (async () => {})),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(() => true),
  };
}

/** Enqueue and resolve when the job signals completion or error. */
function runJob(overrides: Record<string, unknown>): Promise<{ result?: string; error?: string }> {
  return new Promise((resolve) => {
    enqueue({
      group: "tg-123",
      chatId: "123",
      senderName: "tester",
      text: "hello",
      secrets: {},
      channel: makeChannel() as never,
      attempt: 1,
      messageId: 1,
      onComplete: (result) => resolve({ result }),
      onError: (error) => resolve({ error }),
      ...overrides,
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSecrets).mockResolvedValue(okAuth);
});

describe("group-queue executeJob", () => {
  it("delivers a successful result and persists it before sending", async () => {
    vi.mocked(runContainer).mockResolvedValue({ status: "success", result: "the answer" });
    const channel = makeChannel();

    const done = await runJob({ channel: channel as never });

    expect(done.result).toBe("the answer");
    expect(insertMessage).toHaveBeenCalledWith("tg-123", "assistant", "the answer");
    expect(channel.sendMessage).toHaveBeenCalledWith("123", "the answer");
    expect(runContainer).toHaveBeenCalledTimes(1);
  });

  it("a delivery failure never re-runs the container (result already persisted)", async () => {
    vi.mocked(runContainer).mockResolvedValue({ status: "success", result: "answer" });
    const channel = makeChannel(async () => { throw new Error("Telegram 429"); });

    const done = await runJob({ channel: channel as never });

    // onComplete still fires — the agent succeeded, delivery is a separate domain
    expect(done.result).toBe("answer");
    expect(runContainer).toHaveBeenCalledTimes(1); // NOT retried
    expect(channel.sendMessage).toHaveBeenCalledTimes(3); // DELIVERY_MAX_RETRIES bounded retry
    expect(insertMessage).toHaveBeenCalledWith("tg-123", "assistant", "answer");
  });

  it("fails the job (no container run) when auth is unavailable, without throwing", async () => {
    vi.mocked(getSecrets).mockRejectedValue(new AuthUnavailableError("no token"));

    const done = await runJob({});

    expect(done.error).toBe("no token");
    expect(runContainer).not.toHaveBeenCalled();
    expect(updateMessageStatus).toHaveBeenCalledWith(1, "failed");
  });

  it("retries a transient container error up to MAX_RETRIES then fails", async () => {
    vi.mocked(runContainer).mockRejectedValue(new Error("container crashed"));

    const done = await runJob({});

    expect(done.error).toMatch(/container crashed/);
    expect(runContainer).toHaveBeenCalledTimes(3); // MAX_RETRIES
    expect(updateMessageStatus).toHaveBeenCalledWith(1, "failed");
  });

  it("does not retry an auth-classified container error", async () => {
    vi.mocked(runContainer).mockRejectedValue(new Error("401 unauthorized"));

    const done = await runJob({});

    expect(done.error).toMatch(/unauthorized/);
    expect(runContainer).toHaveBeenCalledTimes(1); // auth errors are terminal
  });
});
