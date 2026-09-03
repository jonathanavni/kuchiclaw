#!/usr/bin/env node

// Calendar invite skill — create, update, and cancel Google Calendar events
// by sending iCalendar (.ics) emails via FastMail JMAP.
//
// Events are sent as email invitations with text/calendar MIME parts.
// Gmail auto-detects these and adds them to the recipient's Google Calendar.
//
// Usage:
//   node calendar.mjs create '{"title":"Dentist","start":"2026-04-15T10:00:00+03:00","duration":"1h","attendees":["a@gmail.com"],"location":"Dr Smith"}'
//   node calendar.mjs update "<uid>" '{"title":"Dentist","start":"2026-04-16T10:00:00+03:00","duration":"1h","attendees":["a@gmail.com"],"sequence":1}'
//   node calendar.mjs cancel "<uid>" '{"attendees":["a@gmail.com"],"title":"Dentist"}'
//
// Requires FASTMAIL_API_TOKEN in the environment.

import crypto from "node:crypto";

const API = "https://api.fastmail.com/jmap/api/";
// Deployment-specific: this instance's Fastmail account and "send as" identity.
// They are opaque ids, not credentials -- useless without FASTMAIL_API_TOKEN --
// but they are wired to one account, so a fork of this repo needs its own.
// Get yours from the JMAP session endpoint (accountId) and Identity/get.
const ACCOUNT_ID = "u53d64052";
const IDENTITY_ID = "176981127"; // koochi@fastmail.com
const ORGANIZER_EMAIL = "koochi@fastmail.com";
const ORGANIZER_NAME = "Kuchi";

const TOKEN = process.env.FASTMAIL_API_TOKEN;
if (!TOKEN) {
  console.error("Error: FASTMAIL_API_TOKEN not set");
  process.exit(1);
}

// --- JMAP helper (same pattern as fastmail.mjs) ---

async function jmap(methodCalls, using = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"]) {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ using, methodCalls }),
  });
  if (!res.ok) throw new Error(`JMAP request failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.methodResponses;
}

// --- iCalendar helpers ---

function generateUid() {
  return `${crypto.randomUUID()}@kuchiclaw`;
}

/** Convert ISO 8601 datetime to iCal UTC format: 20260415T070000Z */
function toIcsUtc(isoString) {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) throw new Error(`Invalid date: ${isoString}`);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Parse human duration ("1h", "30m", "1h30m") or ISO 8601 ("PT1H30M") to ms */
function parseDuration(dur) {
  if (dur.startsWith("PT")) {
    const hours = Number(dur.match(/(\d+)H/)?.[1] || 0);
    const minutes = Number(dur.match(/(\d+)M/)?.[1] || 0);
    return (hours * 60 + minutes) * 60_000;
  }
  const hours = Number(dur.match(/(\d+)h/i)?.[1] || 0);
  const minutes = Number(dur.match(/(\d+)m/)?.[1] || 0);
  if (!hours && !minutes) throw new Error(`Invalid duration: ${dur}`);
  return (hours * 60 + minutes) * 60_000;
}

/** Build a VCALENDAR string for an event invite, update, or cancellation */
function buildIcs({ method, uid, title, start, end, location, description, attendees, sequence = 0, status = "CONFIRMED" }) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//KuchiClaw//Calendar//EN",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${toIcsUtc(new Date().toISOString())}`,
    `DTSTART:${toIcsUtc(start)}`,
    `DTEND:${toIcsUtc(end)}`,
    `SUMMARY:${title}`,
    `SEQUENCE:${sequence}`,
    `STATUS:${status}`,
    `ORGANIZER;CN=${ORGANIZER_NAME}:mailto:${ORGANIZER_EMAIL}`,
  ];

  if (location) lines.push(`LOCATION:${location}`);
  if (description) lines.push(`DESCRIPTION:${description}`);

  for (const email of attendees) {
    lines.push(`ATTENDEE;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:${email}`);
  }

  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

// --- Send calendar email via JMAP ---

async function sendCalendarEmail({ to, subject, textBody, icsContent }) {
  const mbRes = await jmap([
    ["Mailbox/query", { accountId: ACCOUNT_ID, filter: { role: "drafts" } }, "0"],
  ]);
  const draftsId = mbRes[0][1].ids[0];

  // multipart/mixed with text/plain + text/calendar inline via bodyValues
  // (blob upload + attachments silently fails on FastMail; bodyStructure works)
  const responses = await jmap(
    [
      [
        "Email/set",
        {
          accountId: ACCOUNT_ID,
          create: {
            draft: {
              mailboxIds: { [draftsId]: true },
              from: [{ name: ORGANIZER_NAME, email: ORGANIZER_EMAIL }],
              to: to.map((email) => ({ email })),
              subject,
              bodyStructure: {
                type: "multipart/mixed",
                subParts: [
                  { type: "text/plain", partId: "text" },
                  { type: "text/calendar", partId: "ical" },
                ],
              },
              bodyValues: {
                text: { value: textBody },
                ical: { value: icsContent },
              },
            },
          },
        },
        "1",
      ],
      [
        "EmailSubmission/set",
        {
          accountId: ACCOUNT_ID,
          create: {
            sub: {
              emailId: "#draft",
              identityId: IDENTITY_ID,
            },
          },
        },
        "2",
      ],
    ],
    ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail", "urn:ietf:params:jmap:submission"],
  );

  if (responses[0][1].notCreated?.draft) {
    throw new Error(`Failed to create email: ${JSON.stringify(responses[0][1].notCreated.draft)}`);
  }
  if (responses[1][1].notCreated?.sub) {
    throw new Error(`Failed to submit email: ${JSON.stringify(responses[1][1].notCreated.sub)}`);
  }
}

