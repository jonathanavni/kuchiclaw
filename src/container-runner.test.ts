import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContainerTerminationUnknownError, OutputVerificationError } from "./container-errors.js";
import type { GroupPaths } from "./group-folder.js";

const runnerConfig = vi.hoisted(() => ({
  CONTAINER_CPUS: undefined as string | undefined,
  CONTAINER_IMAGE: "test-image",
  CONTAINER_MEMORY: undefined as string | undefined,
  CONTAINER_PIDS_LIMIT: "256" as string | undefined,
  CONTAINER_TIMEOUT_MS: 100,
  TERMINATION_DRAIN_MS: 50,
  CONTAINER_OUTPUT_DIR: "/workspace/.out",
  RESULT_FILENAME: "result.json",
  RESULT_TMP_FILENAME: "result.json.tmp",
  RESULT_ENVELOPE_VERSION: 1,
  MAX_OUTPUT_BYTES: 2 * 1024 * 1024,
  MAX_DIAGNOSTIC_BYTES: 256,
}));
vi.mock("./config.js", () => runnerConfig);

const docker = vi.hoisted(() => ({ spawnDocker: vi.fn(), execDocker: vi.fn() }));
vi.mock("./docker.js", () => docker);
const updateOAuthData = vi.hoisted(() => vi.fn());
vi.mock("./oauth-refresh.js", () => ({ updateOAuthData }));

import { runContainer } from "./container-runner.js";

const ok = { ok: true, code: 0, stdout: "", stderr: "", timedOut: false };

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

// Locate the spawn call that returned this proc, and recover the per-run output
// dir + signing key the runner generated (the key rides the stdin JSON).
function runInfo(procObj: ReturnType<typeof fakeChild>) {
  const idx = docker.spawnDocker.mock.results.findIndex((r) => r.value === procObj);
  const args = docker.spawnDocker.mock.calls[idx][0] as string[];
  const name = args[args.indexOf("--name") + 1];
  const input = JSON.parse(procObj.stdin.write.mock.calls[0][0] as string) as { outputKey: string };
  return { runDir: path.join(paths.outRoot, name), key: input.outputKey };
}

/** Emulate the container writing a correctly-signed result file. */
function writeSigned(procObj: ReturnType<typeof fakeChild>, extra: Record<string, unknown> = {}) {
  const { runDir, key } = runInfo(procObj);
  const payload = JSON.stringify({ status: "success", result: "done", ...extra });
  const hmac = createHmac("sha256", Buffer.from(key, "hex")).update(payload, "utf8").digest("hex");
  fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({ v: 1, hmac, payload }));
}

/** Write arbitrary bytes to the result path (forged / malformed cases). */
function writeRawResult(procObj: ReturnType<typeof fakeChild>, contents: string) {
  const { runDir } = runInfo(procObj);
  fs.writeFileSync(path.join(runDir, "result.json"), contents);
}

