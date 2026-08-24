import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock config before importing group-mapping so MAIN_CHAT_ID can be controlled
vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js");
  return { ...actual, MAIN_CHAT_ID: "tg-999" };
});

import { chatIdToGroup, groupToChatId } from "./group-mapping.js";

describe("chatIdToGroup", () => {
  it("maps MAIN_CHAT_ID to 'main'", () => {
    expect(chatIdToGroup("tg", "999")).toBe("main");
  });

  it("does not match main for a different channel prefix", () => {
    // MAIN_CHAT_ID is "tg-999", so "wa-999" should NOT map to main
    expect(chatIdToGroup("wa", "999")).toBe("wa-999");
  });

  it("maps other chat IDs to '{prefix}-{chatId}'", () => {
    expect(chatIdToGroup("tg", "123456")).toBe("tg-123456");
  });

  it("handles negative chat IDs (Telegram group chats)", () => {
    expect(chatIdToGroup("tg", "-1001234567")).toBe("tg--1001234567");
  });

  it("works with different channel prefixes", () => {
    expect(chatIdToGroup("wa", "15551234567")).toBe("wa-15551234567");
  });
});

describe("groupToChatId", () => {
  it("returns MAIN_CHAT_ID for 'main' group", () => {
    expect(groupToChatId("main")).toBe("999");
  });

  it("strips channel prefix from group name", () => {
    expect(groupToChatId("tg-123456")).toBe("123456");
  });

  it("handles negative chat IDs in group name", () => {
    expect(groupToChatId("tg--1001234567")).toBe("-1001234567");
  });

  it("rejects non-Telegram channel prefixes", () => {
    expect(groupToChatId("wa-15551234567")).toBeNull();
  });

  it("returns null for unrecognized group names", () => {
    expect(groupToChatId("UPPERCASE-123")).toBeNull();
    expect(groupToChatId("no-prefix-match-123")).toBeNull();
  });
});
