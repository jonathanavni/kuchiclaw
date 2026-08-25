import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContainerTerminationUnknownError } from "./container-errors.js";

const effects = vi.hoisted(() => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  channelConstructed: vi.fn(),
  channelConnect: vi.fn(),
  channelDisconnect: vi.fn(),
  configureLifecycle: vi.fn(),
  enqueue: vi.fn(),
  execDocker: vi.fn(),
  getOrphanedMessages: vi.fn(),
  getSecrets: vi.fn(),
  quarantineRoot: vi.fn(),
  registerSender: vi.fn(),
  shutdownQueue: vi.fn(),
  startPolling: vi.fn(),
  startScheduler: vi.fn(),
  stopPolling: vi.fn(),
  stopScheduler: vi.fn(),
}));

vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js");
  return {
    ...actual,
    ALLOWED_SENDER_IDS: ["7"],
    MAIN_CHAT_ID: "tg-999",
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
    sendMessage() { return Promise.resolve(); }
    sendTyping() { return Promise.resolve(); }
  },
}));
vi.mock("./db.js", () => ({
  IPC_LAYOUT_DB_VERSION: 2,
  getOrphanedMessages: effects.getOrphanedMessages,
  getStuckProcessingMessages: vi.fn(() => []),
  incrementRecoveryCount: vi.fn(() => 1),
  initializeIpcLayoutEpoch: vi.fn(),
  insertMessage: vi.fn(() => 1),
  inspectDbAttestation: vi.fn(),
  updateMessageStatus: vi.fn(),
}));
vi.mock("./group-queue.js", () => ({
  configureLifecycle: effects.configureLifecycle,
  enqueue: effects.enqueue,
  isMessageInFlight: vi.fn(() => false),
  shutdown: effects.shutdownQueue,
}));
vi.mock("./docker.js", () => ({ execDocker: effects.execDocker }));
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

import { main, preflightDocker, reapOrchestratorContainers } from "./index.js";

const ok = (stdout = "") => ({ ok: true, code: 0, stdout, stderr: "", timedOut: false });
const bad = (stderr = "docker failed") => ({
  ok: false, code: 1, stdout: "", stderr, timedOut: false,
});

let roots: string[] = [];
let priorToken: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  roots = [];
  priorToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  effects.releaseLock.mockResolvedValue(undefined);
  effects.acquireLock.mockResolvedValue({ port: 47671, release: effects.releaseLock });
  effects.channelConnect.mockResolvedValue(undefined);
  effects.channelDisconnect.mockResolvedValue(undefined);
  effects.getSecrets.mockResolvedValue({ secrets: {}, isApiKeyFallback: false });
  effects.getOrphanedMessages.mockReturnValue([]);
  effects.shutdownQueue.mockResolvedValue(undefined);
  effects.execDocker.mockResolvedValue(ok());
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
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

    await expect(main({
      skipBackoff: true,
      ipcDir,
      markerPath: path.join(root, "ipc-layout-v2"),
      inspectDb: () => ({ exists: true, userVersion: 1, scheduledTaskCount: 1 }),
      initializeEpoch: vi.fn(),
    })).rejects.toThrow(/cutover/);

    expect(effects.acquireLock).not.toHaveBeenCalled();
    expect(effects.execDocker).not.toHaveBeenCalled();
    expect(effects.getOrphanedMessages).not.toHaveBeenCalled();
    expect(effects.channelConstructed).not.toHaveBeenCalled();
    expect(effects.startPolling).not.toHaveBeenCalled();
    expect(effects.startScheduler).not.toHaveBeenCalled();
  });

  it("finishes preflight and reap before recovery can re-enqueue", async () => {
    effects.getOrphanedMessages.mockReturnValueOnce([{
      id: 9, group_folder: "tg-123", role: "user", content: "orphan",
      timestamp: "", processing_status: "processing", chat_id: "123",
      sender_name: "A", recovery_count: 0,
    }]);

    const listeners = signalListeners();
    await main(validOptions());

    expect(effects.enqueue).toHaveBeenCalledOnce();
    expect(effects.acquireLock.mock.invocationCallOrder[0]).toBeLessThan(
      effects.execDocker.mock.invocationCallOrder[0],
    );
    const finalDockerOrder = effects.execDocker.mock.invocationCallOrder.at(-1)!;
    expect(finalDockerOrder).toBeLessThan(effects.getOrphanedMessages.mock.invocationCallOrder[0]);
    await stopStartedMain(listeners);
  });
});

