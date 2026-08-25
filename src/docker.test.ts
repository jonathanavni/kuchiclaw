import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawn };
});

import { execDocker } from "./docker.js";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("execDocker", () => {
  it("returns a timed-out result when the child never closes", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawn.mockReturnValue(child);

    const resultPromise = execDocker(["ps"], 25);
    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).resolves.toMatchObject({ ok: false, code: null, timedOut: true });
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("returns nonzero exit as ok:false without throwing", async () => {
    const child = fakeChild();
    spawn.mockReturnValue(child);
    const resultPromise = execDocker(["image", "inspect", "missing"]);
    child.stderr.emit("data", Buffer.from("not found"));
    child.emit("close", 1);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      code: 1,
      stdout: "",
      stderr: "not found",
      timedOut: false,
    });
  });
});
