#!/usr/bin/env node

// FastMail JMAP skill — send, read, and reply to email as Koochi.
//
// Usage:
//   node fastmail.mjs send "to@example.com" "Subject" "Body text"
//   node fastmail.mjs folders
//   node fastmail.mjs list <folder> [--unread] [--since 7d|ISO] [--limit N]
//   node fastmail.mjs inbox [--limit N]
//   node fastmail.mjs read <messageId> [--max-chars N] [--strip-urls]
//   node fastmail.mjs mark-read <messageId> [<messageId>...]
//   node fastmail.mjs reply <messageId> "Body text"
//
// Requires FASTMAIL_API_TOKEN in the environment.
//
// Everything a message carries -- body, subject, sender name -- is written by
// whoever sent it. All of it is sanitized and fenced before printing; see
// skills/lib/email-text.mjs.

import { randomUUID } from "node:crypto";
import { fenceUntrusted, htmlToText, sanitizeField, stripUrls } from "./lib/email-text.mjs";
import { assertValidIds, jmap, SUBMISSION_CAPABILITIES, unwrap } from "./lib/jmap.mjs";
import { intFlag, parseArgs, parseSince } from "./lib/args.mjs";

// Deployment-specific: this instance's Fastmail account and "send as" identity.
// They are opaque ids, not credentials -- useless without FASTMAIL_API_TOKEN --
// but they are wired to one account, so a fork of this repo needs its own.
// Get yours from the JMAP session endpoint (accountId) and Identity/get.
const ACCOUNT_ID = "u53d64052";
const IDENTITY_ID = "176981127"; // koochi@fastmail.com

const MAX_LIST = 50;            // cap a listing so one call can't flood the agent's context
const DEFAULT_LIST = 20;
const DEFAULT_MAX_CHARS = 4000; // per-email body budget for `read`
const MAX_MAX_CHARS = 20_000;

// --- Mailbox resolution ---

// JMAP's Mailbox name filter is a substring match, so an exact hit wins. Refuse
// an ambiguous match rather than guessing: Mailbox/get does not promise an
// order, so "first result" is not stable, and an unattended daily task quietly
// reading the wrong folder is worse than one that fails loudly.
async function resolveMailbox(name) {
  const res = await jmap([
    ["Mailbox/query", { accountId: ACCOUNT_ID, filter: { name } }, "0"],
    [
      "Mailbox/get",
      {
        accountId: ACCOUNT_ID,
        "#ids": { resultOf: "0", name: "Mailbox/query", path: "/ids" },
        properties: ["id", "name"],
      },
      "1",
    ],
  ]);

  const boxes = unwrap(res, 1, "Mailbox/get").list || [];
  if (boxes.length === 0) {
    throw new Error(`No mailbox named "${name}". Run: fastmail.mjs folders`);
  }

  // Require exactly one exact-name match. A unique *substring* hit is not the
  // folder that was asked for -- "Newsletters" would silently accept "Other
  // Newsletters", and this task marks what it reads, irreversibly.
  const exact = boxes.filter((b) => b.name.toLowerCase() === name.toLowerCase());
  if (exact.length === 1) return exact[0].id;

  const candidates = boxes.map((b) => sanitizeField(b.name, 80)).join(", ");
  throw new Error(
    exact.length === 0
      ? `No mailbox named exactly "${name}". Close matches: ${candidates}`
      : `"${name}" matches more than one mailbox (${candidates}). Folder names must be unique.`,
  );
}

async function resolveRole(role) {
  const res = await jmap([["Mailbox/query", { accountId: ACCOUNT_ID, filter: { role } }, "0"]]);
  const ids = unwrap(res, 0, "Mailbox/query").ids || [];
  if (ids.length === 0) throw new Error(`No mailbox with role "${role}" on this account.`);
  return ids[0];
}

// --- Commands ---

async function folders() {
  const res = await jmap([
    ["Mailbox/get", { accountId: ACCOUNT_ID, properties: ["id", "name", "totalEmails", "unreadEmails"] }, "0"],
  ]);
  for (const b of unwrap(res, 0, "Mailbox/get").list || []) {
    console.log(`${sanitizeField(b.name, 80)}  (${b.unreadEmails} unread / ${b.totalEmails} total)`);
  }
}