// --- Commands ---

async function create(input) {
  const { title, start, duration, end: endInput, attendees, location, description } = input;

  if (!title || !start || !attendees?.length) {
    console.error("Required: title, start, attendees[]"); process.exit(1);
  }
  if (!duration && !endInput) {
    console.error("Required: duration or end"); process.exit(1);
  }

  const startDate = new Date(start);
  const end = endInput || new Date(startDate.getTime() + parseDuration(duration)).toISOString();
  const uid = generateUid();

  const ics = buildIcs({ method: "REQUEST", uid, title, start, end, location, description, attendees });

  const when = startDate.toLocaleString("en-IL", { dateStyle: "medium", timeStyle: "short" });
  const textBody = [
    `You're invited to: ${title}`,
    `When: ${when}`,
    location ? `Where: ${location}` : null,
    description || null,
    `\nOrganized by ${ORGANIZER_NAME}`,
  ].filter(Boolean).join("\n");

  await sendCalendarEmail({ to: attendees, subject: `Invitation: ${title}`, textBody, icsContent: ics });

  console.log(`Created event: "${title}" (${when})`);
  console.log(`UID: ${uid}`);
  console.log(`Sent to: ${attendees.join(", ")}`);
}

async function update(uid, input) {
  const { title, start, duration, end: endInput, attendees, location, description, sequence = 1 } = input;

  if (!attendees?.length) {
    console.error("Required: attendees[] (include all original attendees)"); process.exit(1);
  }
  if (!title || !start) {
    console.error("Required: title, start (full event details needed for update)"); process.exit(1);
  }
  if (!duration && !endInput) {
    console.error("Required: duration or end"); process.exit(1);
  }

  const startDate = new Date(start);
  const end = endInput || new Date(startDate.getTime() + parseDuration(duration)).toISOString();

  const ics = buildIcs({ method: "REQUEST", uid, title, start, end, location, description, attendees, sequence });

  const when = startDate.toLocaleString("en-IL", { dateStyle: "medium", timeStyle: "short" });
  const textBody = [
    `Updated event: ${title}`,
    `When: ${when}`,
    location ? `Where: ${location}` : null,
    description || null,
    `\nOrganized by ${ORGANIZER_NAME}`,
  ].filter(Boolean).join("\n");

  await sendCalendarEmail({ to: attendees, subject: `Updated: ${title}`, textBody, icsContent: ics });

  console.log(`Updated event: "${title}" (${when})`);
  console.log(`UID: ${uid}`);
  console.log(`Sent to: ${attendees.join(", ")}`);
}

async function cancel(uid, input) {
  const { attendees, title = "Event", sequence = 1 } = input;

  if (!attendees?.length) {
    console.error("Required: attendees[]"); process.exit(1);
  }

  // Cancellation needs valid dates but they don't matter — Gmail uses the UID to match
  const now = new Date().toISOString();
  const ics = buildIcs({ method: "CANCEL", uid, title, start: now, end: now, attendees, status: "CANCELLED", sequence });

  const textBody = `The event "${title}" has been cancelled.\n\nOrganized by ${ORGANIZER_NAME}`;

  await sendCalendarEmail({ to: attendees, subject: `Cancelled: ${title}`, textBody, icsContent: ics });

  console.log(`Cancelled event: "${title}"`);
  console.log(`UID: ${uid}`);
  console.log(`Sent to: ${attendees.join(", ")}`);
}

// --- CLI dispatch ---

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case "create":
    if (!args[0]) { console.error("Usage: calendar.mjs create '<json>'"); process.exit(1); }
    await create(JSON.parse(args[0]));
    break;
  case "update":
    if (args.length < 2) { console.error("Usage: calendar.mjs update <uid> '<json>'"); process.exit(1); }
    await update(args[0], JSON.parse(args[1]));
    break;
  case "cancel":
    if (args.length < 2) { console.error("Usage: calendar.mjs cancel <uid> '<json>'"); process.exit(1); }
    await cancel(args[0], JSON.parse(args[1]));
    break;
  default:
    console.error("Commands: create, update, cancel");
    console.error('  create \'{"title":"...","start":"ISO8601","duration":"1h","attendees":["..."],"location":"..."}\'');
    console.error('  update <uid> \'{"title":"...","start":"ISO8601","duration":"1h","attendees":["..."],"sequence":1}\'');
    console.error('  cancel <uid> \'{"attendees":["..."],"title":"..."}\'');
    process.exit(1);
}
