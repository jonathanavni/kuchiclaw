import { afterEach, describe, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => ({
  runContainer: vi.fn(),
  insertMessage: vi.fn(() => 1),
  updateMessageStatus: vi.fn(),
  getSecrets: vi.fn(async () => ({
    secrets: { CLAUDE_CODE_OAUTH_TOKEN: "auth-token" },
    isApiKeyFallback: false,
  })),
  getSkillSecrets: vi.fn((group: string) => group === "tg-123"
    ? { FASTMAIL_API_TOKEN: "fm-token" }
    : {}),
}));

// Force the no-main configuration regardless of any ambient .env — these tests
// assert the CLI's behavior when MAIN_CHAT_ID is unset. (Same config-mock
// convention as ipc.test.ts.)
vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js");
  return { ...actual, MAIN_CHAT_ID: "" };
});
vi.mock("./container-runner.js", () => ({ runContainer: effects.runContainer }));
vi.mock("./group-folder.js", () => ({ ensureGroupFolder: vi.fn(() => ({})) }));
vi.mock("./db.js", () => ({
  insertMessage: effects.insertMessage,
  updateMessageStatus: effects.updateMessageStatus,
  getRecentMessages: vi.fn(() => []),
  formatHistory: vi.fn(() => ""),
}));
vi.mock("./auth.js", () => ({
  getSecrets: effects.getSecrets,
  getSkillSecrets: effects.getSkillSecrets,
}));

import { main, validateCliGroup } from "./cli.js";
import { ContainerTerminationUnknownError } from "./container-errors.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("CLI group validation without a configured main chat", () => {
  it("rejects the default main group with remediation", () => {
    expect(() => validateCliGroup("main")).toThrow(
      /set MAIN_CHAT_ID or pass --group tg-<id>/,
    );
  });

  it("accepts a canonical Telegram group", () => {
    expect(() => validateCliGroup("tg-123")).not.toThrow();
  });

  it("refuses the actual default before reading a prompt", async () => {
    const argv = process.argv;
    process.argv = ["node", "src/cli.ts"];
    try {
      await expect(main()).rejects.toThrow(/set MAIN_CHAT_ID or pass --group tg-<id>/);
    } finally {
      process.argv = argv;
    }
  });
});

describe("CLI containment signaling", () => {
  it("scopes skill secrets by --group and keeps auth authoritative", async () => {
    const argv = process.argv;
    const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    effects.runContainer.mockResolvedValue({ status: "success", result: "ok" });

    try {
      process.argv = ["node", "src/cli.ts", "--group", "tg-123", "hello"];
      await main();
      process.argv = ["node", "src/cli.ts", "--group", "tg-456", "hello"];
      await main();

      expect(effects.runContainer.mock.calls[0][0].secrets).toEqual({
        FASTMAIL_API_TOKEN: "fm-token",
        CLAUDE_CODE_OAUTH_TOKEN: "auth-token",
      });
      expect(effects.runContainer.mock.calls[1][0].secrets).toEqual({
        CLAUDE_CODE_OAUTH_TOKEN: "auth-token",
      });
      expect(effects.getSkillSecrets).toHaveBeenNthCalledWith(1, "tg-123");
      expect(effects.getSkillSecrets).toHaveBeenNthCalledWith(2, "tg-456");
    } finally {
      process.argv = argv;
      if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });

  it("preserves a valid result while signaling exit code 1", async () => {
    const argv = process.argv;
    const priorExitCode = process.exitCode;
    const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    process.argv = ["node", "src/cli.ts", "--group", "tg-123", "hello"];
    process.exitCode = undefined;
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    effects.runContainer.mockImplementationOnce(async (_input, _paths, lifecycle) => {
      lifecycle.onContainmentFailure(
        new ContainerTerminationUnknownError(
          "Container kuchiclaw-tg-123-1-deadbeef termination could not be confirmed",
        ),
      );
      return { status: "success", result: "preserved result" };
    });

    try {
      await main();

      expect(log).toHaveBeenCalledWith("preserved result");
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/kuchiclaw-tg-123-1-deadbeef.*container may still be alive/),
      );
      expect(process.exitCode).toBe(1);
      expect(effects.updateMessageStatus).toHaveBeenCalledWith(1, "done");
      expect(effects.runContainer).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({ owner: "cli", onContainmentFailure: expect.any(Function) }),
      );
    } finally {
      process.argv = argv;
      process.exitCode = priorExitCode;
      if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });
});