async function list(mailboxId, { unread = false, since = null, limit = DEFAULT_LIST } = {}) {
  // All properties of one FilterCondition are ANDed together (RFC 8620 §5.5).
  const filter = { inMailbox: mailboxId };
  if (unread) filter.notKeyword = "$seen";
  if (since) filter.after = since;

  const responses = await jmap([
    [
      "Email/query",
      {
        accountId: ACCOUNT_ID,
        filter,
        sort: [{ property: "receivedAt", isAscending: false }],
        limit: Math.min(limit, MAX_LIST),
      },
      "0",
    ],
    [
      "Email/get",
      {
        accountId: ACCOUNT_ID,
        "#ids": { resultOf: "0", name: "Email/query", path: "/ids" },
        properties: ["id", "from", "subject", "receivedAt", "keywords"],
      },
      "1",
    ],
  ]);

  unwrap(responses, 0, "Email/query");
  const emails = unwrap(responses, 1, "Email/get").list || [];
  if (emails.length === 0) {
    console.log("No emails found.");
    return;
  }

  // Email/get may return records in any order (RFC 8620), so the query's sort
  // does not survive the fetch. Re-sort, since a digest promises "by date".
  emails.sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));

  // Subjects and sender names are attacker-controlled; a newline in either
  // would forge an extra row that reads exactly like a real one.
  const rows = emails.map((e) => {
    const from = sanitizeField(e.from?.[0]?.email, 120) || "unknown";
    const unreadMark = e.keywords?.$seen ? " " : "*";
    const subject = sanitizeField(e.subject, 160) || "(no subject)";
    return `${unreadMark} ${e.id}  ${e.receivedAt}  ${from}  ${subject}`;
  });

  console.log(fenceUntrusted(rows.join("\n")));
}

async function read(messageId, { maxChars = DEFAULT_MAX_CHARS, dropUrls = false } = {}) {
  assertValidIds([messageId]);

  const responses = await jmap([
    [
      "Email/get",
      {
        accountId: ACCOUNT_ID,
        ids: [messageId],
        properties: ["id", "from", "to", "subject", "receivedAt", "textBody", "bodyValues", "messageId"],
        fetchTextBodyValues: true,
        // Cap at the source. Without this the whole body is pulled down and
        // then thrown away locally, handing a hostile sender an easy way to
        // make us do a lot of work on bytes we never print.
        maxBodyValueBytes: Math.min(maxChars, MAX_MAX_CHARS) * 8,
      },
      "0",
    ],
  ]);

  const email = unwrap(responses, 0, "Email/get").list?.[0];
  if (!email) throw new Error(`Email ${messageId} not found`);

  const addresses = (people) =>
    (people || []).map((a) => sanitizeField(`${a.name || ""} <${a.email || ""}>`.trim(), 160)).join(", ") || "unknown";

  // JMAP puts the text/html part in textBody when a message has no text/plain
  // alternative (RFC 8621 §4.1.4), so convert before printing or the agent
  // ends up summarizing markup.
  const bodyValues = email.bodyValues || {};
  let body = "";
  for (const part of email.textBody || []) {
    const value = bodyValues[part.partId]?.value;
    if (!value) continue;
    const type = String(part.type || "").toLowerCase();
    body += (type.startsWith("text/html") ? htmlToText(value) : value) + "\n";
  }
  body = dropUrls ? stripUrls(body) : body.trim();

  let truncated = false;
  if (body.length > maxChars) {
    body = body.slice(0, maxChars);
    truncated = true;
  }

  // Headers go INSIDE the fence with the body. A display name is as
  // attacker-controlled as any paragraph, so there is no trusted region here
  // beyond what this skill itself prints outside the delimiters.
  const content = [
    `From: ${addresses(email.from)}`,
    `To: ${addresses(email.to)}`,
    `Subject: ${sanitizeField(email.subject, 200) || "(no subject)"}`,
    `Date: ${sanitizeField(email.receivedAt, 40)}`,
    "",
    body,
    truncated ? `\n[truncated at ${maxChars} chars]` : "",
  ].join("\n");

  console.log(fenceUntrusted(content, randomUUID().slice(0, 8)));
}

async function markRead(ids) {
  assertValidIds(ids);

  const update = {};
  for (const id of ids) update[id] = { "keywords/$seen": true };

  const res = await jmap([["Email/set", { accountId: ACCOUNT_ID, update }, "0"]]);
  const notUpdated = unwrap(res, 0, "Email/set").notUpdated || {};
  const failed = Object.keys(notUpdated);
  if (failed.length > 0) throw new Error(`Failed to mark read: ${failed.join(", ")}`);

  console.log(`Marked ${ids.length} email(s) read.`);
}

async function draftsMailbox() {
  const res = await jmap([["Mailbox/query", { accountId: ACCOUNT_ID, filter: { role: "drafts" } }, "0"]]);
  const id = unwrap(res, 0, "Mailbox/query").ids?.[0];
  if (!id) throw new Error("No Drafts mailbox on this account.");
  return id;
}

