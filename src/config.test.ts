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

// Hermetic against ambient env: assert relative to the exported constants, not literals.
// Dynamic imports to match this file's vi.resetModules() convention.
describe("selectModels (P6.3)", () => {
  it("API-key path: cheap model, no fallback key at all", async () => {
    const { selectModels, API_KEY_MODEL } = await import("./config.js");
    expect(selectModels(true)).toEqual({ model: API_KEY_MODEL });
    expect(selectModels(true, "opus")).toEqual({ model: API_KEY_MODEL });
  });

  it("OAuth path: configured model + fallback", async () => {
    const { selectModels, AGENT_MODEL, AGENT_FALLBACK_MODEL } = await import("./config.js");
    expect(selectModels(false)).toEqual({
      model: AGENT_MODEL,
      ...(AGENT_MODEL === AGENT_FALLBACK_MODEL ? {} : { fallbackModel: AGENT_FALLBACK_MODEL }),
    });
  });

  it("omits the fallback when it equals the selected model — the SDK rejects the pair", async () => {
    const { selectModels, AGENT_FALLBACK_MODEL } = await import("./config.js");
    expect(selectModels(false, AGENT_FALLBACK_MODEL)).toEqual({ model: AGENT_FALLBACK_MODEL });
  });
});
