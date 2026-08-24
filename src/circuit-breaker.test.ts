import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nextBackoff, enforceStartupBackoff, resetCircuitBreaker } from "./circuit-breaker.js";

const T0 = new Date("2026-08-24T12:00:00.000Z");
const minutesBefore = (n: number) => new Date(T0.getTime() - n * 60_000).toISOString();

describe("circuit breaker backoff schedule", () => {
  it("treats a clean start (no prior state) as attempt 1 with no delay", () => {
    expect(nextBackoff(null, T0)).toEqual({ attempt: 1, delaySec: 0 });
  });

  it("increments the attempt when the previous start was recent (crash-loop)", () => {
    expect(nextBackoff({ attempt: 1, timestamp: minutesBefore(1) }, T0)).toEqual({ attempt: 2, delaySec: 0 });
    expect(nextBackoff({ attempt: 2, timestamp: minutesBefore(1) }, T0)).toEqual({ attempt: 3, delaySec: 10 });
    expect(nextBackoff({ attempt: 4, timestamp: minutesBefore(1) }, T0)).toEqual({ attempt: 5, delaySec: 120 });
  });

  it("caps the backoff at the last schedule entry (15 min)", () => {
    expect(nextBackoff({ attempt: 20, timestamp: minutesBefore(1) }, T0).delaySec).toBe(900);
  });

  it("resets to attempt 1 when the previous start was over the reset window ago", () => {
    // 61 minutes ago > 1h reset window
    expect(nextBackoff({ attempt: 5, timestamp: minutesBefore(61) }, T0)).toEqual({ attempt: 1, delaySec: 0 });
  });
});

describe("enforceStartupBackoff (state file + sleep)", () => {
  let dir: string;
  let cbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-"));
    cbPath = path.join(dir, "circuit-breaker.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("records the first start and does not sleep", async () => {
    const sleep = vi.fn(async () => {});
    await enforceStartupBackoff({ cbPath, now: () => T0, sleep });
    expect(sleep).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(cbPath, "utf-8"))).toEqual({ attempt: 1, timestamp: T0.toISOString() });
  });

  it("sleeps for the scheduled backoff on a repeated crash", async () => {
    fs.writeFileSync(cbPath, JSON.stringify({ attempt: 2, timestamp: minutesBefore(1) }));
    const sleep = vi.fn(async () => {});
    await enforceStartupBackoff({ cbPath, now: () => T0, sleep });
    // attempt becomes 3 → 10s
    expect(sleep).toHaveBeenCalledWith(10_000);
    expect(JSON.parse(fs.readFileSync(cbPath, "utf-8")).attempt).toBe(3);
  });

  it("resetCircuitBreaker removes the state file (next start is attempt 1)", async () => {
    fs.writeFileSync(cbPath, JSON.stringify({ attempt: 5, timestamp: minutesBefore(1) }));
    resetCircuitBreaker(cbPath);
    expect(fs.existsSync(cbPath)).toBe(false);
    const sleep = vi.fn(async () => {});
    await enforceStartupBackoff({ cbPath, now: () => T0, sleep });
    expect(sleep).not.toHaveBeenCalled();
  });
});
