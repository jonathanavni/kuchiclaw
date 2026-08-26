import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_OUTPUT_BYTES, RESULT_ENVELOPE_VERSION, RESULT_FILENAME } from "./config.js";
import { OutputVerificationError } from "./container-errors.js";
import { outputFailure, readSignedResult } from "./result-file.js";

const KEY = "ab".repeat(32);

let runDir: string;

beforeEach(() => {
  runDir = fs.mkdtempSync(path.join(os.tmpdir(), "kuchiclaw-result-"));
});

afterEach(() => {
  fs.rmSync(runDir, { recursive: true, force: true });
});

function sign(payload: string, key = KEY): string {
  return createHmac("sha256", Buffer.from(key, "hex")).update(payload, "utf8").digest("hex");
}

function writeEnvelope(payload: string, overrides: Record<string, unknown> = {}) {
  const envelope = { v: RESULT_ENVELOPE_VERSION, hmac: sign(payload), payload, ...overrides };
  fs.writeFileSync(path.join(runDir, RESULT_FILENAME), JSON.stringify(envelope));
}

describe("readSignedResult", () => {
  it("returns ok for a correctly signed success payload", () => {
    writeEnvelope(JSON.stringify({ status: "success", result: "done" }));
    expect(readSignedResult(runDir, KEY)).toEqual({
      kind: "ok",
      output: { status: "success", result: "done" },
    });
  });

  it("returns ok for a correctly signed error payload", () => {
    writeEnvelope(JSON.stringify({ status: "error", error: "Agent stopped: refusal" }));
    expect(readSignedResult(runDir, KEY)).toMatchObject({ kind: "ok" });
  });

  it("returns missing when no file exists", () => {
    expect(readSignedResult(runDir, KEY)).toEqual({ kind: "missing" });
  });

  it.each([
    ["non-JSON file", "{ not json", /not JSON/],
    ["non-object envelope", "42", /not an object/],
  ])("returns invalid for a %s", (_label, contents, reason) => {
    fs.writeFileSync(path.join(runDir, RESULT_FILENAME), contents);
    expect(readSignedResult(runDir, KEY)).toMatchObject({ kind: "invalid", reason: expect.stringMatching(reason) });
  });

  it("returns invalid for a wrong envelope version", () => {
    writeEnvelope(JSON.stringify({ status: "success" }), { v: RESULT_ENVELOPE_VERSION + 1 });
    expect(readSignedResult(runDir, KEY)).toMatchObject({ kind: "invalid", reason: expect.stringMatching(/version/) });
  });

  it("returns invalid when hmac or payload is not a string", () => {
    writeEnvelope(JSON.stringify({ status: "success" }), { hmac: 7 });
    expect(readSignedResult(runDir, KEY)).toMatchObject({ kind: "invalid", reason: "malformed envelope" });
  });

  it("returns invalid for a payload signed with a different key", () => {
    const payload = JSON.stringify({ status: "success", result: "forged" });
    writeEnvelope(payload, { hmac: sign(payload, "00".repeat(32)) });
    expect(readSignedResult(runDir, KEY)).toMatchObject({ kind: "invalid", reason: "HMAC verification failed" });
  });

  it("returns invalid when the signed payload is not JSON or has no status", () => {
    writeEnvelope("not json");
    expect(readSignedResult(runDir, KEY)).toMatchObject({ kind: "invalid", reason: "payload is not JSON" });
    writeEnvelope(JSON.stringify({ result: "no status field" }));
    expect(readSignedResult(runDir, KEY)).toMatchObject({ kind: "invalid", reason: "payload has no valid status" });
  });

  it("returns invalid for an oversized file", () => {
    fs.writeFileSync(path.join(runDir, RESULT_FILENAME), Buffer.alloc(MAX_OUTPUT_BYTES + 10, 0x78));
    expect(readSignedResult(runDir, KEY)).toMatchObject({ kind: "invalid" });
  });

  it("returns invalid for a symlinked result file (O_NOFOLLOW)", () => {
    const decoy = path.join(runDir, "decoy.json");
    fs.writeFileSync(decoy, "{}");
    fs.symlinkSync(decoy, path.join(runDir, RESULT_FILENAME));
    expect(readSignedResult(runDir, KEY)).toMatchObject({ kind: "invalid" });
  });

  it("returns invalid for a hardlinked result file (nlink > 1)", () => {
    const payload = JSON.stringify({ status: "success" });
    const original = path.join(runDir, "original.json");
    fs.writeFileSync(original, JSON.stringify({ v: RESULT_ENVELOPE_VERSION, hmac: sign(payload), payload }));
    fs.linkSync(original, path.join(runDir, RESULT_FILENAME));
    expect(readSignedResult(runDir, KEY)).toMatchObject({ kind: "invalid" });
  });
});

describe("outputFailure", () => {
  it("maps invalid reads to a non-retryable error carrying the reason", () => {
    const err = outputFailure({ kind: "invalid", reason: "HMAC verification failed" }, 1, "out", "err");
    expect(err).toBeInstanceOf(OutputVerificationError);
    expect(err.message).toMatch(/invalid result \(HMAC verification failed\)/);
  });

  it("maps missing reads to a no-result error with bounded diagnostics", () => {
    const err = outputFailure({ kind: "missing" }, 0, "x".repeat(1000), "y".repeat(1000));
    expect(err).toBeInstanceOf(OutputVerificationError);
    expect(err.message).toMatch(/no result file/);
    // stdout/stderr are folded in bounded to 500 chars each.
    expect(err.message.length).toBeLessThan(1200);
  });
});
