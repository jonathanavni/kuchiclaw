// Spawns one ephemeral Docker container and owns its complete attach lifecycle.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import {
  CONTAINER_CPUS,
  CONTAINER_IMAGE,
  CONTAINER_MEMORY,
  CONTAINER_PIDS_LIMIT,
  CONTAINER_TIMEOUT_MS,
  OUTPUT_END_MARKER,
  OUTPUT_START_MARKER,
  TERMINATION_DRAIN_MS,
} from "./config.js";
import { ContainerTerminationUnknownError } from "./container-errors.js";
import { execDocker, spawnDocker, type DockerExecResult } from "./docker.js";
import { updateOAuthData } from "./oauth-refresh.js";
import type { GroupPaths } from "./group-folder.js";
import type { ContainerInput, ContainerOutput } from "./types.js";

export interface ContainerLifecycle {
  owner: "orchestrator" | "cli";
  onContainmentFailure?: (error: ContainerTerminationUnknownError) => void;
}

type RunnerState = "running" | "terminating" | "settled";

export async function runContainer(
  input: ContainerInput,
  paths: GroupPaths | undefined,
  lifecycle: ContainerLifecycle,
): Promise<ContainerOutput> {
  const containerName = `kuchiclaw-${input.groupFolder}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  const mounts = paths ? buildMountArgs(paths) : [];
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
    let stdout = "";
    let stderr = "";
    let closeRecorded = false;
    let closeCode: number | null = null;
    let signalClose!: () => void;
    const closeSignal = new Promise<void>((done) => { signalClose = done; });

    const settle = (fn: () => void) => {
      if (state === "settled") return;
      state = "settled";
      clearTimeout(timeout);
      fn();
    };

    const timeout = setTimeout(() => {
      if (state !== "running") return;
      state = "terminating";
      void finalizeTermination();
    }, CONTAINER_TIMEOUT_MS);

    proc.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });

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

    proc.stdin?.on("error", () => {
      // Docker's close/error events carry the authoritative spawn/run outcome.
    });
    try {
      proc.stdin?.write(JSON.stringify(input));
      proc.stdin?.end();
    } catch (err) {
      settle(() => reject(new Error(`Failed to write container input: ${formatError(err)}`)));
    }

    function finalizeNormalClose(): void {
      try {
        const output = parseOutput(stdout);
        if (output) {
          persistNewTokens(output);
          settle(() => resolve(output));
          return;
        }
        settle(() => reject(invalidOutputError(closeCode, stdout, stderr)));
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
        output = parseOutput(stdout);
        if (output) persistNewTokens(output);

        if (!deathConfirmed) {
          containment = new ContainerTerminationUnknownError(
            `Container ${containerName} termination could not be confirmed: ${termination.detail}`,
          );
          if (!output) rejection = containment;
        } else if (!output) {
          rejection = new Error(`Container timed out after ${CONTAINER_TIMEOUT_MS}ms`);
        }
      } catch (err) {
        containment = new ContainerTerminationUnknownError(
          `Container ${containerName} termination adjudication failed: ${formatError(err)}`,
        );
        rejection = output ? null : containment;
      } finally {
        if (!terminationAdjudicated) deathConfirmed = false;
        if (output) settle(() => resolve(output!));
        else settle(() => reject(rejection ?? new Error(`Container timed out after ${CONTAINER_TIMEOUT_MS}ms`)));

        if (!deathConfirmed) {
          containment ??= new ContainerTerminationUnknownError(
            `Container ${containerName} termination could not be confirmed`,
          );
          try {
            lifecycle.onContainmentFailure?.(containment);
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

function buildMountArgs(paths: GroupPaths): string[] {
  const mounts: Array<[string, string, boolean]> = [
    [paths.soul, "/workspace/SOUL.md", true],
    [paths.tools, "/workspace/TOOLS.md", true],
    [paths.memory, "/workspace/MEMORY.md", false],
    [paths.context, "/workspace/CONTEXT.md", false],
    [paths.ipc, "/workspace/ipc", false],
    [paths.skills, "/workspace/skills", true],
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
  if (inspected.ok && (running === "" || running === "false")) {
    return { confirmed: true, detail: running || "container absent" };
  }
  return {
    confirmed: false,
    detail: `kill=${summarizeDocker(killed)}; inspect=${summarizeDocker(inspected)}`,
  };
}

function isBenignKillFailure(stderr: string): boolean {
  return /no such container|is not running/i.test(stderr);
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

function invalidOutputError(code: number | null, stdout: string, stderr: string): Error {
  return new Error(
    `Container exited with code ${code}. No valid output found.\n` +
    `stderr: ${stderr.slice(0, 500)}\nstdout: ${stdout.slice(0, 500)}`,
  );
}

/** Extract and minimally validate JSON between sentinel markers. */
function parseOutput(stdout: string): ContainerOutput | null {
  const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
  if (startIdx === -1) return null;
  const endIdx = stdout.indexOf(OUTPUT_END_MARKER, startIdx + OUTPUT_START_MARKER.length);
  if (endIdx === -1) return null;
  try {
    const parsed = JSON.parse(
      stdout.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim(),
    ) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const status = (parsed as { status?: unknown }).status;
    return status === "success" || status === "error" ? parsed as ContainerOutput : null;
  } catch {
    return null;
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
