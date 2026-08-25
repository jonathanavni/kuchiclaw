import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContainerTerminationUnknownError } from "./container-errors.js";
import type { GroupPaths } from "./group-folder.js";

const runnerConfig = vi.hoisted(() => ({
  CONTAINER_CPUS: undefined as string | undefined,
  CONTAINER_IMAGE: "test-image",
  CONTAINER_MEMORY: undefined as string | undefined,
  CONTAINER_PIDS_LIMIT: "256" as string | undefined,
  CONTAINER_TIMEOUT_MS: 100,
  OUTPUT_END_MARKER: "---END---",
  OUTPUT_START_MARKER: "---START---",
  TERMINATION_DRAIN_MS: 50,
}));
vi.mock("./config.js", () => runnerConfig);

const docker = vi.hoisted(() => ({ spawnDocker: vi.fn(), execDocker: vi.fn() }));
vi.mock("./docker.js", () => docker);
const updateOAuthData = vi.hoisted(() => vi.fn());
vi.mock("./oauth-refresh.js", () => ({ updateOAuthData }));

import { runContainer } from "./container-runner.js";

const ok = { ok: true, code: 0, stdout: "", stderr: "", timedOut: false };
const output = (extra: Record<string, unknown> = {}) =>
  `noise---START---${JSON.stringify({ status: "success", result: "done", ...extra })}---END---`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fakeChild() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn(() => true);
  return proc;
}

function track<T>(promise: Promise<T>) {
  let settlements = 0;
  promise.then(() => { settlements++; }, () => { settlements++; });
  return { promise, settlements: () => settlements };
}

async function fireTimeout() {
  await vi.advanceTimersByTimeAsync(100);
}

