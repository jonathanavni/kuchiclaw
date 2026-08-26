#!/usr/bin/env node

// Google Calendar skill — manage the shared family calendar (and any calendar
// shared to the service account) via the Calendar REST API.
//
// Auth: GCP service account, self-signed RS256 JWT → access token. No refresh
// tokens, no consent screens — the headless-safe path (see BACKLOG research:
// bot-operated Gmail accounts are a suspension trap; user-OAuth expires).
//
// Usage:
//   node gcal.mjs calendars
//   node gcal.mjs subscribe <calendarId>   (once, after a calendar is shared to the account)
//   node gcal.mjs agenda <calendarId> [days=7]
//   node gcal.mjs find <calendarId> <query> [days=60]
//   node gcal.mjs create-json <calendarId> <jsonFile>          (preferred: no shell interpolation)
//   node gcal.mjs update-json <calendarId> <eventId> <jsonFile>
//   node gcal.mjs create <calendarId> <summary> <start> <end> [description] [location]
//   node gcal.mjs update <calendarId> <eventId> <jsonPatch>
//   node gcal.mjs delete <calendarId> <eventId>
//
// Times: ISO datetime ("2026-08-30T18:00:00") interpreted in TIME_ZONE below
// unless an explicit offset is given; bare dates ("2026-08-30") make an all-day
// event (end date is EXCLUSIVE per the Calendar API — a one-day event on the
// 30th needs end 2026-08-31).
// jsonPatch for update: {"summary": ..., "start": ..., "end": ..., "description": ..., "location": ...}
// with start/end in the same string formats as create.
//
// Requires GCAL_SERVICE_ACCOUNT_KEY in the environment (base64 of the service
// account's JSON key file).

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const API = "https://www.googleapis.com/calendar/v3";
// Matches the deployment's AGENT_TIMEZONE — cron, injected clock, and calendar
// events should agree on one zone.
const TIME_ZONE = "America/Chicago";

const RAW_KEY = process.env.GCAL_SERVICE_ACCOUNT_KEY;
if (!RAW_KEY) {
  console.error("Error: GCAL_SERVICE_ACCOUNT_KEY not set");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(Buffer.from(RAW_KEY, "base64").toString("utf-8"));
  if (!serviceAccount.client_email || !serviceAccount.private_key) throw new Error("missing fields");
} catch {
  console.error("Error: GCAL_SERVICE_ACCOUNT_KEY is not a base64-encoded service account JSON key");
  process.exit(1);
}

// --- Auth: self-signed JWT → short-lived access token ---

const base64url = (buf) => Buffer.from(buf).toString("base64url");

