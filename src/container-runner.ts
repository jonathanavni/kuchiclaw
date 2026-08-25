// Spawns one ephemeral Docker container and owns its complete attach lifecycle.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CONTAINER_CPUS,
  CONTAINER_IMAGE,
  CONTAINER_MEMORY,
  CONTAINER_OUTPUT_DIR,
  CONTAINER_PIDS_LIMIT,
  CONTAINER_TIMEOUT_MS,
  MAX_DIAGNOSTIC_BYTES,
  MAX_OUTPUT_BYTES,
  RESULT_ENVELOPE_VERSION,
  RESULT_FILENAME,
  TERMINATION_DRAIN_MS,
} from "./config.js";
import { ContainerTerminationUnknownError, OutputVerificationError } from "./container-errors.js";
import { execDocker, spawnDocker, type DockerExecResult } from "./docker.js";
import { readBoundedFile } from "./bounded-read.js";
import { updateOAuthData } from "./oauth-refresh.js";
import type { GroupPaths } from "./group-folder.js";
import type { ContainerInput, ContainerOutput } from "./types.js";

/** Result of reading the signed result file. `invalid` is tamper/corruption
 *  (non-retryable); `missing` is no file at all (the container never emitted). */
type SignedRead =
  | { kind: "ok"; output: ContainerOutput }
  | { kind: "missing" }
  | { kind: "invalid"; reason: string };

export interface ContainerLifecycle {
  owner: "orchestrator" | "cli";
  onContainmentFailure?: (error: ContainerTerminationUnknownError) => void;
}

type RunnerState = "running" | "terminating" | "settled";

const MAX_CONTAINER_WARNINGS = 20;
const MAX_CONTAINER_WARNING_LENGTH = 200;