let proc: ReturnType<typeof fakeChild>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  runnerConfig.CONTAINER_CPUS = undefined;
  runnerConfig.CONTAINER_MEMORY = undefined;
  runnerConfig.CONTAINER_PIDS_LIMIT = "256";
  proc = fakeChild();
  docker.spawnDocker.mockReturnValue(proc);
  docker.execDocker.mockResolvedValue(ok);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runContainer timeout state machine — D2 matrix", () => {
  it("close-before-kill settles once and never starts termination", async () => {
    const tracked = track(runContainer(input(), undefined, { owner: "orchestrator" }));
    proc.stdout.emit("data", output());
    proc.emit("close", 0);

    await expect(tracked.promise).resolves.toMatchObject({ status: "success", result: "done" });
    await fireTimeout();
    expect(docker.execDocker).not.toHaveBeenCalled();
    expect(tracked.settlements()).toBe(1);
  });

  it("close-during-kill is recorded until kill adjudication, then settles once", async () => {
    const kill = deferred<typeof ok>();
    docker.execDocker.mockReturnValueOnce(kill.promise);
    const tracked = track(runContainer(input(), undefined, { owner: "orchestrator" }));
    await fireTimeout();
    proc.emit("close", 137);
    expect(tracked.settlements()).toBe(0);
    kill.resolve(ok);

    await expect(tracked.promise).rejects.toThrow(/timed out/);
    expect(tracked.settlements()).toBe(1);
  });

  it("benign-nonzero-kill confirms death without inspect and settles once", async () => {
    docker.execDocker.mockResolvedValueOnce({
      ok: false, code: 1, stdout: "", stderr: "No such container: gone", timedOut: false,
    });
    const tracked = track(runContainer(input(), undefined, { owner: "orchestrator" }));
    await fireTimeout();
    proc.emit("close", 1);

    await expect(tracked.promise).rejects.toThrow(/timed out/);
    expect(docker.execDocker).toHaveBeenCalledTimes(1);
    expect(tracked.settlements()).toBe(1);
  });

  it("kill-timeout+confirm-absent is retryable and settles once", async () => {
    docker.execDocker
      .mockResolvedValueOnce({ ok: false, code: null, stdout: "", stderr: "", timedOut: true })
      .mockResolvedValueOnce({
        ok: false,
        code: 1,
        stdout: "",
        stderr: "Error: No such object: kuchiclaw-tg-123",
        timedOut: false,
      });
    const containment = vi.fn();
    const tracked = track(runContainer(input(), undefined, {
      owner: "orchestrator", onContainmentFailure: containment,
    }));
    await fireTimeout();
    proc.emit("close", 137);

    await expect(tracked.promise).rejects.toThrow(/timed out/);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(proc.kill.mock.invocationCallOrder[0]).toBeLessThan(
      docker.execDocker.mock.invocationCallOrder[1],
    );
    expect(containment).not.toHaveBeenCalled();
    expect(tracked.settlements()).toBe(1);
  });

  it("kill-timeout+confirm-stopped is retryable without containment", async () => {
    docker.execDocker
      .mockResolvedValueOnce({ ok: false, code: null, stdout: "", stderr: "", timedOut: true })
      .mockResolvedValueOnce({ ...ok, stdout: "false\n" });
    const containment = vi.fn();
    const tracked = track(runContainer(input(), undefined, {
      owner: "orchestrator", onContainmentFailure: containment,
    }));
    await fireTimeout();
    proc.emit("close", 137);

    await expect(tracked.promise).rejects.toThrow(/timed out/);
    expect(containment).not.toHaveBeenCalled();
    expect(tracked.settlements()).toBe(1);
  });

  it("kill-timeout+confirm-running raises containment and settles once", async () => {
    docker.execDocker
      .mockResolvedValueOnce({ ok: false, code: null, stdout: "", stderr: "", timedOut: true })
      .mockResolvedValueOnce({ ...ok, stdout: "true\n" });
    const containment = vi.fn();
    const tracked = track(runContainer(input(), undefined, {
      owner: "orchestrator", onContainmentFailure: containment,
    }));
    await fireTimeout();
    proc.emit("close", 137);

    await expect(tracked.promise).rejects.toBeInstanceOf(ContainerTerminationUnknownError);
    expect(containment).toHaveBeenCalledOnce();
    expect(tracked.settlements()).toBe(1);
  });

  it("late-stdout-after-kill waits for close before parsing and settles once", async () => {
    const tracked = track(runContainer(input(), undefined, { owner: "orchestrator" }));
    await fireTimeout();
    expect(tracked.settlements()).toBe(0);
    proc.stdout.emit("data", output());
    proc.emit("close", 137);

    await expect(tracked.promise).resolves.toMatchObject({ result: "done" });
    expect(tracked.settlements()).toBe(1);
  });

  it("drain-bound-expiry kills the attach client and settles once", async () => {
    const tracked = track(runContainer(input(), undefined, { owner: "orchestrator" }));
    await fireTimeout();
    await vi.advanceTimersByTimeAsync(50);

    await expect(tracked.promise).rejects.toThrow(/timed out/);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(tracked.settlements()).toBe(1);
  });

  it("output-before-timeout is success and persists newTokens exactly once", async () => {
    const newTokens = { accessToken: "a", refreshToken: "r", expiresAt: 123 };
    const tracked = track(runContainer(input(), undefined, { owner: "orchestrator" }));
    proc.stdout.emit("data", output({
      newTokens,
      warnings: ["refused secret key: TIMEOUT_SECRET"],
    }));
    await fireTimeout();
    proc.emit("close", 137);

    await expect(tracked.promise).resolves.toMatchObject({ result: "done", newTokens });
    expect(updateOAuthData).toHaveBeenCalledOnce();
    expect(updateOAuthData).toHaveBeenCalledWith(newTokens);
    expect(console.warn).toHaveBeenCalledWith(
      "[Container] refused secret key: TIMEOUT_SECRET",
    );
    expect(tracked.settlements()).toBe(1);
  });

  it("updateOAuthData throw during finalization is logged and still settles once", async () => {
    updateOAuthData.mockImplementationOnce(() => { throw new Error("ENOSPC"); });
    const tracked = track(runContainer(input(), undefined, { owner: "orchestrator" }));
    proc.stdout.emit("data", output({
      newTokens: { accessToken: "a", refreshToken: "r", expiresAt: 123 },
    }));
    await fireTimeout();
    proc.emit("close", 137);

    await expect(tracked.promise).resolves.toMatchObject({ result: "done" });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("ENOSPC"));
    expect(tracked.settlements()).toBe(1);
  });

  it("valid-output+death-unconfirmed resolves, then raises containment, exactly once", async () => {
    docker.execDocker
      .mockResolvedValueOnce({ ok: false, code: null, stdout: "", stderr: "", timedOut: true })
      .mockResolvedValueOnce({ ...ok, stdout: "true" });
    const containment = vi.fn();
    const tracked = track(runContainer(input(), undefined, {
      owner: "orchestrator", onContainmentFailure: containment,
    }));
    proc.stdout.emit("data", output());
    await fireTimeout();
    proc.emit("close", 137);

    await expect(tracked.promise).resolves.toMatchObject({ result: "done" });
    expect(containment).toHaveBeenCalledOnce();
    expect(tracked.settlements()).toBe(1);
  });

  it("logs containment details when no lifecycle handler is registered", async () => {
    docker.execDocker
      .mockResolvedValueOnce({ ok: false, code: null, stdout: "", stderr: "", timedOut: true })
      .mockResolvedValueOnce({ ...ok, stdout: "true" });
    const tracked = track(runContainer(input(), undefined, { owner: "cli" }));
    await fireTimeout();
    proc.emit("close", 137);

    await expect(tracked.promise).rejects.toBeInstanceOf(ContainerTerminationUnknownError);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/Containment failure:.*kuchiclaw-tg-123.*could not be confirmed/),
    );
  });
});