describe("fail-closed legacy-aware reap", () => {
  it("aborts on first ps failure", async () => {
    effects.execDocker.mockResolvedValueOnce(bad("daemon unavailable"));
    await expect(reapOrchestratorContainers()).rejects.toThrow(/unverifiable IDs.*unknown/);
    expect(effects.execDocker).toHaveBeenCalledOnce();
  });

  it("aborts on rm failure and names the target", async () => {
    effects.execDocker
      .mockResolvedValueOnce(ok("aaaaaaaaaaaa\n"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(bad("permission denied"));
    await expect(reapOrchestratorContainers()).rejects.toThrow(/aaaaaaaaaaaa/);
  });

  it("aborts on final ps failure", async () => {
    effects.execDocker
      .mockResolvedValueOnce(ok("aaaaaaaaaaaa\n"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(bad("final enumeration failed"));
    await expect(reapOrchestratorContainers()).rejects.toThrow(/unverifiable IDs.*unknown/);
  });

  it("aborts and names a container that survives the final enumeration", async () => {
    effects.execDocker
      .mockResolvedValueOnce(ok("aaaaaaaaaaaa\n"))
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok("aaaaaaaaaaaa\n"))
      .mockResolvedValueOnce(ok());
    await expect(reapOrchestratorContainers()).rejects.toThrow(/incomplete.*aaaaaaaaaaaa/);
  });

  it("removes unlabeled legacy containers but leaves CLI-labeled containers untouched", async () => {
    let namedCalls = 0;
    effects.execDocker.mockImplementation(async (args: string[]) => {
      if (args[0] === "ps" && args.includes("label=kuchiclaw.owner=orchestrator")) return ok();
      if (args[0] === "ps") {
        namedCalls++;
        return ok(namedCalls === 1 ? "aaaaaaaaaaaa\nbbbbbbbbbbbb\n" : "bbbbbbbbbbbb\n");
      }
      if (args[0] === "inspect" && args.at(-1) === "aaaaaaaaaaaa") return ok("null\n");
      if (args[0] === "inspect") return ok('{"kuchiclaw.owner":"cli"}\n');
      if (args[0] === "rm") return ok();
      return bad("unexpected command");
    });

    await reapOrchestratorContainers();

    expect(effects.execDocker).toHaveBeenCalledWith(["rm", "--force", "aaaaaaaaaaaa"]);
    expect(effects.execDocker).not.toHaveBeenCalledWith(["rm", "--force", "bbbbbbbbbbbb"]);
  });
});

describe("Docker startup preflight", () => {
  it("fails actionably when the daemon version check fails", async () => {
    effects.execDocker.mockResolvedValueOnce(bad("cannot connect"));
    await expect(preflightDocker()).rejects.toThrow(/Docker daemon preflight failed.*reachable/);
    expect(effects.execDocker).toHaveBeenCalledOnce();
  });

  it("fails actionably when the configured image is absent", async () => {
    effects.execDocker.mockResolvedValueOnce(ok()).mockResolvedValueOnce(bad("No such image"));
    await expect(preflightDocker()).rejects.toThrow(/Docker image preflight failed.*build or pull/);
  });
});

describe("shutdown coordination", () => {
  it("reaps on first-drain timeout and waits a bounded second drain before exit", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    effects.shutdownQueue.mockReturnValueOnce(finished);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const listeners = signalListeners();
    await main(validOptions());
    effects.execDocker.mockClear();

    addedSignalListener("SIGTERM", listeners)();
    await vi.advanceTimersByTimeAsync(20);
    expect(effects.execDocker).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(0);
    cleanupSignalListeners(listeners);
  });

  it("composes synchronous queue closure, deferred disconnect, active settle, and monotonic exit 1", async () => {
    let disconnect!: () => void;
    effects.channelDisconnect.mockReturnValueOnce(new Promise<void>((resolve) => { disconnect = resolve; }));
    let settleActive!: () => void;
    const active = new Promise<void>((resolve) => { settleActive = resolve; });
    let accepting = true;
    let queuedSameGroup = 1;
    const runContainer = vi.fn(() => active);
    runContainer(); // triggering active job
    effects.shutdownQueue.mockImplementationOnce(() => {
      accepting = false;
      queuedSameGroup = 0;
      return active;
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const listeners = signalListeners();
    await main(validOptions());
    const lifecycle = effects.configureLifecycle.mock.calls[0][0] as {
      onContainmentFailure(error: ContainerTerminationUnknownError): void;
    };

    lifecycle.onContainmentFailure(new ContainerTerminationUnknownError("first"));
    lifecycle.onContainmentFailure(new ContainerTerminationUnknownError("second"));
    expect(accepting).toBe(false);
    expect(queuedSameGroup).toBe(0);
    expect(effects.stopPolling).toHaveBeenCalledOnce();
    expect(effects.shutdownQueue.mock.invocationCallOrder[0]).toBeLessThan(
      effects.channelDisconnect.mock.invocationCallOrder[0],
    );
    expect(effects.stopPolling.mock.invocationCallOrder[0]).toBeLessThan(
      effects.channelDisconnect.mock.invocationCallOrder[0],
    );
    expect(runContainer).toHaveBeenCalledOnce();
    expect(exit).not.toHaveBeenCalled();

    disconnect();
    settleActive();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(runContainer).toHaveBeenCalledOnce();
    cleanupSignalListeners(listeners);
  });

  it("upgrades an in-progress signal shutdown to exit 1 on containment", async () => {
    let disconnect!: () => void;
    effects.channelDisconnect.mockReturnValueOnce(new Promise<void>((resolve) => { disconnect = resolve; }));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const listeners = signalListeners();
    await main(validOptions());
    const lifecycle = effects.configureLifecycle.mock.calls[0][0] as {
      onContainmentFailure(error: ContainerTerminationUnknownError): void;
    };

    addedSignalListener("SIGTERM", listeners)();
    lifecycle.onContainmentFailure(new ContainerTerminationUnknownError("late containment"));
    disconnect();

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(effects.shutdownQueue).toHaveBeenCalledOnce();
    cleanupSignalListeners(listeners);
  });
});

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

function addedSignalListener(signal: "SIGINT" | "SIGTERM", before: ReturnType<typeof signalListeners>) {
  return process.listeners(signal).find((listener) => !before[signal].includes(listener)) as () => void;
}

function cleanupSignalListeners(before: ReturnType<typeof signalListeners>) {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    for (const listener of process.listeners(signal)) {
      if (!before[signal].includes(listener)) process.removeListener(signal, listener);
    }
  }
}

async function stopStartedMain(before: ReturnType<typeof signalListeners>) {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  addedSignalListener("SIGTERM", before)();
  await vi.waitFor(() => expect(exit).toHaveBeenCalled());
  cleanupSignalListeners(before);
}