// Create a draft and submit it in one round trip. Shared by send and reply;
// `extra` carries the threading headers when replying.
async function submit({ to, subject, body, extra = {} }, what) {
  const draftsId = await draftsMailbox();

  const responses = await jmap(
    [
      [
        "Email/set",
        {
          accountId: ACCOUNT_ID,
          create: {
            draft: {
              mailboxIds: { [draftsId]: true },
              from: [{ name: "Koochi", email: "koochi@fastmail.com" }],
              to: [{ email: to }],
              subject,
              bodyValues: { body: { value: body } },
              textBody: [{ partId: "body", type: "text/plain" }],
              ...extra,
            },
          },
        },
        "1",
      ],
      ["EmailSubmission/set", { accountId: ACCOUNT_ID, create: { sub: { emailId: "#draft", identityId: IDENTITY_ID } } }, "2"],
    ],
    SUBMISSION_CAPABILITIES,
  );

  const emailSet = unwrap(responses, 0, "Email/set");
  const subSet = unwrap(responses, 1, "EmailSubmission/set");
  if (emailSet.notCreated?.draft) throw new Error(`Failed to create ${what}: ${JSON.stringify(emailSet.notCreated.draft)}`);
  if (subSet.notCreated?.sub) throw new Error(`Failed to submit ${what}: ${JSON.stringify(subSet.notCreated.sub)}`);
}

async function send(to, subject, body) {
  await submit({ to, subject, body }, "draft");
  console.log(`Sent email to ${sanitizeField(to, 120)}.`);
}

async function reply(messageId, body) {
  assertValidIds([messageId]);

  const origRes = await jmap([
    ["Email/get", { accountId: ACCOUNT_ID, ids: [messageId], properties: ["from", "subject", "messageId", "references"] }, "0"],
  ]);
  const orig = unwrap(origRes, 0, "Email/get").list?.[0];
  if (!orig) throw new Error(`Email ${messageId} not found`);

  const replyTo = orig.from?.[0]?.email;
  if (!replyTo) throw new Error("Cannot determine reply address");

  const subject = orig.subject?.startsWith("Re: ") ? orig.subject : `Re: ${orig.subject || ""}`;

  await submit(
    {
      to: replyTo,
      subject,
      body,
      extra: {
        inReplyTo: orig.messageId || [],
        references: [...(orig.references || []), ...(orig.messageId || [])],
      },
    },
    "reply",
  );

  // The address and subject came from the original -- i.e. from a stranger.
  // A fixed acknowledgement is the only output here that cannot carry their text.
  console.log("Reply submitted.");
}

// --- CLI dispatch ---

function usage() {
  console.error("Commands: send, folders, list, inbox, read, mark-read, reply");
  console.error("  send <to> <subject> <body>");
  console.error("  folders");
  console.error("  list <folder> [--unread] [--since 7d|ISO] [--limit N]");
  console.error("  inbox [--limit N]                      # the account Inbox, by JMAP role");
  console.error("  read <messageId> [--max-chars N] [--strip-urls]");
  console.error("  mark-read <messageId> [<messageId>...]");
  console.error("  reply <messageId> <body>");
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional: args, flags } = parseArgs(rest);

  const listOptions = () => ({
    unread: flags.unread === true,
    since: flags.since === undefined ? null : parseSince(flags.since),
    limit: intFlag(flags, "limit", { fallback: DEFAULT_LIST, min: 1, max: MAX_LIST }),
  });

  switch (cmd) {
    case "send":
      if (args.length < 3) throw new Error("Usage: fastmail.mjs send <to> <subject> <body>");
      return send(args[0], args[1], args[2]);
    case "folders":
      return folders();
    case "list":
      if (!args[0]) throw new Error("Usage: fastmail.mjs list <folder> [--unread] [--since 7d] [--limit N]");
      return list(await resolveMailbox(args[0]), listOptions());
    case "inbox":
      return list(await resolveRole("inbox"), listOptions());
    case "read":
      if (!args[0]) throw new Error("Usage: fastmail.mjs read <messageId> [--max-chars N] [--strip-urls]");
      return read(args[0], {
        maxChars: intFlag(flags, "max-chars", { fallback: DEFAULT_MAX_CHARS, min: 1, max: MAX_MAX_CHARS }),
        dropUrls: flags["strip-urls"] === true,
      });
    case "mark-read":
      if (args.length === 0) throw new Error("Usage: fastmail.mjs mark-read <messageId> [<messageId>...]");
      return markRead(args);
    case "reply":
      if (args.length < 2) throw new Error("Usage: fastmail.mjs reply <messageId> <body>");
      return reply(args[0], args[1]);
    default:
      usage();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
