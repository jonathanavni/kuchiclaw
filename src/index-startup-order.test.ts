import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  channelConstructed: vi.fn(),
  channelConnect: vi.fn(),
  channelDisconnect: vi.fn(),
  channelOnFatalError: vi.fn(),
  ensureGroupFolder: vi.fn(() => ({})),
  execDocker: vi.fn(),
  getOrphanedMessages: vi.fn(),
  getSecrets: vi.fn(),
  quarantineRoot: vi.fn(),
  registerSender: vi.fn(),
  runContainer: vi.fn(),
  runStartupRetention: vi.fn(),
  startPolling: vi.fn(),
  startRetentionSweep: vi.fn(),
  startScheduler: vi.fn(),
  stopPolling: vi.fn(),
  stopRetentionSweep: vi.fn(),
  stopScheduler: vi.fn(),
}));

vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js");
  return {
    ...actual,
    ALLOWED_SENDER_IDS: ["7"],
    MAIN_CHAT_ID: "tg-999",
    MAX_CONTAINERS_PER_GROUP: 1,
    SHUTDOWN_REAP_DRAIN_MS: 20,
    SHUTDOWN_TIMEOUT_MS: 20,
    STUCK_SWEEP_MS: 60_000,
  };
});
vi.mock("./auth.js", async () => {
  const actual = await vi.importActual<typeof import("./auth.js")>("./auth.js");
  return { ...actual, getSecrets: effects.getSecrets };
});
vi.mock("./channels/telegram.js", () => ({
  TelegramChannel: class {
    constructor() { effects.channelConstructed(); }
    connect() { return effects.channelConnect(); }
    disconnect() { return effects.channelDisconnect(); }
    onMessage() {}
    onFatalError(cb: (err: unknown) => void) { effects.channelOnFatalError(cb); }
    sendMessage() { return Promise.resolve(); }
    sendTyping() { return Promise.resolve(); }
  },
}));
vi.mock("./container-runner.js", () => ({ runContainer: effects.runContainer }));
vi.mock("./db.js", () => ({
  IPC_LAYOUT_DB_VERSION: 2,
  formatHistory: vi.fn(() => ""),
  getOrphanedMessages: effects.getOrphanedMessages,
  getRecentMessages: vi.fn(() => []),
  getStuckProcessingMessages: vi.fn(() => []),
  incrementRecoveryCount: vi.fn(() => 1),
  initializeIpcLayoutEpoch: vi.fn(),
  insertMessage: vi.fn(() => 1),
  inspectDbAttestation: vi.fn(),
  updateMessageStatus: vi.fn(),
}));
vi.mock("./docker.js", () => ({ execDocker: effects.execDocker }));
vi.mock("./group-folder.js", () => ({ ensureGroupFolder: effects.ensureGroupFolder }));
vi.mock("./instance-lock.js", () => ({ acquireInstanceLock: effects.acquireLock }));
vi.mock("./ipc.js", () => ({ registerSender: effects.registerSender }));
vi.mock("./ipc-poll.js", () => ({
  quarantineLooseRootRequests: effects.quarantineRoot,
  startPolling: effects.startPolling,
  stopPolling: effects.stopPolling,
}));
vi.mock("./task-scheduler.js", () => ({
  startScheduler: effects.startScheduler,
  stopScheduler: effects.stopScheduler,
}));
vi.mock("./retention.js", () => ({
  runStartupRetention: effects.runStartupRetention,
  startRetentionSweep: effects.startRetentionSweep,
  stopRetentionSweep: effects.stopRetentionSweep,
}));

type IndexModule = typeof import("./index.js");
type QueueModule = typeof import("./group-queue.js");

const ok = (stdout = "") => ({ ok: true, code: 0, stdout, stderr: "", timedOut: false });

let indexModule: IndexModule;
let queueModule: QueueModule;
let roots: string[] = [];
let priorToken: string | undefined;
let listeners: ReturnType<typeof signalListeners>;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useRealTimers();
  roots = [];
  listeners = signalListeners();
  priorToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  effects.releaseLock.mockReset().mockResolvedValue(undefined);
  effects.acquireLock.mockReset().mockResolvedValue({
    host: "127.0.0.1", port: 47671, release: effects.releaseLock,
  });
  effects.channelConnect.mockReset().mockResolvedValue(undefined);
  effects.channelDisconnect.mockReset().mockResolvedValue(undefined);
  effects.execDocker.mockReset().mockResolvedValue(ok());
  effects.getOrphanedMessages.mockReset().mockReturnValue([]);
  effects.getSecrets.mockReset().mockResolvedValue({
    secrets: {}, isApiKeyFallback: false, source: "keychain",
  });
  effects.runContainer.mockReset().mockResolvedValue({ status: "success", result: "ok" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  indexModule = await import("./index.js");
  queueModule = await import("./group-queue.js");
});

