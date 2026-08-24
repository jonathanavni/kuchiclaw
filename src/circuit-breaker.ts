// Startup circuit breaker — backs off *inside* the process when the orchestrator
// is crash-looping. Two jobs, and they must coexist:
//
//   1. Ride out a TRANSIENT loop (a couple of fast crashes then recovery) with
//      escalating in-process backoff, so systemd's StartLimit doesn't trip the
//      unit into a permanent `failed` state over a passing blip.
//   2. ALERT on a PERSISTENT loop. The operator added systemd's StartLimit
//      specifically because an OAuth crash-loop once ran silently for 8 days
//      (see kuchiclaw.service). Since the backoff below keeps StartLimit from
//      tripping (so its OnFailure alert no longer fires), the breaker raises the
//      alarm itself. StartLimit stays as a failsafe for when the breaker can't run.
//
// State is a rolling ledger of recent start timestamps; the backoff is indexed by
// how many starts fall inside a 5-minute window. The breaker is the PRIMARY
// control and systemd's StartLimit is only a loose failsafe (burst 20), so the
// backoff does NOT need to precisely shadow systemd's rate-limiter — it just has
// to escalate enough that a real crash-loop is slowed (and alerted) rather than
// hammering. That deliberate looseness is why deploy-mid-backoff interleavings
// and wall-clock jumps are harmless here: the worst case is a slightly mistimed
// backoff, never a permanently-failed unit (an earlier design that tried to
// exactly track systemd's tight window could not survive those cases).

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DATA_DIR, PROJECT_ROOT } from "./config.js";

const CB_PATH = path.join(DATA_DIR, "circuit-breaker.json");

/** Must mirror kuchiclaw.service StartLimitIntervalSec — the window systemd counts starts over. */
const WINDOW_MS = 300 * 1000;

/** Backoff seconds indexed by (starts-in-window − 1). Two fast retries for real transients, then escalate. */
const BACKOFF_SCHEDULE_S = [0, 0, 30, 90, 180, 300, 900];

/** Starts-in-window at which the loop is clearly persistent — raise the alarm. */
const ALERT_ATTEMPT = 4;

/** Minimum spacing between alert attempts once one succeeds (durable rate limit). */
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;

/** Hard cap on how long we wait for the alert child before treating it as failed. */
const ALERT_TIMEOUT_MS = 15 * 1000;

interface CircuitBreakerState {
  /** Epoch ms of recent starts, pruned to the window. */
  starts: number[];
  /** Epoch ms of the last SUCCESSFUL alert — a failed alert is retried on the next crash. */
  lastAlertAt?: number;
}

function read(cbPath: string): CircuitBreakerState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cbPath, "utf-8"));
    if (!Array.isArray(parsed.starts)) return null;
    return parsed as CircuitBreakerState;
  } catch {
    return null;
  }
}

function write(cbPath: string, state: CircuitBreakerState): void {
  // The breaker runs before the DB/data dir is guaranteed to exist.
  fs.mkdirSync(path.dirname(cbPath), { recursive: true });
  fs.writeFileSync(cbPath, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Pure: given the prior start ledger and the current time, compute the pruned
 * ledger (with this start appended), the in-window start count, and the backoff.
 * Exported for tests and the systemd-spacing invariant.
 */
export function planStartup(
  prevStarts: number[],
  nowMs: number,
): { starts: number[]; attempt: number; delaySec: number } {
  const starts = [...prevStarts.filter((t) => t > nowMs - WINDOW_MS), nowMs];
  const attempt = starts.length;
  const delaySec = BACKOFF_SCHEDULE_S[Math.min(attempt - 1, BACKOFF_SCHEDULE_S.length - 1)];
  return { starts, attempt, delaySec };
}

/** Manually clear the breaker (ops utility — NOT called on clean shutdown; the time window handles that). */
export function resetCircuitBreaker(cbPath = CB_PATH): void {
  try {
    fs.unlinkSync(cbPath);
  } catch {
    // Missing/stale state already IS the reset state.
  }
}

/**
 * Best-effort persistent-crash-loop alert. Returns whether it was delivered, so
 * a failed alert is retried on the next crash instead of leaving the outage
 * silent. Runs only under systemd (INVOCATION_ID); in dev/test it is a no-op that
 * reports success (nothing to deliver, nothing to retry).
 */
async function defaultAlert(): Promise<boolean> {
  if (!process.env.INVOCATION_ID) return true;
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn("bash", [path.join(PROJECT_ROOT, "deploy", "alert.sh"), "kuchiclaw.service"], {
        stdio: "ignore",
      });
      const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(false); }, ALERT_TIMEOUT_MS);
      child.on("error", () => { clearTimeout(timer); resolve(false); });
      child.on("exit", (code) => { clearTimeout(timer); resolve(code === 0); });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Record this startup and, if the orchestrator is crash-looping, sleep for the
 * backoff before returning. Injectable deps keep it unit-testable.
 */
export async function enforceStartupBackoff(opts: {
  cbPath?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  alert?: () => Promise<boolean>;
} = {}): Promise<void> {
  const cbPath = opts.cbPath ?? CB_PATH;
  const nowMs = (opts.now ?? (() => new Date()))().getTime();
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const alert = opts.alert ?? defaultAlert;

  const prev = read(cbPath);
  const { starts, attempt, delaySec } = planStartup(prev?.starts ?? [], nowMs);
  const state: CircuitBreakerState = { starts, lastAlertAt: prev?.lastAlertAt };

  if (attempt > 1) {
    console.warn(`[Breaker] ${attempt} starts within the crash-loop window`);
  }

  // Persistent loop: alert, retrying on later crashes until one lands, then cool down.
  if (attempt >= ALERT_ATTEMPT) {
    // `elapsed < 0` means the wall clock jumped backwards since the last alert —
    // treat that as cooled so a clock step can never suppress the alarm.
    const elapsed = state.lastAlertAt ? nowMs - state.lastAlertAt : Infinity;
    const cooled = elapsed > ALERT_COOLDOWN_MS || elapsed < 0;
    if (cooled) {
      console.error(`[Breaker] Persistent crash-loop (${attempt} starts) — alerting operator`);
      if (await alert()) state.lastAlertAt = nowMs;
      else console.error("[Breaker] Alert delivery failed — will retry on the next crash");
    }
  }

  write(cbPath, state);

  if (delaySec > 0) {
    console.warn(`[Breaker] Crash-loop backoff: delaying startup ${delaySec}s (${attempt} recent starts)`);
    await sleep(delaySec * 1000);
    console.log(`[Breaker] Backoff complete, resuming startup`);
  }
}