describe("runContainer structured warnings", () => {
  it.each(["success", "error"] as const)("logs warnings on normal %s output", async (status) => {
    const promise = runContainer(input(), undefined, { owner: "orchestrator" });
    proc.stdout.emit("data", output({
      status,
      ...(status === "error" ? { error: "agent stopped" } : {}),
      warnings: ["refused secret key: UNKNOWN_SECRET"],
    }));
    proc.emit("close", status === "success" ? 0 : 1);

    await expect(promise).resolves.toMatchObject({ status });
    expect(console.warn).toHaveBeenCalledWith(
      "[Container] refused secret key: UNKNOWN_SECRET",
    );
  });

  it("logs at most 20 warnings from one output", async () => {
    const promise = runContainer(input(), undefined, { owner: "orchestrator" });
    proc.stdout.emit("data", output({
      warnings: Array.from({ length: 25 }, (_, index) => `warning-${index}`),
    }));
    proc.emit("close", 0);

    await promise;
    expect(console.warn).toHaveBeenCalledTimes(20);
    expect(console.warn).toHaveBeenNthCalledWith(20, "[Container] warning-19");
    expect(console.warn).not.toHaveBeenCalledWith("[Container] warning-20");
  });

  it("sanitizes newlines, control characters, and ANSI escapes", async () => {
    const promise = runContainer(input(), undefined, { owner: "orchestrator" });
    proc.stdout.emit("data", output({
      warnings: ["line1\n\u001b[31mred\u001b[0m\tend\u007f"],
    }));
    proc.emit("close", 0);

    await promise;
    expect(console.warn).toHaveBeenCalledWith("[Container] line1  red  end ");
  });

  it("truncates each warning to 200 sanitized characters", async () => {
    const promise = runContainer(input(), undefined, { owner: "orchestrator" });
    proc.stdout.emit("data", output({ warnings: ["x".repeat(250)] }));
    proc.emit("close", 0);

    await promise;
    expect(console.warn).toHaveBeenCalledWith(`[Container] ${"x".repeat(200)}`);
  });
});

