# TOOLS.md

Tools available to you inside the container.

## File Tools
- **Read** — Read file contents
- **Write** — Create or overwrite a file
- **Edit** — Replace specific text in a file (preferred over Write for modifications)
- **Glob** — Find files by pattern (e.g., `**/*.md`)
- **Grep** — Search file contents with regex

## Shell
- **Bash** — Run shell commands. You have git available.

## Web
- **WebSearch** — Search the web. Use for current events, facts, or anything you're unsure about.
- **WebFetch** — Fetch and read the contents of a URL.

## IPC (Inter-Process Communication)

You can request messages and scheduled-task operations by atomically placing JSON files in `/workspace/ipc/`. The host derives your identity from this mounted directory; requests do not supply a group.

**Send a message:**
```bash
tmp=/workspace/ipc/msg-$(date +%s%N).tmp
cat > "$tmp" << 'EOF'
{
  "op": "message",
  "chatId": "<target chat ID>",
  "text": "Hello from the agent!"
}
EOF
mv "$tmp" "${tmp%.tmp}.json"
```

- Use unique filenames (timestamp-based) to avoid collisions
- Always write a `.tmp` file completely and then rename it to `.json`; the host ignores non-JSON files
- The file is deleted after processing; failed requests are quarantined by the host
- Your chat ID, the current time, and your timezone are in the **Session Context** section of your system prompt
- **Scoping:** Non-main groups can only message their own chat and manage their own tasks. The `main` group has full access to all chats and tasks.

**Create a scheduled task:**
```bash
tmp=/workspace/ipc/task-$(date +%s%N).tmp
cat > "$tmp" << 'EOF'
{
  "op": "task_create",
  "chatId": "<target chat ID>",
  "prompt": "Check my inbox and summarize unread emails",
  "scheduleType": "cron",
  "scheduleValue": "0 8 * * *",
  "label": "morning briefing"
}
EOF
mv "$tmp" "${tmp%.tmp}.json"
```

Schedule types:
- `cron` — cron expression (e.g., `"0 */6 * * *"` for every 6 hours). **Cron expressions are interpreted in the timezone shown in your Session Context** — write the local wall-clock time you want (e.g. `"0 8 * * *"` = 8 AM local), do not pre-convert to UTC. On a DST transition day a firing may shift or skip; that is expected.
- `interval` — milliseconds between runs (e.g., `"3600000"` for 1 hour)
- `once` — ISO 8601 timestamp for a one-shot task (e.g., `"2026-03-15T10:00:00Z"`)

**Pause/resume/cancel a task:**
```bash
tmp=/workspace/ipc/task-$(date +%s%N).tmp
cat > "$tmp" << 'EOF'
{
  "op": "task_pause",
  "chatId": "<target chat ID>",
  "taskId": 1
}
EOF
mv "$tmp" "${tmp%.tmp}.json"
```
Replace `task_pause` with `task_resume` or `task_cancel` as needed.

**List scheduled tasks:**
```bash
tmp=/workspace/ipc/task-$(date +%s%N).tmp
cat > "$tmp" << 'EOF'
{
  "op": "task_list",
  "chatId": "<target chat ID>"
}
EOF
mv "$tmp" "${tmp%.tmp}.json"
```

## Skills

Scripts in `/workspace/skills/` provide additional capabilities. They are read-only.

### echo (proof of concept)
```bash
bash /workspace/skills/echo.sh "your message"
```

### fastmail (email)

Send and read email as koochi@fastmail.com.

**Send an email:**
```bash
node /workspace/skills/fastmail.mjs send "recipient@example.com" "Subject line" "Email body text"
```

**List recent inbox emails:**
```bash
node /workspace/skills/fastmail.mjs inbox        # default 10
node /workspace/skills/fastmail.mjs inbox 5      # limit to 5
```
Output shows: unread marker (*), message ID, date, sender, subject.

**Read a specific email:**
```bash
node /workspace/skills/fastmail.mjs read <messageId>
```

**Reply to an email:**
```bash
node /workspace/skills/fastmail.mjs reply <messageId> "Reply body text"
```
Threading headers (In-Reply-To, References) are set automatically.

### gcal (family Google Calendar — preferred for family events)

