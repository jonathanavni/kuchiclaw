import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planStartup, enforceStartupBackoff, resetCircuitBreaker } from "./circuit-breaker.js";

const T0 = new Date("2026-08-24T12:00:00.000Z").getTime();
const sec = (n: number) => n * 1000;

describe("planStartup (pure ledger + backoff)", () => {
  it("a lone start is attempt 1 with no delay", () => {
    expect(planStartup([], T0)).toEqual({ starts: [T0], attempt: 1, delaySec: 0 });
  });

  it("prunes starts older than the 300s window", () => {
    const old = T0 - sec(301);
    const recent = T0 - sec(100);
    const { starts, attempt } = planStartup([old, recent], T0);
    expect(starts).toEqual([recent, T0]); // old dropped
    expect(attempt).toBe(2);
  });

  it("escalates the backoff by in-window start count", () => {
    expect(planStartup([T0 - 1, T0 - 2], T0).delaySec).toBe(30); // 3rd start
    expect(planStartup([T0 - 1, T0 - 2, T0 - 3, T0 - 4], T0).delaySec).toBe(180); // 5th
  });

  it("caps the backoff at the last schedule entry (15 min)", () => {
    const many = Array.from({ length: 20 }, (_, i) => T0 - i - 1);
    expect(planStartup(many, T0).delaySec).toBe(900);
  });
});

describe("systemd StartLimit is never tripped", () => {
  // StartLimitBurst=5 / StartLimitIntervalSec=300 / RestartSec=5. A startup crash
  // happens right after the in-process sleep; systemd then waits RestartSec.
  const RESTART_SEC = 5;
  const WINDOW = 300;

  function simulate(events: Array<"crash">, startLedger: number[] = []): number[] {
    // Returns absolute start times (seconds) for a run of consecutive crashes.
    const startTimes: number[] = [];
    let t = 0;
    let ledger = startLedger.map((s) => s * 1000);
    for (let i = 0; i < events.length; i++) {
      startTimes.push(t);
      const { starts, delaySec } = planStartup(ledger, t * 1000);
      ledger = starts;
      t += delaySec + RESTART_SEC; // sleep, crash ~immediately, systemd waits RestartSec
    }
    return startTimes;
  }

  function assertNoSixInWindow(starts: number[]) {
    for (let i = 0; i + 5 < starts.length; i++) {
      expect(starts[i + 5] - starts[i]).toBeGreaterThan(WINDOW);
    }
  }

  it("spaces a fresh 6-crash loop beyond the window", () => {
    const starts = simulate(Array(6).fill("crash"));
    expect(starts).toEqual([0, 5, 10, 45, 140, 325]);
    assertNoSixInWindow(starts);
  });

  it("stays safe when a clean restart lands mid-burst (the reset-desync case)", () => {
    // 3 crashes, then a clean restart/deploy at t=45 (counts as a start in the
    // ledger, exactly as systemd counts it), then more crashes.
    const startTimes: number[] = [];
    let t = 0;
    let ledger: number[] = [];
    // 3 crashes
    for (let i = 0; i < 3; i++) {
      startTimes.push(t);
      const { starts, delaySec } = planStartup(ledger, t * 1000);
      ledger = starts;
      t += delaySec + RESTART_SEC;
    }
    // clean restart at current t, then 3 more crashes
    for (let i = 0; i < 4; i++) {
      startTimes.push(t);
      const { starts, delaySec } = planStartup(ledger, t * 1000);
      ledger = starts;
      t += delaySec + RESTART_SEC;
    }
    assertNoSixInWindow(startTimes);
  });
});

describe("enforceStartupBackoff", () => {
  let dir: string;
  let cbPath: string;
  const okAlert = vi.fn(async () => true);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-"));
    cbPath = path.join(dir, "circuit-breaker.json");
    okAlert.mockClear();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("records the start and does not sleep on a clean first start", async () => {
    const sleep = vi.fn(async () => {});
    await enforceStartupBackoff({ cbPath, now: () => new Date(T0), sleep, alert: okAlert });
    expect(sleep).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(cbPath, "utf-8")).starts).toEqual([T0]);
  });

  it("sleeps the scheduled backoff on a repeated crash", async () => {
    fs.writeFileSync(cbPath, JSON.stringify({ starts: [T0 - sec(20), T0 - sec(10)] }));
    const sleep = vi.fn(async () => {});
    await enforceStartupBackoff({ cbPath, now: () => new Date(T0), sleep, alert: okAlert });
    expect(sleep).toHaveBeenCalledWith(sec(30)); // 3rd in-window start → 30s
  });

  it("alerts on a persistent loop and records success", async () => {
    fs.writeFileSync(cbPath, JSON.stringify({ starts: [T0 - 3, T0 - 2, T0 - 1] })); // this makes attempt 4
    await enforceStartupBackoff({ cbPath, now: () => new Date(T0), sleep: async () => {}, alert: okAlert });
    expect(okAlert).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(cbPath, "utf-8")).lastAlertAt).toBe(T0);
  });

  it("does not re-alert within the cooldown", async () => {
    fs.writeFileSync(cbPath, JSON.stringify({ starts: [T0 - 3, T0 - 2, T0 - 1], lastAlertAt: T0 - sec(60) }));
    await enforceStartupBackoff({ cbPath, now: () => new Date(T0), sleep: async () => {}, alert: okAlert });
    expect(okAlert).not.toHaveBeenCalled();
  });

  it("retries the alert on the next crash when delivery fails", async () => {
    const failAlert = vi.fn(async () => false);
    fs.writeFileSync(cbPath, JSON.stringify({ starts: [T0 - 3, T0 - 2, T0 - 1] }));
    await enforceStartupBackoff({ cbPath, now: () => new Date(T0), sleep: async () => {}, alert: failAlert });
    expect(failAlert).toHaveBeenCalledTimes(1);
    // lastAlertAt NOT set → the next start is still "cooled" and will retry.
    expect(JSON.parse(fs.readFileSync(cbPath, "utf-8")).lastAlertAt).toBeUndefined();
  });

  it("resetCircuitBreaker removes the state file", () => {
    fs.writeFileSync(cbPath, JSON.stringify({ starts: [T0] }));
    resetCircuitBreaker(cbPath);
    expect(fs.existsSync(cbPath)).toBe(false);
  });
});
