// Startup circuit breaker — backs off *inside* the process when the orchestrator
// is crash-looping. Two jobs, and they must coexist:
//
//   1. Ride out a TRANSIENT loop (a couple of fast crashes then recovery) with
//      escalating in-process backoff, so systemd's StartLimit doesn't trip the
//      unit into a permanent `failed` state over a passing blip.
//   2. ALERT on a PERSISTENT loop. The operator added systemd's StartLimit
//      specifically because an OAuth crash-loop once ran silently for 8 days
//      (see kuchiclaw.service). Since the backoff below is deliberately tuned so
//      the StartLimit no longer trips (and so its OnFailure alert no longer
//      fires), the breaker itself raises the alarm once the loop is clearly not
//      transient. systemd's StartLimit stays as a failsafe for the case where
//      the breaker itself can't run.
//
// Backoff tuning: with systemd's StartLimitBurst=5 / StartLimitIntervalSec=300 /
// RestartSec=5, the unit permanently fails if 6 starts land inside any 300s
// window. A startup-phase crash happens right after this backoff, so successive
// starts are spaced by (sleep + RestartSec). We keep the first two retries fast
// (real transients recover), then escalate so that the time to the 6th start
// exceeds 300s: sum(sleeps[0..4]) + 5*RestartSec = 300 + 25 > 300. See the
// systemd-scenario test.
//
// Adapted from NanoClaw's circuit-breaker.ts. Runs before anything else in
// main() — it only reads/sleeps/writes its own file (plus a best-effort alert).

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DATA_DIR, PROJECT_ROOT } from "./config.js";

const CB_PATH = path.join(DATA_DIR, "circuit-breaker.json");

/** A startup within this window of the previous one counts as a crash-loop restart. */
const RESET_WINDOW_MS = 60 * 60 * 1000;

/** Backoff seconds indexed by consecutive-crash count (attempt 1 = clean start = 0s). 6+ capped at 15min. */
const BACKOFF_SCHEDULE_S = [0, 0, 30, 90, 180, 300, 900];

/** Consecutive-crash count at which the loop is clearly persistent — raise the alarm. */
const ALERT_ATTEMPT = 4;

interface CircuitBreakerState {
  attempt: number;
  timestamp: string;
}

/**
 * Best-effort persistent-crash-loop alert. Runs only under systemd (INVOCATION_ID
 * is set by systemd, absent in dev/tests), reusing the same detached alert script
 * systemd's OnFailure would have used. Never throws, never blocks startup.
 */
function defaultAlert(): void {
  if (!process.env.INVOCATION_ID) return; // not systemd-managed (dev/test)
  try {
    const child = spawn("bash", [path.join(PROJECT_ROOT, "deploy", "alert.sh"), "kuchiclaw.service"], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Alerting is best-effort — never let it interfere with startup.
  }
}

function read(cbPath: string): CircuitBreakerState | null {
  try {
    return JSON.parse(fs.readFileSync(cbPath, "utf-8")) as CircuitBreakerState;
  } catch {
    return null;
  }
}

function write(cbPath: string, state: CircuitBreakerState): void {
  // The breaker runs before the DB/data dir is guaranteed to exist.
  fs.mkdirSync(path.dirname(cbPath), { recursive: true });
  fs.writeFileSync(cbPath, JSON.stringify(state, null, 2) + "\n");
}

function delayForAttempt(attempt: number): number {
  const idx = Math.min(attempt - 1, BACKOFF_SCHEDULE_S.length - 1);
  return BACKOFF_SCHEDULE_S[Math.max(idx, 0)];
}

/** Clear the breaker — called on a clean shutdown so the next start is treated as attempt 1. */
export function resetCircuitBreaker(cbPath = CB_PATH): void {
  try {
    fs.unlinkSync(cbPath);
  } catch {
    // Missing/stale state already IS the reset state.
  }
}

/**
 * Compute the next attempt count and its backoff from prior state, without sleeping.
 * Exported for tests and reuse; `enforceStartupBackoff` wraps it with the actual wait.
 */
export function nextBackoff(
  prev: CircuitBreakerState | null,
  now: Date,
): { attempt: number; delaySec: number } {
  let attempt: number;
  if (!prev) {
    attempt = 1;
  } else {
    const elapsedMs = now.getTime() - new Date(prev.timestamp).getTime();
    // A recent prior start with no clean shutdown in between = a crash-loop restart.
    attempt = elapsedMs < RESET_WINDOW_MS ? prev.attempt + 1 : 1;
  }
  return { attempt, delaySec: delayForAttempt(attempt) };
}

/**
 * Record this startup and, if the orchestrator is crash-looping, sleep for the
 * backoff before returning. Injectable deps keep it unit-testable.
 */
export async function enforceStartupBackoff(opts: {
  cbPath?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  alert?: () => void;
} = {}): Promise<void> {
  const cbPath = opts.cbPath ?? CB_PATH;
  const now = (opts.now ?? (() => new Date()))();
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const alert = opts.alert ?? defaultAlert;

  const prev = read(cbPath);
  const { attempt, delaySec } = nextBackoff(prev, now);

  if (prev && attempt > 1) {
    console.warn(
      `[Breaker] Previous startup was not a clean shutdown (attempt ${attempt}); prior at ${prev.timestamp}`,
    );
  }

  write(cbPath, { attempt, timestamp: now.toISOString() });

  // Raise the alarm once, as the loop crosses from transient into persistent —
  // systemd's OnFailure alert no longer fires because the backoff keeps the unit
  // from tripping StartLimit.
  if (attempt === ALERT_ATTEMPT) {
    console.error(`[Breaker] Persistent crash-loop (attempt ${attempt}) — alerting operator`);
    alert();
  }

  if (delaySec > 0) {
    console.warn(`[Breaker] Crash-loop backoff: delaying startup ${delaySec}s (attempt ${attempt})`);
    await sleep(delaySec * 1000);
    console.log(`[Breaker] Backoff complete, resuming startup (attempt ${attempt})`);
  }
}
