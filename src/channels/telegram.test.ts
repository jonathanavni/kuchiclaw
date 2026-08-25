import { describe, expect, it } from "vitest";
import { isAllowedSender } from "./telegram.js";

// The allowlist is passed explicitly so tests don't depend on process.env.
describe("isAllowedSender (P6.6 fail-closed)", () => {
  it("allows a listed sender", () => {
    expect(isAllowedSender("7", ["7", "8"])).toBe(true);
  });

  it("drops an unlisted sender", () => {
    expect(isAllowedSender("9", ["7", "8"])).toBe(false);
  });

  it("drops a message with no resolvable sender ID", () => {
    expect(isAllowedSender(undefined, ["7"])).toBe(false);
  });

  it("drops everyone on an empty allowlist (belt to the startup gate's braces)", () => {
    expect(isAllowedSender("7", [])).toBe(false);
    expect(isAllowedSender(undefined, [])).toBe(false);
  });

  it("explicit '*' allows anyone, including senderless messages", () => {
    expect(isAllowedSender("9", ["*"])).toBe(true);
    expect(isAllowedSender(undefined, ["*"])).toBe(true);
  });
});
