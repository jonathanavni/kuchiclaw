// Startup circuit breaker — backs off *inside* the process when the orchestrator
// is crash-looping, so systemd's StartLimitBurst never trips the unit into a
// permanent `failed` state. State is a single JSON file; the backoff grows with
// the consecutive-crash count and resets after a quiet window or a clean shutdown.
//
// Adapted from NanoClaw's circuit-breaker.ts. Runs before anything else in
// main() — it only reads/sleeps/writes its own file, no other side effects.

import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";

const CB_PATH = path.join(DATA_DIR, "circuit-breaker.json");

/** A startup within this window of the previous one counts as a crash-loop restart. */
const RESET_WINDOW_MS = 60 * 60 * 1000;

/** Backoff seconds indexed by consecutive-crash count (attempt 1 = clean start = 0s). 6+ capped at 15min. */
const BACKOFF_SCHEDULE_S = [0, 0, 10, 30, 120, 300, 900];

interface CircuitBreakerState {
  attempt: number;
  timestamp: string;
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
} = {}): Promise<void> {
  const cbPath = opts.cbPath ?? CB_PATH;
  const now = (opts.now ?? (() => new Date()))();
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  const prev = read(cbPath);
  const { attempt, delaySec } = nextBackoff(prev, now);

  if (prev && attempt > 1) {
    console.warn(
      `[Breaker] Previous startup was not a clean shutdown (attempt ${attempt}); prior at ${prev.timestamp}`,
    );
  }

  write(cbPath, { attempt, timestamp: now.toISOString() });

  if (delaySec > 0) {
    console.warn(`[Breaker] Crash-loop backoff: delaying startup ${delaySec}s (attempt ${attempt})`);
    await sleep(delaySec * 1000);
    console.log(`[Breaker] Backoff complete, resuming startup (attempt ${attempt})`);
  }
}