let proc: ReturnType<typeof fakeChild>;
let tmpRoot: string;
let paths: GroupPaths;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  runnerConfig.CONTAINER_CPUS = undefined;
  runnerConfig.CONTAINER_MEMORY = undefined;
  runnerConfig.CONTAINER_PIDS_LIMIT = "256";
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kuchiclaw-runner-"));
  paths = makePaths(tmpRoot);
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
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("runContainer timeout state machine — D2 matrix", () => {
  it("close-before-kill settles once and never starts termination", async () => {
    const tracked = track(runContainer(input(), paths, { owner: "orchestrator" }));
    writeSigned(proc);
    proc.emit("close", 0);

    await expect(tracked.promise).resolves.toMatchObject({ status: "success", result: "done" });
    await fireTimeout();
    expect(docker.execDocker).not.toHaveBeenCalled();
    expect(tracked.settlements()).toBe(1);
  });

  it("close-during-kill is recorded until kill adjudication, then settles once", async () => {
    const kill = deferred<typeof ok>();
    docker.execDocker.mockReturnValueOnce(kill.promise);
    const tracked = track(runContainer(input(), paths, { owner: "orchestrator" }));
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
    const tracked = track(runContainer(input(), paths, { owner: "orchestrator" }));
    await fireTimeout();
    proc.emit("close", 1);

    await expect(tracked.promise).rejects.toThrow(/timed out/);
    expect(docker.execDocker).toHaveBeenCalledTimes(1);
    expect(tracked.settlements()).toBe(1);
  });

  it("kill-timeout+confirm-absent is non-retryable and settles once", async () => {
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
    const tracked = track(runContainer(input(), paths, {
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

  it("kill-timeout+confirm-stopped is non-retryable without containment", async () => {
    docker.execDocker
      .mockResolvedValueOnce({ ok: false, code: null, stdout: "", stderr: "", timedOut: true })
      .mockResolvedValueOnce({ ...ok, stdout: "false\n" });
    const containment = vi.fn();
    const tracked = track(runContainer(input(), paths, {
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
    const tracked = track(runContainer(input(), paths, {
      owner: "orchestrator", onContainmentFailure: containment,
    }));
    await fireTimeout();
    proc.emit("close", 137);

    await expect(tracked.promise).rejects.toBeInstanceOf(ContainerTerminationUnknownError);
    expect(containment).toHaveBeenCalledOnce();
    expect(tracked.settlements()).toBe(1);
  });

  it("late-result-after-kill is read once close releases the drain latch", async () => {
    const tracked = track(runContainer(input(), paths, { owner: "orchestrator" }));
    await fireTimeout();
    expect(tracked.settlements()).toBe(0);
    writeSigned(proc);
    proc.emit("close", 137);

    await expect(tracked.promise).resolves.toMatchObject({ result: "done" });
    expect(tracked.settlements()).toBe(1);
  });

  it("drain-bound-expiry kills the attach client and settles once", async () => {
    const tracked = track(runContainer(input(), paths, { owner: "orchestrator" }));
    await fireTimeout();
    await vi.advanceTimersByTimeAsync(50);

    await expect(tracked.promise).rejects.toThrow(/timed out/);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(tracked.settlements()).toBe(1);
  });

  it("result-before-timeout is success and persists newTokens exactly once", async () => {
    const newTokens = { accessToken: "a", refreshToken: "r", expiresAt: 123 };
    const tracked = track(runContainer(input(), paths, { owner: "orchestrator" }));
    writeSigned(proc, { newTokens, warnings: ["refused secret key: TIMEOUT_SECRET"] });
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
    const tracked = track(runContainer(input(), paths, { owner: "orchestrator" }));
    writeSigned(proc, { newTokens: { accessToken: "a", refreshToken: "r", expiresAt: 123 } });
    await fireTimeout();
    proc.emit("close", 137);

    await expect(tracked.promise).resolves.toMatchObject({ result: "done" });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("ENOSPC"));
    expect(tracked.settlements()).toBe(1);
  });

  it("valid-result+death-unconfirmed resolves, then raises containment, exactly once", async () => {
    docker.execDocker
      .mockResolvedValueOnce({ ok: false, code: null, stdout: "", stderr: "", timedOut: true })
      .mockResolvedValueOnce({ ...ok, stdout: "true" });
    const containment = vi.fn();
    const tracked = track(runContainer(input(), paths, {
      owner: "orchestrator", onContainmentFailure: containment,
    }));
    writeSigned(proc);
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
    const tracked = track(runContainer(input(), paths, { owner: "cli" }));
    await fireTimeout();
    proc.emit("close", 137);

    await expect(tracked.promise).rejects.toBeInstanceOf(ContainerTerminationUnknownError);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/Containment failure:.*kuchiclaw-tg-123.*could not be confirmed/),
    );
  });
});

describe("runContainer signed-result verification (P5.1)", () => {
  it("rejects a forged result (wrong key) as non-retryable and never persists tokens", async () => {
    const tracked = track(runContainer(input(), paths, { owner: "orchestrator" }));
    const { runDir } = runInfo(proc);
    // Signed with an attacker-chosen key the host never issued.
    const payload = JSON.stringify({
      status: "success",
      result: "approved",
      newTokens: { accessToken: "evil", refreshToken: "evil", expiresAt: 1 },
    });
    const hmac = createHmac("sha256", Buffer.from("00".repeat(32), "hex"))
      .update(payload, "utf8").digest("hex");
    fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({ v: 1, hmac, payload }));
    proc.emit("close", 0);

    await expect(tracked.promise).rejects.toBeInstanceOf(OutputVerificationError);
    await expect(tracked.promise).rejects.toThrow(/HMAC verification failed/);
    expect(updateOAuthData).not.toHaveBeenCalled();
    expect(tracked.settlements()).toBe(1);
  });

  it("rejects a missing result on clean close as non-retryable", async () => {
    const tracked = track(runContainer(input(), paths, { owner: "orchestrator" }));
    proc.emit("close", 0);

    await expect(tracked.promise).rejects.toBeInstanceOf(OutputVerificationError);
    await expect(tracked.promise).rejects.toThrow(/no result file/);
    expect(tracked.settlements()).toBe(1);
  });

  it("rejects an oversized result as invalid", async () => {
    const tracked = track(runContainer(input(), paths, { owner: "orchestrator" }));
    writeRawResult(proc, "x".repeat(runnerConfig.MAX_OUTPUT_BYTES + 10));
    proc.emit("close", 0);

    await expect(tracked.promise).rejects.toBeInstanceOf(OutputVerificationError);
    expect(tracked.settlements()).toBe(1);
  });

  it("rejects a symlinked result file (O_NOFOLLOW) as invalid", async () => {
    const tracked = track(runContainer(input(), paths, { owner: "orchestrator" }));
    const { runDir } = runInfo(proc);
    const decoy = path.join(tmpRoot, "decoy.json");
    fs.writeFileSync(decoy, JSON.stringify({ v: 1, hmac: "x", payload: "y" }));
    fs.symlinkSync(decoy, path.join(runDir, "result.json"));
    proc.emit("close", 0);

    await expect(tracked.promise).rejects.toBeInstanceOf(OutputVerificationError);
    expect(tracked.settlements()).toBe(1);
  });

  it("rejects a malformed envelope as invalid", async () => {
    const tracked = track(runContainer(input(), paths, { owner: "orchestrator" }));
    writeRawResult(proc, "{ not json");
    proc.emit("close", 0);

    await expect(tracked.promise).rejects.toThrow(/invalid result/);
    expect(tracked.settlements()).toBe(1);
  });

  it("delivers an agent-authored error envelope as a success-shaped result", async () => {
    const tracked = track(runContainer(input(), paths, { owner: "orchestrator" }));
    writeSigned(proc, { status: "error", error: "Agent stopped: refusal" });
    proc.emit("close", 1);

    await expect(tracked.promise).resolves.toMatchObject({ status: "error", error: "Agent stopped: refusal" });
    expect(tracked.settlements()).toBe(1);
  });

  it("does not let an async stdin error make a missing result retryable (Codex F1 round-2)", async () => {
    // A stdin 'error' can fire late (teardown after a full run), so it must not
    // flip a container-started no-result outcome to retryable — that could
    // duplicate side effects. Stays a non-retryable OutputVerificationError.
    const tracked = track(runContainer(input(), paths, { owner: "orchestrator" }));
    proc.stdin.emit("error", new Error("EPIPE"));
    proc.emit("close", 1);

    await expect(tracked.promise).rejects.toBeInstanceOf(OutputVerificationError);
    expect(tracked.settlements()).toBe(1);
  });

  it("kills the container on a synchronous stdin write throw (no stray, non-retryable)", async () => {
    // A sync throw leaves a spawned container that would hang on an EOF we never
    // sent; it must be killed+confirmed, and the outcome is non-retryable so the
    // queue never re-runs onto its live mounts.
    proc.stdin.write.mockImplementationOnce(() => { throw new Error("stream destroyed"); });
    const tracked = track(runContainer(input(), paths, { owner: "orchestrator" }));
    // The sync throw routes to termination; advance past the drain latch.
    await vi.advanceTimersByTimeAsync(50);

    await expect(tracked.promise).rejects.toBeInstanceOf(OutputVerificationError);
    expect(docker.execDocker).toHaveBeenCalledWith(["kill", expect.stringContaining("kuchiclaw-tg-123")]);
    expect(tracked.settlements()).toBe(1);
  });

  it("cleans up the per-run output directory after settling", async () => {
    const tracked = track(runContainer(input(), paths, { owner: "orchestrator" }));
    const { runDir } = runInfo(proc);
    writeSigned(proc);
    proc.emit("close", 0);
    await tracked.promise;

    expect(fs.existsSync(runDir)).toBe(false);
  });

  it("survives a flood of stdout without unbounded growth, then reads the file", async () => {
    const tracked = track(runContainer(input(), paths, { owner: "orchestrator" }));
    for (let i = 0; i < 100; i++) proc.stdout.emit("data", "spam".repeat(1000));
    writeSigned(proc);
    proc.emit("close", 0);

    await expect(tracked.promise).resolves.toMatchObject({ result: "done" });
  });
});

describe("runContainer structured warnings", () => {
  it.each(["success", "error"] as const)("logs warnings on normal %s output", async (status) => {
    const promise = runContainer(input(), paths, { owner: "orchestrator" });
    writeSigned(proc, {
      status,
      ...(status === "error" ? { error: "agent stopped" } : {}),
      warnings: ["refused secret key: UNKNOWN_SECRET"],
    });
    proc.emit("close", status === "success" ? 0 : 1);

    await expect(promise).resolves.toMatchObject({ status });
    expect(console.warn).toHaveBeenCalledWith(
      "[Container] refused secret key: UNKNOWN_SECRET",
    );
  });

  it("logs at most 20 warnings from one output", async () => {
    const promise = runContainer(input(), paths, { owner: "orchestrator" });
    writeSigned(proc, { warnings: Array.from({ length: 25 }, (_, index) => `warning-${index}`) });
    proc.emit("close", 0);

    await promise;
    expect(console.warn).toHaveBeenCalledTimes(20);
    expect(console.warn).toHaveBeenNthCalledWith(20, "[Container] warning-19");
    expect(console.warn).not.toHaveBeenCalledWith("[Container] warning-20");
  });

  it("sanitizes newlines, control characters, and ANSI escapes", async () => {
    const promise = runContainer(input(), paths, { owner: "orchestrator" });
    writeSigned(proc, { warnings: ["line1\n[31mred[0m\tend"] });
    proc.emit("close", 0);

    await promise;
    expect(console.warn).toHaveBeenCalledWith("[Container] line1  red  end ");
  });

  it("truncates each warning to 200 sanitized characters", async () => {
    const promise = runContainer(input(), paths, { owner: "orchestrator" });
    writeSigned(proc, { warnings: ["x".repeat(250)] });
    proc.emit("close", 0);

    await promise;
    expect(console.warn).toHaveBeenCalledWith(`[Container] ${"x".repeat(200)}`);
  });
});

describe("runContainer argv", () => {
  it("uses bind mounts, hardening defaults, owner labels, and distinct same-ms names", async () => {
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
    for (const destination of ["/workspace/MEMORY.md", "/workspace/CONTEXT.md", "/workspace/TODO.md", "/workspace/ipc", "/workspace/.out"]) {
      expect(mountFor(destination)).toBeDefined();
      expect(mountFor(destination)).not.toContain(",readonly");
    }
    expect(calls[0].some((arg) => arg.includes(secretValue))).toBe(false);
    const firstName = calls[0][calls[0].indexOf("--name") + 1];
    const secondName = calls[1][calls[1].indexOf("--name") + 1];
    expect(firstName).toMatch(/^kuchiclaw-tg-123-1234-[a-f0-9]{8}$/);
    expect(secondName).not.toBe(firstName);
    // Each run gets its own output dir mount — no shared-path collision.
    expect(mountFor("/workspace/.out")).toContain(firstName);

    writeSigned(firstProc);
    firstProc.emit("close", 0);
    writeSigned(secondProc);
    secondProc.emit("close", 0);
    await Promise.all([first, second]);
    now.mockRestore();
  });

  it("never places the signing key or secrets in the container argv", async () => {
    const promise = runContainer(
      { ...input(), secrets: { API_TOKEN: "secret-value" } },
      paths,
      { owner: "cli" },
    );
    const args = docker.spawnDocker.mock.calls[0][0] as string[];
    const { key } = runInfo(proc);

    expect(args.some((arg) => arg.includes(key))).toBe(false);
    expect(args.some((arg) => arg.includes("secret-value"))).toBe(false);
    writeSigned(proc);
    proc.emit("close", 0);
    await promise;
  });

  it("adds opt-in CPU/memory flags and allows the pids limit to be disabled", async () => {
    runnerConfig.CONTAINER_CPUS = "0.5";
    runnerConfig.CONTAINER_MEMORY = "128m";
    runnerConfig.CONTAINER_PIDS_LIMIT = undefined;
    const promise = runContainer(input(), paths, { owner: "cli" });
    const args = docker.spawnDocker.mock.calls[0][0] as string[];

    expect(args).toEqual(expect.arrayContaining(["--cpus", "0.5", "--memory", "128m"]));
    expect(args).not.toContain("--pids-limit");
    writeSigned(proc);
    proc.emit("close", 0);
    await promise;
  });

  it("rejects a missing mount source with the exact path before spawn", async () => {
    fs.unlinkSync(paths.memory);

    await expect(runContainer(input(), paths, { owner: "cli" })).rejects.toThrow(paths.memory);
    expect(docker.spawnDocker).not.toHaveBeenCalled();
    // A pre-spawn failure must not leak an output dir.
    expect(fs.readdirSync(paths.outRoot)).toHaveLength(0);
  });

  it("rejects symlink mount sources", async () => {
    fs.unlinkSync(paths.memory);
    fs.symlinkSync(paths.context, paths.memory);

    await expect(runContainer(input(), paths, { owner: "cli" })).rejects.toThrow(/must not be a symlink/);
    expect(docker.spawnDocker).not.toHaveBeenCalled();
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
    todo: path.join(root, "TODO.md"),
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
  for (const file of [result.memory, result.context, result.todo, result.soul, result.tools, result.heartbeat]) {
    fs.writeFileSync(file, "test");
  }
  return result;
}
