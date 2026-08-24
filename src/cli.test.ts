import { describe, expect, it, vi } from "vitest";

// Force the no-main configuration regardless of any ambient .env — these tests
// assert the CLI's behavior when MAIN_CHAT_ID is unset. (Same config-mock
// convention as ipc.test.ts.)
vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js");
  return { ...actual, MAIN_CHAT_ID: "" };
});

import { main, validateCliGroup } from "./cli.js";

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
