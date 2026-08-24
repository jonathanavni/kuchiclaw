import { describe, expect, it } from "vitest";
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
    await expect(main()).rejects.toThrow(/set MAIN_CHAT_ID or pass --group tg-<id>/);
    process.argv = argv;
  });
});
