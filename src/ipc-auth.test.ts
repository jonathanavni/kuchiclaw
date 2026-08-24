import { describe, expect, it, vi } from "vitest";

vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js");
  return { ...actual, MAIN_CHAT_ID: "tg-999" };
});

import {
  assertDestinationAllowed,
  isCanonicalChatId,
  isValidGroupName,
  isValidMainChatId,
} from "./ipc-auth.js";

describe("canonical IPC identities", () => {
  it.each(["1", "-123", "9007199254740992", "-9007199254740992"])(
    "accepts canonical Telegram ID %s",
    (id) => expect(isCanonicalChatId(id)).toBe(true),
  );

  it.each([
    "0", "-0", "01", "1e3", "0x10", "--123", "-00123",
    "9007199254740993", "-9007199254740993",
  ])("rejects aliased or lossy Telegram ID %s", (id) => {
    expect(isCanonicalChatId(id)).toBe(false);
  });

  it.each(["tg-01", "tg-1e3", "tg-0x10", "tg--00123", "wa-123", "../ipc/main"])(
    "rejects invalid group %s",
    (group) => expect(isValidGroupName(group)).toBe(false),
  );

  it("requires an exact non-main group/chat round trip", () => {
    expect(() => assertDestinationAllowed("tg-123", false, "123")).not.toThrow();
    expect(() => assertDestinationAllowed("tg--123", false, "-123")).not.toThrow();
    expect(() => assertDestinationAllowed("tg-123", false, "124")).toThrow(/denied/);
    expect(() => assertDestinationAllowed("tg-999", false, "999")).toThrow(/denied/);
  });

  it("allows main to target any canonical destination", () => {
    expect(() => assertDestinationAllowed("main", true, "123")).not.toThrow();
    expect(() => assertDestinationAllowed("main", true, "01")).toThrow(/noncanonical/);
  });

  it("validates configured main IDs as Telegram canonical IDs", () => {
    expect(isValidMainChatId("tg--123")).toBe(true);
    expect(isValidMainChatId("whatsapp-99")).toBe(false);
    expect(isValidMainChatId("tg-01")).toBe(false);
  });
});
