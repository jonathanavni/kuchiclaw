import { describe, it, expect, beforeEach, vi } from "vitest";

// Fast retry delays so the retry/backoff paths don't make the suite slow.
vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js");
  return { ...actual, BASE_RETRY_MS: 1, DELIVERY_BASE_MS: 1, MAX_CONTAINERS_PER_GROUP: 1 };
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
import { assertDestinationAllowed } from "./ipc-auth.js";
import { ContainerTerminationUnknownError } from "./container-errors.js";
import { configureLifecycle, enqueue, isMessageInFlight, shutdown } from "./group-queue.js";

/** A promise plus its resolve, for gating async mocks in concurrency tests. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

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
  configureLifecycle({ owner: "orchestrator" });
});

describe("group-queue executeJob", () => {
  it("persists the result, then marks done, then sends — in that order", async () => {
    vi.mocked(runContainer).mockResolvedValue({ status: "success", result: "the answer" });
    const channel = makeChannel();

    const done = await runJob({ channel: channel as never });

    expect(done.result).toBe("the answer");
    expect(insertMessage).toHaveBeenCalledWith("tg-123", "assistant", "the answer");
    expect(channel.sendMessage).toHaveBeenCalledWith("123", "the answer");
    expect(runContainer).toHaveBeenCalledTimes(1);

    // Ordering guards the silent-drop fix: the assistant result must be stored
    // before the user message is marked done, and done before the send.
    const insertOrder = vi.mocked(insertMessage).mock.invocationCallOrder[0];
    const doneCall = vi.mocked(updateMessageStatus).mock.calls.findIndex((c) => c[1] === "done");
    const doneOrder = vi.mocked(updateMessageStatus).mock.invocationCallOrder[doneCall];
    const sendOrder = channel.sendMessage.mock.invocationCallOrder[0];
    expect(insertOrder).toBeLessThan(doneOrder);
    expect(doneOrder).toBeLessThan(sendOrder);
  });

  it("does not mark the user message done if persisting the result throws", async () => {
    vi.mocked(runContainer).mockResolvedValue({ status: "success", result: "x" });
    vi.mocked(insertMessage).mockImplementationOnce(() => { throw new Error("db down"); });

    // The job rejects/settles; assert the user message was never marked done
    // (so crash recovery can still replay it — no silent drop).
    await new Promise<void>((resolve) => {
      enqueue({
        group: "tg-123", chatId: "123", senderName: "t", text: "x", secrets: {},
        channel: makeChannel() as never, attempt: 1, messageId: 5,
        onComplete: () => resolve(), onError: () => resolve(),
      });
      setTimeout(resolve, 50);
    });
    const doneMarked = vi.mocked(updateMessageStatus).mock.calls.some((c) => c[0] === 5 && c[1] === "done");
    expect(doneMarked).toBe(false);
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

  it("does not retry termination-unknown and releases the message slot exactly once", async () => {
    vi.mocked(runContainer).mockRejectedValue(
      new ContainerTerminationUnknownError("death unconfirmed"),
    );
    const onError = vi.fn();

    const done = await new Promise<{ error: string }>((resolve) => {
      enqueue({
        group: "tg-123", chatId: "123", senderName: "tester", text: "hello",
        secrets: {}, channel: makeChannel() as never, attempt: 1, messageId: 41,
        onError: (error) => { onError(error); resolve({ error }); },
      });
    });

    expect(done.error).toBe("death unconfirmed");
    expect(runContainer).toHaveBeenCalledTimes(1);
    expect(updateMessageStatus).toHaveBeenCalledWith(41, "failed");
    expect(onError).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(isMessageInFlight(41)).toBe(false));
  });

  it("keeps a message in-flight while the runner is terminating", async () => {
    const terminating = deferred<{ status: "success"; result: string }>();
    vi.mocked(runContainer).mockReturnValueOnce(terminating.promise);
    const done = runJob({ messageId: 42 });

    await vi.waitFor(() => expect(runContainer).toHaveBeenCalledOnce());
    expect(isMessageInFlight(42)).toBe(true);

    terminating.resolve({ status: "success", result: "safe" });
    await done;
    await vi.waitFor(() => expect(isMessageInFlight(42)).toBe(false));
  });

  it("checks destination identity FIRST — before auth, container, or reply", async () => {
    vi.mocked(assertDestinationAllowed).mockImplementationOnce(() => { throw new Error("denied"); });
    const channel = makeChannel();

    const done = await new Promise<{ error?: string }>((resolve) => {
      enqueue({
        group: "tg-123", chatId: "999", senderName: "t", text: "x", secrets: {},
        channel: channel as never, attempt: 1, messageId: 7,
        onError: (error) => resolve({ error }),
      });
    });

    expect(done.error).toMatch(/denied/);
    expect(getSecrets).not.toHaveBeenCalled();
    expect(runContainer).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(updateMessageStatus).toHaveBeenCalledWith(7, "failed");
  });

  it("never runs more than MAX_CONTAINERS_PER_GROUP containers at once for a group", async () => {
    // Gate every container run so we can inspect the in-flight count.
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    let started = 0;
    let peak = 0;
    let inFlight = 0;
    vi.mocked(runContainer).mockImplementation(async () => {
      inFlight++; peak = Math.max(peak, inFlight);
      await gates[started++].promise;
      inFlight--;
      return { status: "success", result: "ok" };
    });

    const channel = makeChannel();
    const base = {
      group: "tg-123", chatId: "123", senderName: "t", text: "x",
      secrets: {}, channel: channel as never, attempt: 1,
    };
    enqueue({ ...base, messageId: 1 });
    enqueue({ ...base, messageId: 2 });
    enqueue({ ...base, messageId: 3 });

    // Let the queue drain to its cap.
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(1); // cap = 1 (mocked); the rest wait

    // Release each running job so the queue advances one slot at a time.
    gates[0].resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(2);
    gates[1].resolve();
    await new Promise((r) => setTimeout(r, 20));
    gates[2].resolve();
    await new Promise((r) => setTimeout(r, 20));

    expect(peak).toBe(1);
    expect(started).toBe(3);
  });

  it("shutdown closes acceptance and discards a queued same-group job", async () => {
    const first = deferred<void>();
    vi.mocked(runContainer).mockImplementationOnce(async () => {
      await first.promise;
      return { status: "success", result: "first" };
    });
    const channel = makeChannel();
    const base = {
      group: "tg-shutdown", chatId: "123", senderName: "t", text: "x",
      secrets: {}, channel: channel as never, attempt: 1,
    };

    enqueue({ ...base, messageId: 51 });
    enqueue({ ...base, messageId: 52 });
    await vi.waitFor(() => expect(runContainer).toHaveBeenCalledOnce());

    const finished = shutdown();
    enqueue({ ...base, messageId: 53 });
    first.resolve();
    await finished;

    expect(runContainer).toHaveBeenCalledOnce();
  });
});
