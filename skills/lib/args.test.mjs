import { describe, expect, it } from "vitest";
import { intFlag, parseArgs, parseSince } from "./args.mjs";

describe("parseArgs", () => {
  it("separates positionals from flags", () => {
    expect(parseArgs(["Newsletters", "--limit", "5"])).toEqual({
      positional: ["Newsletters"],
      flags: { limit: "5" },
    });
  });

  it("treats a valueless flag as boolean true", () => {
    expect(parseArgs(["--unread"]).flags).toEqual({ unread: true });
  });

  // A flag whose value looks like a flag must not swallow the next flag.
  it("does not consume a following flag as a value", () => {
    expect(parseArgs(["--since", "--unread"]).flags).toEqual({ since: true, unread: true });
  });

  it("keeps multiple positionals in order", () => {
    expect(parseArgs(["a", "b", "c"]).positional).toEqual(["a", "b", "c"]);
  });

  // An id may legitimately start with a dash (RFC 8620 §1.2), so there has to
  // be a way to pass one without it being read as a flag.
  it("treats everything after a bare -- as positional", () => {
    expect(parseArgs(["--unread", "--", "--weird-id", "-abc"])).toEqual({
      positional: ["--weird-id", "-abc"],
      flags: { unread: true },
    });
  });

  it("handles an empty argv", () => {
    expect(parseArgs([])).toEqual({ positional: [], flags: {} });
  });
});

describe("intFlag", () => {
  it("returns the fallback when absent", () => {
    expect(intFlag({}, "limit", { fallback: 20 })).toBe(20);
  });

  it("parses a valid value", () => {
    expect(intFlag({ limit: "5" }, "limit", { fallback: 20 })).toBe(5);
  });

  // Silently defaulting a bad flag is worse than failing for an unattended
  // task: the run "succeeds" with the wrong window and nobody notices.
  it("rejects garbage rather than defaulting", () => {
    expect(() => intFlag({ limit: "5x" }, "limit", { fallback: 20 })).toThrow(/whole number/);
    expect(() => intFlag({ limit: "abc" }, "limit", { fallback: 20 })).toThrow(/whole number/);
    expect(() => intFlag({ limit: "1.5" }, "limit", { fallback: 20 })).toThrow(/whole number/);
  });

  it("rejects a flag given without a value", () => {
    expect(() => intFlag({ limit: true }, "limit", { fallback: 20 })).toThrow(/requires a value/);
  });

  // A negative max-chars previously produced a silently empty body.
  it("enforces the range at both ends", () => {
    expect(() => intFlag({ n: "-5000" }, "n", { fallback: 10, min: 1 })).toThrow(/at least 1/);
    expect(() => intFlag({ n: "0" }, "n", { fallback: 10, min: 1 })).toThrow(/at least 1/);
    expect(() => intFlag({ n: "99" }, "n", { fallback: 10, min: 1, max: 50 })).toThrow(/at most 50/);
  });
});

describe("parseSince", () => {
  it("accepts relative days and hours", () => {
    const sevenDays = Date.parse(parseSince("7d"));
    expect(Math.round((Date.now() - sevenDays) / 86400000)).toBe(7);

    const thirtySixHours = Date.parse(parseSince("36h"));
    expect(Math.round((Date.now() - thirtySixHours) / 3600000)).toBe(36);
  });

  it("accepts an ISO timestamp and normalizes it to UTC", () => {
    expect(parseSince("2026-09-01T12:00:00Z")).toBe("2026-09-01T12:00:00.000Z");
  });

  it("rejects unparseable input with a helpful message", () => {
    expect(() => parseSince("last tuesday")).toThrow(/Invalid --since/);
    expect(() => parseSince(true)).toThrow(/requires a value/);
  });

  // Previously threw an uncaught RangeError out of the relative branch.
  it("rejects an out-of-range relative value cleanly", () => {
    expect(() => parseSince("99999999999d")).toThrow(/out of range/);
  });
});