Directly create, edit, and delete events on the shared family calendar (and any other calendar shared with the agent's service account). Changes appear in everyone's Google Calendar automatically — no invitations involved. **Use this for family events; use the `calendar` skill below only to invite people outside the shared calendar.**

**List accessible calendars (IDs + roles):**
```bash
node /workspace/skills/gcal.mjs calendars
```
Save the family calendar's ID to MEMORY.md the first time you see it. If a newly shared calendar doesn't appear, subscribe once: `node /workspace/skills/gcal.mjs subscribe <calendarId>`.

**Upcoming events / search:**
```bash
node /workspace/skills/gcal.mjs agenda <calendarId> [days]      # default 7
node /workspace/skills/gcal.mjs find <calendarId> "dentist" [days]   # default 60
```
Output lines start with `[eventId]` — you need the eventId to update or delete.

**Create an event (preferred — file-based, shell-safe):** write the event as JSON to a file with your file tools, then:
```bash
node /workspace/skills/gcal.mjs create-json <calendarId> /tmp/event.json
```
where the file contains e.g. `{"summary":"Dinner with the Cohens","start":"2026-08-30T18:00:00","end":"2026-08-30T20:00:00","description":"...","location":"..."}`.

**Never interpolate event titles/descriptions into a bash command line** — text like `Pay $100` or anything with quotes/backticks gets mangled or executed by the shell. The file-based form avoids this entirely. The inline form is acceptable only for plain alphanumeric text:
```bash
node /workspace/skills/gcal.mjs create <calendarId> "Dentist" "2026-08-30T18:00:00" "2026-08-30T19:00:00"
```
Datetimes without an offset are interpreted in America/Chicago (the household zone). Bare dates (`2026-08-30`) create all-day events — the end date is exclusive, so a one-day event on the 30th ends `2026-08-31`.

**Update / delete:**
```bash
node /workspace/skills/gcal.mjs update-json <calendarId> <eventId> /tmp/patch.json
node /workspace/skills/gcal.mjs delete <calendarId> <eventId>
```
The patch JSON may contain any of: `summary`, `start`, `end`, `description`, `location`.

**Recurring events:** listings expand a series into instances; recurring instances are labeled `(recurring — series id: ...)`. Updating/deleting with the **instance id** changes only that occurrence; use the **series id** as the eventId to change or delete the whole series. Confirm with the user which scope they mean before mutating a recurring event.

### calendar (email invites — for people OUTSIDE the shared family calendar)

Create, update, and cancel Google Calendar events by sending iCalendar (.ics) email invitations. Recipients' Gmail auto-detects the invite and adds it to their calendar. Prefer `gcal` for family events; use this when someone must be *invited* (e.g., guests without access to the family calendar).

**Create an event:**
```bash
node /workspace/skills/calendar.mjs create '{"title":"Dentist","start":"2026-04-15T10:00:00+03:00","duration":"1h","attendees":["jon@gmail.com","wife@gmail.com"],"location":"Dr Smith","description":"Annual checkup"}'
```

Fields:
- `title` (required) — event name
- `start` (required) — ISO 8601 datetime with timezone offset (e.g., `-05:00` for Austin daylight time, `-06:00` standard; family in Israel is `+03:00`/`+02:00`)
- `duration` (required, or use `end`) — human format (`1h`, `30m`, `1h30m`) or ISO 8601 (`PT1H30M`)
- `end` — ISO 8601 datetime (alternative to `duration`)
- `attendees` (required) — array of email addresses to invite
- `location` — event location
- `description` — event description

Returns a `UID` — **save this to MEMORY.md** so you can update or cancel the event later.

**Update an event:**
```bash
node /workspace/skills/calendar.mjs update "<uid>" '{"title":"Dentist (rescheduled)","start":"2026-04-16T10:00:00+03:00","duration":"1h","attendees":["jon@gmail.com","wife@gmail.com"],"sequence":1}'
```

Must include all original attendees. The `sequence` field should increment with each update (1 for first update, 2 for second, etc.).

**Cancel an event:**
```bash
node /workspace/skills/calendar.mjs cancel "<uid>" '{"attendees":["jon@gmail.com","wife@gmail.com"],"title":"Dentist"}'
```

Must include all original attendees so they receive the cancellation.

## Workspace

Your workspace is `/workspace`. You can read and write files here.

Key files and directories mounted in your workspace:
- `SOUL.md` — Your personality and behavior rules (read-only)
- `TOOLS.md` — This file (read-only)
- `HEARTBEAT.md` — Self-maintenance checklist (read-only). Follow this when running as a heartbeat task.
- `MEMORY.md` — Your long-term memory (read-write). Update this with durable facts.
- `CONTEXT.md` — Session scratchpad (read-write). Use for working notes.
- `ipc/` — Write JSON files here to trigger host-side actions (see IPC section)
- `skills/` — CLI scripts and tools (read-only, see Skills section)

## Constraints
- No access to files outside `/workspace`
- Sessions are ephemeral — the container is destroyed after each invocation
- Your only persistent storage is MEMORY.md and CONTEXT.md
