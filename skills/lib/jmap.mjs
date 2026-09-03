// Minimal JMAP client for Fastmail (RFC 8620 core, RFC 8621 mail).
//
// Split out of fastmail.mjs so the error handling below is testable: JMAP
// reports a failed method as a normal 200 response whose entry is
// ["error", {...}], which reads as an empty success unless something checks.

const API = "https://api.fastmail.com/jmap/api/";

export const MAIL_CAPABILITIES = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
export const SUBMISSION_CAPABILITIES = [...MAIL_CAPABILITIES, "urn:ietf:params:jmap:submission"];

export async function jmap(methodCalls, using = MAIL_CAPABILITIES) {
  const token = process.env.FASTMAIL_API_TOKEN;
  if (!token) throw new Error("FASTMAIL_API_TOKEN not set");

  const res = await fetch(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ using, methodCalls }),
  });
  // Never include the response body in this message: it is not known to be
  // free of anything sensitive, and the status is what a caller can act on.
  if (!res.ok) throw new Error(`JMAP request failed: ${res.status} ${res.statusText}`);

  const data = await res.json();
  if (!Array.isArray(data?.methodResponses)) throw new Error("JMAP: malformed response envelope");
  return data.methodResponses;
}

// Pull one method response out, refusing anything that is not the call we made.
// Without this a failed method silently yields `undefined` for `list`/`notUpdated`,
// so an API outage looks exactly like "no mail this week" -- which would quietly
// disable a digest whose whole job is to prove the pipeline still works.
export function unwrap(responses, index, expectedMethod) {
  const entry = responses?.[index];
  if (!Array.isArray(entry)) throw new Error(`JMAP: missing response at index ${index}`);

  const [method, payload] = entry;
  if (method === "error") {
    const type = payload?.type ?? "unknown";
    const detail = payload?.description ? ` (${payload.description})` : "";
    throw new Error(`JMAP ${expectedMethod} failed: ${type}${detail}`);
  }
  if (method !== expectedMethod) {
    throw new Error(`JMAP: expected ${expectedMethod}, got ${method}`);
  }
  return payload ?? {};
}

// RFC 8620 §1.2: an id is 1-255 octets of A-Za-z0-9_- . Avoiding a leading '-'
// is only a server-side SHOULD, so we must accept one -- rejecting it would make
// that message listable but never readable or markable, and the unread watermark
// would then re-surface it every single day. Shell/flag safety is handled by the
// "--" end-of-options marker in args.mjs, not by narrowing the grammar.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

export function isValidId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

export function assertValidIds(ids) {
  const bad = ids.filter((id) => !isValidId(id));
  if (bad.length > 0) {
    throw new Error(`Invalid message id(s): ${bad.map((b) => JSON.stringify(String(b).slice(0, 40))).join(", ")}`);
  }
  return ids;
}