export async function runContainer(
  input: ContainerInput,
  paths: GroupPaths,
  lifecycle: ContainerLifecycle,
): Promise<ContainerOutput> {
  const containerName = `kuchiclaw-${input.groupFolder}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  // Per-run signing key + per-run output dir. Two same-group containers run
  // concurrently (MAX_CONTAINERS_PER_GROUP), so the dir must be per-run.
  const outputKey = randomBytes(32).toString("hex");
  const runDir = path.join(paths.outRoot, containerName);
  fs.mkdirSync(runDir, { recursive: true });
  const signedInput: ContainerInput = { ...input, outputKey };

  let mounts: string[];
  try {
    mounts = buildMountArgs(paths, runDir);
  } catch (err) {
    cleanupRunDir(runDir); // a pre-spawn mount-source failure must not leak the dir
    throw err;
  }
  const args = [
    "run", "-i", "--rm", "--name", containerName,
    "--label", `kuchiclaw.owner=${lifecycle.owner}`,
    "--init", "--cap-drop=ALL", "--security-opt", "no-new-privileges",
    ...optionalResourceArgs(),
    ...mounts,
    CONTAINER_IMAGE,
  ];

  return new Promise<ContainerOutput>((resolve, reject) => {
    const proc = spawnDocker(args, { stdio: ["pipe", "pipe", "pipe"] });
    let state: RunnerState = "running";
    const stdout = boundedBuffer();
    const stderr = boundedBuffer();
    let closeRecorded = false;
    let closeCode: number | null = null;
    let signalClose!: () => void;
    const closeSignal = new Promise<void>((done) => { signalClose = done; });

    const settle = (fn: () => void) => {
      if (state === "settled") return;
      state = "settled";
      clearTimeout(timeout);
      try { fn(); } finally { cleanupRunDir(runDir); }
    };

    const timeout = setTimeout(() => {
      if (state !== "running") return;
      state = "terminating";
      void finalizeTermination();
    }, CONTAINER_TIMEOUT_MS);

    proc.stdout?.on("data", (chunk: Buffer | string) => { stdout.push(chunk.toString()); });
    proc.stderr?.on("data", (chunk: Buffer | string) => { stderr.push(chunk.toString()); });

    proc.on("error", (err) => {
      if (state === "running") {
        settle(() => reject(new Error(`Failed to spawn container: ${err.message}`)));
      }
      // During termination only close releases the stdout-drain latch.
    });

    proc.on("close", (code) => {
      closeRecorded = true;
      closeCode = code;
      signalClose();
      if (state === "running") finalizeNormalClose();
    });

    // Node requires an 'error' listener on the stream, but a stdin error is NOT
    // reliable proof the agent didn't run — it can fire late during teardown
    // after a full run — so it never influences retry classification. Any
    // container-started outcome without a verifiable result stays non-retryable.
    proc.stdin?.on("error", () => { /* outcome comes from the result file + close/timeout */ });
    try {
      proc.stdin?.write(JSON.stringify(signedInput));
      proc.stdin?.end();
    } catch (err) {
      // A synchronous throw leaves a spawned container that may hang on an EOF we
      // never sent; route through termination to kill+confirm it (no stray, no
      // concurrent retry onto its live mounts) instead of settling it out from
      // under it. The outcome is the normal non-retryable no-result adjudication.
      console.error(`[Container] Input delivery failed: ${formatError(err)}`);
      if (state === "running") {
        state = "terminating";
        void finalizeTermination();
      }
    }

    function finalizeNormalClose(): void {
      try {
        const read = readSignedResult(runDir, outputKey);
        if (read.kind === "ok") {
          // readSignedResult never throws and persistNewTokens self-catches, so
          // this success bookkeeping can't fall into the retryable catch below.
          logWarnings(read.output);
          persistNewTokens(read.output);
          settle(() => resolve(read.output));
          return;
        }
        // The container ran (it closed cleanly), so a missing or tampered result
        // is non-retryable: a re-run would repeat any side effects the agent
        // already performed. Only a failure to spawn at all (proc 'error') is
        // retryable.
        settle(() => reject(outputFailure(read, closeCode, stdout.get(), stderr.get())));
      } catch (err) {
        settle(() => reject(new Error(`Container output handling failed: ${formatError(err)}`)));
      }
    }

    async function finalizeTermination(): Promise<void> {
      let deathConfirmed = false;
      let terminationAdjudicated = false;
      let output: ContainerOutput | null = null;
      let rejection: Error | null = null;
      let containment: ContainerTerminationUnknownError | null = null;

      try {
        const [termination] = await Promise.all([
          terminateContainer(containerName, () => {
            try { proc.kill("SIGKILL"); } catch { /* inspect remains authoritative */ }
          }),
          drainAttachClient(),
        ]);
        terminationAdjudicated = true;
        deathConfirmed = termination.confirmed;
        // A file survives SIGKILL, so it's read after the drain — no stdout race.
        // HMAC makes reading during unconfirmed death forgery-safe: a valid
        // envelope could only have been signed by the entrypoint.
        const read = readSignedResult(runDir, outputKey);
        output = read.kind === "ok" ? read.output : null;
        if (output) {
          logWarnings(output);
          persistNewTokens(output);
        }

        if (!deathConfirmed) {
          containment = new ContainerTerminationUnknownError(
            `Container ${containerName} termination could not be confirmed: ${termination.detail}`,
          );
          if (!output) rejection = containment;
        } else if (!output) {
          // Container ran to its timeout without a valid result — non-retryable
          // (it may have side-effected); a bare timeout with no file included.
          rejection = read.kind === "invalid"
            ? new OutputVerificationError(`Container ${containerName} produced an invalid result: ${read.reason}`)
            : new OutputVerificationError(`Container ${containerName} timed out after ${CONTAINER_TIMEOUT_MS}ms with no result`);
        }
      } catch (err) {
        containment = new ContainerTerminationUnknownError(
          `Container ${containerName} termination adjudication failed: ${formatError(err)}`,
        );
        rejection = output ? null : containment;
      } finally {
        if (!terminationAdjudicated) deathConfirmed = false;
        if (output) settle(() => resolve(output!));
        else settle(() => reject(rejection ?? new OutputVerificationError(`Container timed out after ${CONTAINER_TIMEOUT_MS}ms with no result`)));

        if (!deathConfirmed) {
          containment ??= new ContainerTerminationUnknownError(
            `Container ${containerName} termination could not be confirmed`,
          );
          try {
            if (lifecycle.onContainmentFailure) {
              lifecycle.onContainmentFailure(containment);
            } else {
              console.error(`[Container] Containment failure: ${containment.message}`);
            }
          } catch (err) {
            console.error(`[Container] Containment notification failed: ${formatError(err)}`);
          }
        }
      }
    }

    async function drainAttachClient(): Promise<void> {
      if (closeRecorded) return;
      let expired = false;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        closeSignal,
        new Promise<void>((done) => {
          drainTimer = setTimeout(() => { expired = true; done(); }, TERMINATION_DRAIN_MS);
        }),
      ]);
      if (drainTimer) clearTimeout(drainTimer);
      if (expired && !closeRecorded) {
        try { proc.kill("SIGKILL"); } catch { /* captured stdout is still adjudicated */ }
      }
    }
  });
}

function buildMountArgs(paths: GroupPaths, runDir: string): string[] {
  const mounts: Array<[string, string, boolean]> = [
    [paths.soul, "/workspace/SOUL.md", true],
    [paths.tools, "/workspace/TOOLS.md", true],
    [paths.memory, "/workspace/MEMORY.md", false],
    [paths.context, "/workspace/CONTEXT.md", false],
    [paths.ipc, "/workspace/ipc", false],
    [paths.skills, "/workspace/skills", true],
    [runDir, CONTAINER_OUTPUT_DIR, false],
  ];
  if (assertMountSource(paths.heartbeat, true)) {
    mounts.push([paths.heartbeat, "/workspace/HEARTBEAT.md", true]);
  }

  const args: string[] = [];
  for (const [source, destination, readonly] of mounts) {
    assertMountSource(source, false);
    args.push("--mount", `type=bind,src=${source},dst=${destination}${readonly ? ",readonly" : ""}`);
  }
  return args;
}

/** Pre-checks improve diagnostics; --mount remains the atomic daemon-side authority. */
function assertMountSource(source: string, optional: boolean): boolean {
  try {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error(`Mount source must not be a symlink: ${source}`);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (optional) return false;
      throw new Error(`Mount source does not exist: ${source}`);
    }
    throw err;
  }
}

function optionalResourceArgs(): string[] {
  const args: string[] = [];
  if (CONTAINER_PIDS_LIMIT) args.push("--pids-limit", CONTAINER_PIDS_LIMIT);
  if (CONTAINER_MEMORY) args.push("--memory", CONTAINER_MEMORY);
  if (CONTAINER_CPUS) args.push("--cpus", CONTAINER_CPUS);
  return args;
}

async function terminateContainer(
  name: string,
  killAttachClient: () => void,
): Promise<{ confirmed: boolean; detail: string }> {
  const killed = await execDocker(["kill", name]);
  if (killed.ok) return { confirmed: true, detail: "docker kill succeeded" };
  if (!killed.timedOut && isBenignKillFailure(killed.stderr)) {
    return { confirmed: true, detail: killed.stderr.trim() || "container already absent" };
  }

  killAttachClient();
  const inspected = await execDocker(["inspect", "-f", "{{.State.Running}}", name]);
  const running = inspected.stdout.trim().toLowerCase();
  if (inspected.ok && running === "false") {
    return { confirmed: true, detail: "container stopped" };
  }
  if (!inspected.ok && !inspected.timedOut && isContainerAbsent(inspected.stderr)) {
    return { confirmed: true, detail: inspected.stderr.trim() || "container absent" };
  }
  return {
    confirmed: false,
    detail: `kill=${summarizeDocker(killed)}; inspect=${summarizeDocker(inspected)}`,
  };
}

function isBenignKillFailure(stderr: string): boolean {
  return /no such container|is not running/i.test(stderr);
}

function isContainerAbsent(stderr: string): boolean {
  return /no such (?:object|container)/i.test(stderr);
}

function summarizeDocker(result: DockerExecResult): string {
  return `ok:${result.ok},timedOut:${result.timedOut},code:${result.code},` +
    `stdout:${JSON.stringify(result.stdout.slice(0, 200))},stderr:${JSON.stringify(result.stderr.slice(0, 200))}`;
}

function persistNewTokens(output: ContainerOutput): void {
  if (!output.newTokens) return;
  try {
    updateOAuthData(output.newTokens);
    console.log("[OAuth] Tokens updated from container refresh");
  } catch (err) {
    console.error(`[OAuth] Failed to persist tokens from container refresh: ${formatError(err)}`);
  }
}

function logWarnings(output: ContainerOutput): void {
  if (!Array.isArray(output.warnings)) return;
  for (const warning of output.warnings.slice(0, MAX_CONTAINER_WARNINGS)) {
    if (typeof warning === "string") {
      console.warn(`[Container] ${sanitizeWarning(warning.slice(0, MAX_CONTAINER_WARNING_LENGTH))}`);
    }
  }
}

function sanitizeWarning(warning: string): string {
  return warning
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\|$)/g, " ")
    .replace(/(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/\x1B[@-_]/g, " ")
    .replace(/[\x00-\x1F\x7F]/g, " ");
}

/** Turn a non-ok signed read into the OutputVerificationError the queue treats
 *  as non-retryable, folding in bounded stdout/stderr for diagnostics. */
function outputFailure(read: SignedRead, code: number | null, stdout: string, stderr: string): Error {
  const detail = read.kind === "invalid" ? `invalid result (${read.reason})` : "no result file";
  return new OutputVerificationError(
    `Container exited with code ${code}: ${detail}.\n` +
    `stderr: ${stderr.slice(0, 500)}\nstdout: ${stdout.slice(0, 500)}`,
  );
}

/** Read and verify the container's signed result file. Never throws for an
 *  expected condition (missing, symlinked, oversized, tampered) — those become
 *  a discriminated result so the finalizer's no-throw invariant holds. */
export function readSignedResult(runDir: string, outputKey: string): SignedRead {
  const file = path.join(runDir, RESULT_FILENAME);
  let raw: string;
  try {
    raw = readBoundedFile(file, MAX_OUTPUT_BYTES, "container result");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    // ELOOP (symlink under O_NOFOLLOW), size cap, nlink≠1, non-regular → tamper.
    return { kind: "invalid", reason: formatError(err) };
  }

  let envelope: unknown;
  try { envelope = JSON.parse(raw); } catch { return { kind: "invalid", reason: "result is not JSON" }; }
  if (!envelope || typeof envelope !== "object") return { kind: "invalid", reason: "envelope is not an object" };
  const { v, hmac, payload } = envelope as Record<string, unknown>;
  if (v !== RESULT_ENVELOPE_VERSION) return { kind: "invalid", reason: `unexpected envelope version ${String(v)}` };
  if (typeof hmac !== "string" || typeof payload !== "string") return { kind: "invalid", reason: "malformed envelope" };

  const expected = createHmac("sha256", Buffer.from(outputKey, "hex")).update(payload, "utf8").digest();
  const provided = Buffer.from(hmac, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { kind: "invalid", reason: "HMAC verification failed" };
  }

  let output: unknown;
  try { output = JSON.parse(payload); } catch { return { kind: "invalid", reason: "payload is not JSON" }; }
  if (!output || typeof output !== "object") return { kind: "invalid", reason: "payload is not an object" };
  const status = (output as { status?: unknown }).status;
  if (status !== "success" && status !== "error") return { kind: "invalid", reason: "payload has no valid status" };
  return { kind: "ok", output: output as ContainerOutput };
}

/** Bounded diagnostic collector: retains only the last MAX_DIAGNOSTIC_BYTES so a
 *  stream-flooding agent can't grow orchestrator memory without bound. */
function boundedBuffer(cap = MAX_DIAGNOSTIC_BYTES): { push: (s: string) => void; get: () => string } {
  let buf = "";
  return {
    push(s: string) {
      buf += s;
      // Amortize the slice: only trim once we're at 2× the cap.
      if (buf.length > cap * 2) buf = buf.slice(buf.length - cap);
    },
    get() {
      return buf.length > cap ? buf.slice(buf.length - cap) : buf;
    },
  };
}

function cleanupRunDir(runDir: string): void {
  try {
    fs.rmSync(runDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[Container] Failed to clean run dir ${runDir}: ${formatError(err)}`);
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