describe("runContainer argv", () => {
  it("uses bind mounts, hardening defaults, owner labels, and distinct same-ms names", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kuchiclaw-runner-"));
    const paths = makePaths(root);
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    const secretValue = "must-not-appear-in-argv";
    const first = runContainer(
      { ...input(), secrets: { API_TOKEN: secretValue } },
      paths,
      { owner: "orchestrator" },
    );
    const firstProc = proc;
    const secondProc = fakeChild();
    docker.spawnDocker.mockReturnValueOnce(secondProc);
    const second = runContainer(input(), paths, { owner: "cli" });
    const calls = docker.spawnDocker.mock.calls.map((call: unknown[]) => call[0] as string[]);

    expect(calls[0]).toEqual(expect.arrayContaining([
      "--init", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--pids-limit", "256",
      "--label", "kuchiclaw.owner=orchestrator",
    ]));
    expect(calls[1]).toEqual(expect.arrayContaining(["--label", "kuchiclaw.owner=cli"]));
    expect(calls[0]).not.toContain("-v");
    const mounts = calls[0].filter((arg) => arg.startsWith("type=bind,"));
    const mountFor = (destination: string) => mounts.find((arg) => arg.includes(`dst=${destination}`));
    for (const destination of [
      "/workspace/SOUL.md",
      "/workspace/TOOLS.md",
      "/workspace/skills",
      "/workspace/HEARTBEAT.md",
    ]) {
      expect(mountFor(destination)).toContain(",readonly");
    }
    for (const destination of ["/workspace/MEMORY.md", "/workspace/CONTEXT.md", "/workspace/ipc"]) {
      expect(mountFor(destination)).not.toContain(",readonly");
    }
    expect(calls[0].some((arg) => arg.includes(secretValue))).toBe(false);
    const firstName = calls[0][calls[0].indexOf("--name") + 1];
    const secondName = calls[1][calls[1].indexOf("--name") + 1];
    expect(firstName).toMatch(/^kuchiclaw-tg-123-1234-[a-f0-9]{8}$/);
    expect(secondName).not.toBe(firstName);

    firstProc.stdout.emit("data", output());
    firstProc.emit("close", 0);
    secondProc.stdout.emit("data", output());
    secondProc.emit("close", 0);
    await Promise.all([first, second]);
    now.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("adds opt-in CPU/memory flags and allows the pids limit to be disabled", async () => {
    runnerConfig.CONTAINER_CPUS = "0.5";
    runnerConfig.CONTAINER_MEMORY = "128m";
    runnerConfig.CONTAINER_PIDS_LIMIT = undefined;
    const promise = runContainer(input(), undefined, { owner: "cli" });
    const args = docker.spawnDocker.mock.calls[0][0] as string[];

    expect(args).toEqual(expect.arrayContaining(["--cpus", "0.5", "--memory", "128m"]));
    expect(args).not.toContain("--pids-limit");
    proc.stdout.emit("data", output());
    proc.emit("close", 0);
    await promise;
  });

  it("rejects a missing mount source with the exact path before spawn", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kuchiclaw-runner-"));
    const paths = makePaths(root);
    fs.unlinkSync(paths.memory);

    await expect(runContainer(input(), paths, { owner: "cli" })).rejects.toThrow(paths.memory);
    expect(docker.spawnDocker).not.toHaveBeenCalled();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("rejects symlink mount sources", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kuchiclaw-runner-"));
    const paths = makePaths(root);
    fs.unlinkSync(paths.memory);
    fs.symlinkSync(paths.context, paths.memory);

    await expect(runContainer(input(), paths, { owner: "cli" })).rejects.toThrow(/must not be a symlink/);
    expect(docker.spawnDocker).not.toHaveBeenCalled();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

function input() {
  return { prompt: "hello", groupFolder: "tg-123", secrets: {} };
}

function makePaths(root: string): GroupPaths {
  const result = {
    root: path.join(root, "group"),
    memory: path.join(root, "MEMORY.md"),
    context: path.join(root, "CONTEXT.md"),
    logs: path.join(root, "logs"),
    soul: path.join(root, "SOUL.md"),
    tools: path.join(root, "TOOLS.md"),
    ipc: path.join(root, "ipc"),
    skills: path.join(root, "skills"),
    heartbeat: path.join(root, "HEARTBEAT.md"),
    outRoot: path.join(root, "out"),
  };
  fs.mkdirSync(result.root);
  fs.mkdirSync(result.logs);
  fs.mkdirSync(result.ipc);
  fs.mkdirSync(result.skills);
  fs.mkdirSync(result.outRoot);
  for (const file of [result.memory, result.context, result.soul, result.tools, result.heartbeat]) {
    fs.writeFileSync(file, "test");
  }
  return result;
}
