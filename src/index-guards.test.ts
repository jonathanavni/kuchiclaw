import { describe, it, expect, vi, afterEach } from "vitest";
import { installProcessGuards } from "./index.js";

/** Install the guards, returning the two handlers we just added (and a cleanup fn). */
function installAndCapture() {
  const before = {
    rejection: process.listeners("unhandledRejection").slice(),
    exception: process.listeners("uncaughtException").slice(),
  };
  installProcessGuards();
  const rejection = process.listeners("unhandledRejection").find((l) => !before.rejection.includes(l))!;
  const exception = process.listeners("uncaughtException").find((l) => !before.exception.includes(l))!;
  const cleanup = () => {
    process.removeListener("unhandledRejection", rejection);
    process.removeListener("uncaughtException", exception);
  };
  return { rejection, exception, cleanup };
}

afterEach(() => vi.restoreAllMocks());

describe("installProcessGuards", () => {
  it("registers one handler on each event", () => {
    const { rejection, exception, cleanup } = installAndCapture();
    expect(typeof rejection).toBe("function");
    expect(typeof exception).toBe("function");
    cleanup();
  });

  it("unhandledRejection is swallowed — the process keeps running (no exit)", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rejection, cleanup } = installAndCapture();

    expect(() => (rejection as (r: unknown) => void)(new Error("stray"))).not.toThrow();
    expect(exit).not.toHaveBeenCalled();
    cleanup();
  });

  it("uncaughtException exits(1) for a clean breaker-protected restart", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { exception, cleanup } = installAndCapture();

    (exception as (e: Error) => void)(new Error("boom"));
    expect(exit).toHaveBeenCalledWith(1);
    cleanup();
  });
});
