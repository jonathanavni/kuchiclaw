import { afterEach, describe, expect, it, vi } from "vitest";

const originalPort = process.env.INSTANCE_LOCK_PORT;

afterEach(() => {
  if (originalPort === undefined) delete process.env.INSTANCE_LOCK_PORT;
  else process.env.INSTANCE_LOCK_PORT = originalPort;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("numeric environment configuration", () => {
  it.each(["not-a-number", "12oops", "0", "65536", "1.5"])(
    "warns and falls back for invalid INSTANCE_LOCK_PORT=%s",
    async (configured) => {
      process.env.INSTANCE_LOCK_PORT = configured;
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { INSTANCE_LOCK_PORT } = await import("./config.js");

      expect(INSTANCE_LOCK_PORT).toBe(47_671);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(`Invalid INSTANCE_LOCK_PORT=${JSON.stringify(configured)}`),
      );
    },
  );

  it("accepts a valid custom instance-lock port", async () => {
    process.env.INSTANCE_LOCK_PORT = "48765";
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { INSTANCE_LOCK_PORT } = await import("./config.js");

    expect(INSTANCE_LOCK_PORT).toBe(48_765);
    expect(warning).not.toHaveBeenCalled();
  });
});
