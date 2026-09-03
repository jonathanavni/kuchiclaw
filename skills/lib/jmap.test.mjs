import { describe, expect, it } from "vitest";
import { assertValidIds, isValidId, unwrap } from "./jmap.mjs";

describe("unwrap", () => {
  it("returns the payload of the expected method", () => {
    expect(unwrap([["Email/get", { list: [1] }, "0"]], 0, "Email/get")).toEqual({ list: [1] });
  });

  // JMAP reports a failed method inside a 200 response. Reading it as success
  // makes an API outage indistinguishable from "no mail this week", which
  // would silently disable the digest that exists to prove the pipeline works.
  it("throws on a JMAP method error rather than yielding an empty result", () => {
    const responses = [["error", { type: "accountNotFound", description: "no such account" }, "0"]];
    expect(() => unwrap(responses, 0, "Email/query")).toThrow(/Email\/query failed: accountNotFound/);
  });

  it("includes the error type even without a description", () => {
    expect(() => unwrap([["error", { type: "forbidden" }, "0"]], 0, "Email/set")).toThrow(/forbidden/);
  });

  it("throws when the response is a different method than requested", () => {
    expect(() => unwrap([["Mailbox/get", {}, "0"]], 0, "Email/get")).toThrow(/expected Email\/get, got Mailbox\/get/);
  });

  it("throws when the response is missing entirely", () => {
    expect(() => unwrap([], 0, "Email/get")).toThrow(/missing response at index 0/);
    expect(() => unwrap(undefined, 1, "Email/get")).toThrow(/missing response at index 1/);
  });

  it("returns an empty object when a method succeeds with no payload", () => {
    expect(unwrap([["Email/get", undefined, "0"]], 0, "Email/get")).toEqual({});
  });
});

describe("isValidId", () => {
  it("accepts the JMAP id grammar", () => {
    expect(isValidId("StmtPKRbOPjR")).toBe(true);
    expect(isValidId("a_b-c123")).toBe(true);
  });

  // Ids reach us from a listing the agent may have read out of hostile mail
  // and pasted into a shell command it built.
  it("rejects shell metacharacters and other injection shapes", () => {
    const hostile = [
      "abc; rm -rf /",
      "$(curl evil.test)",
      "a b",
      "a\nb",
      "a/../b",
      "",
      "x".repeat(256),
    ];
    for (const bad of hostile) {
      expect(isValidId(bad), `should reject ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  // RFC 8620 §1.2 only SHOULDs against a leading dash, so a conforming server
  // may issue one. Rejecting it would leave that message listable but never
  // readable or markable -- stuck unread, re-reported every day forever.
  it("accepts a leading dash, which the RFC permits", () => {
    expect(isValidId("-abc")).toBe(true);
    expect(isValidId("--weird")).toBe(true);
  });

  it("rejects non-strings", () => {
    expect(isValidId(undefined)).toBe(false);
    expect(isValidId(42)).toBe(false);
  });
});

describe("assertValidIds", () => {
  it("passes through a valid list", () => {
    expect(assertValidIds(["abc", "d_e-f"])).toEqual(["abc", "d_e-f"]);
  });

  it("names the offending ids", () => {
    expect(() => assertValidIds(["ok", "bad; id"])).toThrow(/Invalid message id/);
    expect(() => assertValidIds(["y".repeat(300)])).toThrow(/Invalid message id/);
  });
});
