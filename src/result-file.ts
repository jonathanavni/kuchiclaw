// Reads and verifies the HMAC-signed container result file (P5.1 transport).
// Pure with respect to runner state: (runDir, outputKey) → discriminated result.

import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { MAX_OUTPUT_BYTES, RESULT_ENVELOPE_VERSION, RESULT_FILENAME } from "./config.js";
import { OutputVerificationError } from "./container-errors.js";
import { readBoundedFile } from "./bounded-read.js";
import type { ContainerOutput } from "./types.js";

/** Result of reading the signed result file. `invalid` is tamper/corruption
 *  (non-retryable); `missing` is no file at all (the container never emitted). */
export type SignedRead =
  | { kind: "ok"; output: ContainerOutput }
  | { kind: "missing" }
  | { kind: "invalid"; reason: string };

/** Read and verify the container's signed result file. Never throws for an
 *  expected condition (missing, symlinked, oversized, tampered) — those become
 *  a discriminated result so the runner finalizer's no-throw invariant holds. */
export function readSignedResult(runDir: string, outputKey: string): SignedRead {
  const file = path.join(runDir, RESULT_FILENAME);
  let raw: string;
  try {
    raw = readBoundedFile(file, MAX_OUTPUT_BYTES, "container result");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    // ELOOP (symlink under O_NOFOLLOW), size cap, nlink≠1, non-regular → tamper.
    return { kind: "invalid", reason: formatError(err) };
  }

  let envelope: unknown;
  try { envelope = JSON.parse(raw); } catch { return { kind: "invalid", reason: "result is not JSON" }; }
  if (!envelope || typeof envelope !== "object") return { kind: "invalid", reason: "envelope is not an object" };
  const { v, hmac, payload } = envelope as Record<string, unknown>;
  if (v !== RESULT_ENVELOPE_VERSION) return { kind: "invalid", reason: `unexpected envelope version ${String(v)}` };
  if (typeof hmac !== "string" || typeof payload !== "string") return { kind: "invalid", reason: "malformed envelope" };

  const expected = createHmac("sha256", Buffer.from(outputKey, "hex")).update(payload, "utf8").digest();
  const provided = Buffer.from(hmac, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { kind: "invalid", reason: "HMAC verification failed" };
  }

  let output: unknown;
  try { output = JSON.parse(payload); } catch { return { kind: "invalid", reason: "payload is not JSON" }; }
  if (!output || typeof output !== "object") return { kind: "invalid", reason: "payload is not an object" };
  const status = (output as { status?: unknown }).status;
  if (status !== "success" && status !== "error") return { kind: "invalid", reason: "payload has no valid status" };
  return { kind: "ok", output: output as ContainerOutput };
}

/** Turn a non-ok signed read into the OutputVerificationError the queue treats
 *  as non-retryable, folding in bounded stdout/stderr for diagnostics. */
export function outputFailure(read: SignedRead, code: number | null, stdout: string, stderr: string): Error {
  const detail = read.kind === "invalid" ? `invalid result (${read.reason})` : "no result file";
  return new OutputVerificationError(
    `Container exited with code ${code}: ${detail}.\n` +
    `stderr: ${stderr.slice(0, 500)}\nstdout: ${stdout.slice(0, 500)}`,
  );
}

export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