afterEach(() => {
  cleanupSignalListeners(listeners);
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (priorToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = priorToken;
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describe("startup gate ordering", () => {
  it("refuses legacy state before lock, Docker, recovery, channel, polling, or scheduler", async () => {
    const root = tempRoot();
    const ipcDir = path.join(root, "ipc");
    fs.mkdirSync(ipcDir);
    fs.writeFileSync(path.join(ipcDir, "legacy.json"), "{}");

    await expect(indexModule.main({
      skipBackoff: true,
      ipcDir,
      markerPath: path.join(root, "ipc-layout-v2"),
      inspectDb: () => ({ exists: true, userVersion: 1, scheduledTaskCount: 1 }),
      initializeEpoch: vi.fn(),
    })).rejects.toThrow(/cutover/);

    // Post-impl F1: the lock is DELIBERATELY acquired before the gate — the
    // gate mutates data/ (fresh-init sentinel/DB/marker, aborted-init unlink),
    // so it may only run under the singleton lock; a refusal releases it.
    expect(effects.acquireLock).toHaveBeenCalledOnce();
    expect(effects.releaseLock).toHaveBeenCalledOnce();
    expect(effects.execDocker).not.toHaveBeenCalled();
    expect(effects.getOrphanedMessages).not.toHaveBeenCalled();
    expect(effects.channelConstructed).not.toHaveBeenCalled();
    expect(effects.startPolling).not.toHaveBeenCalled();
    expect(effects.startScheduler).not.toHaveBeenCalled();
    expect(effects.runStartupRetention).not.toHaveBeenCalled();
  });

  it("runs startup retention after recovery and before the channel connects (post-impl gap)", async () => {
    await indexModule.main(validOptions());

    expect(effects.getOrphanedMessages.mock.invocationCallOrder[0]).toBeLessThan(
      effects.runStartupRetention.mock.invocationCallOrder[0],
    );
    expect(effects.runStartupRetention.mock.invocationCallOrder[0]).toBeLessThan(
      effects.channelConnect.mock.invocationCallOrder[0],
    );
    expect(effects.startRetentionSweep).toHaveBeenCalledOnce();
    await stopStartedMain();
  });

  it("wires the fatal-polling callback before the channel connects (ntba-v2 R3-2)", async () => {
    await indexModule.main(validOptions());

    expect(effects.channelOnFatalError).toHaveBeenCalledOnce();
    expect(effects.channelOnFatalError.mock.invocationCallOrder[0]).toBeLessThan(
      effects.channelConnect.mock.invocationCallOrder[0],
    );
    await stopStartedMain();
  });

  it("a polling fatal during connect() reaches shutdown and producers never start (ntba-v2 R3-2)", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    effects.channelConnect.mockImplementationOnce(async () => {
      const fatal = effects.channelOnFatalError.mock.calls[0]?.[0] as (err: unknown) => void;
      fatal(new Error("409 Conflict: terminated by other getUpdates request"));
    });

    await indexModule.main(validOptions());

    expect(effects.startPolling).not.toHaveBeenCalled();
    expect(effects.startScheduler).not.toHaveBeenCalled();
    expect(effects.startRetentionSweep).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  });

  it("finishes preflight and reap before recovery can start a container", async () => {
    effects.getOrphanedMessages.mockReturnValueOnce([{
      id: 9, group_folder: "tg-123", role: "user", content: "orphan",
      timestamp: "", processing_status: "processing", chat_id: "123",
      sender_name: "A", recovery_count: 0,
    }]);

    await indexModule.main(validOptions());
    await vi.waitFor(() => expect(effects.runContainer).toHaveBeenCalledOnce());

    expect(effects.acquireLock.mock.invocationCallOrder[0]).toBeLessThan(
      effects.execDocker.mock.invocationCallOrder[0],
    );
    expect(effects.execDocker.mock.invocationCallOrder.at(-1)).toBeLessThan(
      effects.runContainer.mock.invocationCallOrder[0],
    );
    await stopStartedMain();
  });
});

describe("shutdown coordination with the real group queue", () => {
  it("reaps on first-drain timeout and waits a bounded second drain before exit", async () => {
    const active = deferred<{ status: "success"; result: string }>();
    effects.runContainer.mockReturnValueOnce(active.promise);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await indexModule.main(validOptions());
    enqueueTestJob("tg-611", 61);
    await vi.waitFor(() => expect(effects.runContainer).toHaveBeenCalledOnce());
    effects.execDocker.mockClear();
    vi.useFakeTimers();

    addedSignalListener("SIGTERM")();
    await vi.advanceTimersByTimeAsync(20);
    expect(effects.execDocker).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    active.resolve({ status: "success", result: "done" });
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("closes acceptance synchronously and runs one coordinator for two containments", async () => {
    const active = deferred<{ status: "success"; result: string }>();
    const disconnect = deferred<void>();
    let lifecycle: { onContainmentFailure?(error: Error): void } | undefined;
    effects.channelDisconnect.mockReturnValueOnce(disconnect.promise);
    effects.runContainer.mockImplementationOnce((_input, _paths, options) => {
      lifecycle = options;
      return active.promise;
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await indexModule.main(validOptions());

    enqueueTestJob("tg-711", 71);
    await vi.waitFor(() => expect(effects.runContainer).toHaveBeenCalledOnce());
    enqueueTestJob("tg-711", 72);

    lifecycle!.onContainmentFailure!(new Error("first death unconfirmed"));
    lifecycle!.onContainmentFailure!(new Error("second death unconfirmed"));
    enqueueTestJob("tg-711", 73);

    expect(effects.stopPolling).toHaveBeenCalledOnce();
    expect(effects.stopScheduler).toHaveBeenCalledOnce();
    expect(effects.channelDisconnect).toHaveBeenCalledOnce();
    expect(effects.stopPolling.mock.invocationCallOrder[0]).toBeLessThan(
      effects.channelDisconnect.mock.invocationCallOrder[0],
    );
    expect(effects.runContainer).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();

    disconnect.resolve();
    active.resolve({ status: "success", result: "preserved" });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(effects.runContainer).toHaveBeenCalledOnce();
    expect(effects.channelDisconnect).toHaveBeenCalledOnce();
  });

  it("upgrades an in-progress signal shutdown to exit 1 on containment", async () => {
    const active = deferred<{ status: "success"; result: string }>();
    const disconnect = deferred<void>();
    let lifecycle: { onContainmentFailure?(error: Error): void } | undefined;
    effects.channelDisconnect.mockReturnValueOnce(disconnect.promise);
    effects.runContainer.mockImplementationOnce((_input, _paths, options) => {
      lifecycle = options;
      return active.promise;
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await indexModule.main(validOptions());
    enqueueTestJob("tg-811", 81);
    await vi.waitFor(() => expect(effects.runContainer).toHaveBeenCalledOnce());

    addedSignalListener("SIGTERM")();
    lifecycle!.onContainmentFailure!(new Error("late containment"));
    disconnect.resolve();
    active.resolve({ status: "success", result: "done" });

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(effects.channelDisconnect).toHaveBeenCalledOnce();
  });

  it("logs instance-lock release failure without escalating a clean exit", async () => {
    effects.releaseLock.mockRejectedValueOnce(new Error("close failed"));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await indexModule.main(validOptions());

    addedSignalListener("SIGTERM")();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Instance lock release failed"),
    );
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function enqueueTestJob(group: string, messageId: number): void {
  queueModule.enqueue({
    group,
    chatId: group.slice(3),
    senderName: "tester",
    text: "hello",
    secrets: {},
    channel: { sendMessage: vi.fn(async () => {}) } as never,
    attempt: 1,
    messageId,
  });
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kuchiclaw-order-"));
  roots.push(root);
  return root;
}

function validOptions() {
  const root = tempRoot();
  const markerPath = path.join(root, "ipc-layout-v2");
  fs.writeFileSync(markerPath, "");
  return {
    skipBackoff: true,
    mainChatId: "tg-999",
    allowedSenderIds: ["7"],
    ipcDir: path.join(root, "ipc"),
    markerPath,
    inspectDb: () => ({ exists: true, userVersion: 2, scheduledTaskCount: 0 }),
    initializeEpoch: vi.fn(),
  };
}

function signalListeners() {
  return {
    SIGINT: process.listeners("SIGINT").slice(),
    SIGTERM: process.listeners("SIGTERM").slice(),
  };
}

function addedSignalListener(signal: "SIGINT" | "SIGTERM") {
  return process.listeners(signal).find((listener) => !listeners[signal].includes(listener)) as () => void;
}

function cleanupSignalListeners(before: ReturnType<typeof signalListeners>) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.listeners(signal)) {
      if (!before[signal].includes(listener)) process.removeListener(signal, listener);
    }
  }
}

async function stopStartedMain() {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  addedSignalListener("SIGTERM")();
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
}
