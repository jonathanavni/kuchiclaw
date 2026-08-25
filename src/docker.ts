import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

const DEFAULT_EXEC_TIMEOUT_MS = 10_000;

export interface DockerExecResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Concrete Docker spawn seam used by both production code and hermetic tests. */
export function spawnDocker(args: readonly string[], opts: SpawnOptions = {}): ChildProcess {
  return spawn("docker", [...args], opts);
}

/** Run one bounded Docker command. Operational failures are data, never throws. */
export function execDocker(
  args: readonly string[],
  timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
): Promise<DockerExecResult> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    let stdout = "";
    let stderr = "";
    let finished = false;

    const finish = (code: number | null, timedOut: boolean) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, code, stdout, stderr, timedOut });
    };

    let timer: ReturnType<typeof setTimeout>;
    try {
      proc = spawnDocker(args, { stdio: ["ignore", "pipe", "pipe"] });
      proc.stdout?.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
      proc.stderr?.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
      proc.on("error", (err) => {
        stderr += `${stderr ? "\n" : ""}${err instanceof Error ? err.message : String(err)}`;
        finish(null, false);
      });
      proc.on("close", (code) => finish(code, false));
      timer = setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* bounded result still wins */ }
        finish(null, true);
      }, timeoutMs);
    } catch (err) {
      timer = setTimeout(() => {}, 0);
      clearTimeout(timer);
      stderr = err instanceof Error ? err.message : String(err);
      finish(null, false);
    }
  });
}