async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: serviceAccount.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${claims}`)
    .sign(serviceAccount.private_key, "base64url");

  const res = await fetch(serviceAccount.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("Token exchange returned no access token");
  }
  return body.access_token;
}

async function api(method, path, { query, body } = {}) {
  const token = await getAccessToken();
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

/** Follow nextPageToken so a short first page can't masquerade as "no events".
 *  Bounded; reports truncation explicitly instead of a definitive empty. */
async function listEvents(calendarId, query, cap = 250) {
  const items = [];
  let pageToken;
  do {
    const data = await api("GET", `/calendars/${encodeURIComponent(calendarId)}/events`, {
      query: { ...query, ...(pageToken ? { pageToken } : {}) },
    });
    items.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken && items.length < cap);
  return { items, truncated: Boolean(pageToken) };
}

// --- Time helpers ---

/** "2026-08-30" → all-day {date}; anything with a time → {dateTime, timeZone}.
 *  An explicit offset in the string wins over TIME_ZONE (Google ignores
 *  timeZone when dateTime carries an offset). */
function toEventTime(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  return { dateTime: value, timeZone: TIME_ZONE };
}

function formatEvent(ev) {
  const start = ev.start?.dateTime ?? ev.start?.date ?? "?";
  const end = ev.end?.dateTime ?? ev.end?.date ?? "?";
  const extras = [
    // Listing expands recurring series into instances; an instance id mutates
    // ONE occurrence, the series id mutates the whole series — label it so the
    // caller must choose the scope deliberately.
    ev.recurringEventId && `(recurring — series id: ${ev.recurringEventId})`,
    ev.location && `@ ${ev.location}`,
    ev.description && `— ${ev.description}`,
  ].filter(Boolean).join(" ");
  return `[${ev.id}] ${start} → ${end}  ${ev.summary ?? "(no title)"}${extras ? " " + extras : ""}`;
}

/** Read an event JSON payload from a file (written via the agent's file tools,
 *  so free-form text never passes through a shell). */
function readEventFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`Could not read event JSON from ${path}: ${err.message}`);
  }
  if (typeof parsed.start === "string") parsed.start = toEventTime(parsed.start);
  if (typeof parsed.end === "string") parsed.end = toEventTime(parsed.end);
  return parsed;
}

// --- Commands ---

async function calendars() {
  const data = await api("GET", "/users/me/calendarList");
  const items = data.items ?? [];
  if (items.length === 0) {
    console.log("No calendars are shared with the service account yet.");
    return;
  }
  for (const c of items) {
    console.log(`[${c.id}] ${c.summary} (${c.accessRole})`);
  }
}

// Sharing a calendar with a service account does NOT auto-add it to the
// account's calendarList — subscribe once with the calendar's ID and it shows
// up in `calendars` thereafter. (Events calls work with the raw ID either way.)
async function subscribe(calendarId) {
  const added = await api("POST", "/users/me/calendarList", { body: { id: calendarId } });
  console.log(`Subscribed: [${added.id}] ${added.summary} (${added.accessRole})`);
}

async function agenda(calendarId, days = "7") {
  const now = new Date();
  const max = new Date(now.getTime() + Number(days) * 86_400_000);
  const { items, truncated } = await listEvents(calendarId, {
    timeMin: now.toISOString(),
    timeMax: max.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
  });
  if (items.length === 0) {
    console.log(`No events in the next ${days} day(s).`);
    return;
  }
  for (const ev of items) console.log(formatEvent(ev));
  if (truncated) console.log("(more events exist — narrow the range)");
}

async function find(calendarId, query, days = "60") {
  const now = new Date();
  const max = new Date(now.getTime() + Number(days) * 86_400_000);
  const { items, truncated } = await listEvents(calendarId, {
    q: query,
    timeMin: now.toISOString(),
    timeMax: max.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
  });
  if (items.length === 0) {
    console.log(`No events matching "${query}" in the next ${days} day(s).`);
    return;
  }
  for (const ev of items) console.log(formatEvent(ev));
  if (truncated) console.log("(more matches exist — narrow the range or refine the query)");
}

async function create(calendarId, summary, start, end, description, location) {
  const event = {
    summary,
    start: toEventTime(start),
    end: toEventTime(end),
    ...(description ? { description } : {}),
    ...(location ? { location } : {}),
  };
  const created = await api("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, { body: event });
  console.log(`Created: ${formatEvent(created)}`);
}

/** File-based variants: free-form text (summaries, descriptions) reaches the
 *  event as file bytes, never as shell-interpolated argv — a `$(...)` in an
 *  event title must not execute in the container. */
async function createFromFile(calendarId, jsonPath) {
  const event = readEventFile(jsonPath);
  const created = await api("POST", `/calendars/${encodeURIComponent(calendarId)}/events`, { body: event });
  console.log(`Created: ${formatEvent(created)}`);
}

async function updateFromFile(calendarId, eventId, jsonPath) {
  const patch = readEventFile(jsonPath);
  const updated = await api(
    "PATCH",
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { body: patch },
  );
  console.log(`Updated: ${formatEvent(updated)}`);
}

async function update(calendarId, eventId, jsonPatch) {
  let patch;
  try {
    patch = JSON.parse(jsonPatch);
  } catch {
    throw new Error("update expects a JSON object, e.g. '{\"summary\":\"New title\"}'");
  }
  if (typeof patch.start === "string") patch.start = toEventTime(patch.start);
  if (typeof patch.end === "string") patch.end = toEventTime(patch.end);
  const updated = await api(
    "PATCH",
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { body: patch },
  );
  console.log(`Updated: ${formatEvent(updated)}`);
}

async function remove(calendarId, eventId) {
  await api("DELETE", `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
  console.log(`Deleted event ${eventId}`);
}

// --- Dispatch ---

const [cmd, ...args] = process.argv.slice(2);
const commands = {
  calendars: [calendars, 0],
  subscribe: [subscribe, 1],
  agenda: [agenda, 1],
  find: [find, 2],
  create: [create, 4],
  "create-json": [createFromFile, 2],
  update: [update, 3],
  "update-json": [updateFromFile, 3],
  delete: [remove, 2],
};

const entry = commands[cmd];
if (!entry) {
  console.error("Usage: gcal.mjs calendars | subscribe <cal> | agenda <cal> [days] | find <cal> <query> [days] | create-json <cal> <jsonFile> | update-json <cal> <eventId> <jsonFile> | create <cal> <summary> <start> <end> [desc] [loc] | update <cal> <eventId> <jsonPatch> | delete <cal> <eventId>");
  process.exit(1);
}
const [fn, minArgs] = entry;
if (args.length < minArgs) {
  console.error(`Error: "${cmd}" needs at least ${minArgs} argument(s)`);
  process.exit(1);
}
fn(...args).catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
