# KuchiClaw — Architecture

("Kuchi" — a nickname meaning "tiny one." This is the tiny claw.)

KuchiClaw is a minimal AI agent framework built from scratch for learning and personal use. It's inspired by [NanoClaw](https://github.com/qwibitai/nanoclaw) (~3,900 lines, 15 files), which itself is a lightweight alternative to [OpenClaw](https://openclaw.ai/) (434K lines, 3,680 files). The goal was to build the smallest version of this architecture that I fully understand.

**Why build this?**
1. Learn the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) hands-on — not tutorials, a real project
2. Understand OpenClaw's architecture by building a simpler version of it
3. Build portfolio credibility as an AI Builder — code quality, clear documentation, and thoughtful decisions matter
4. Actually use it for personal automation

---

## System Overview

KuchiClaw is a single Node.js process that orchestrates AI agent sessions inside ephemeral Docker containers. Each user message triggers a fresh container with the Claude Agent SDK, isolated filesystem mounts, and injected conversation history. The agent runs, responds, and the container is destroyed.

```
Telegram ──→ Orchestrator ──→ Per-Group Queue ──→ Container Runner ──→ Docker
   ↑              │                                      │
   │              │                                      ↓
   │         ┌────┴────┐                          ┌─────────────┐
   │         │ SQLite  │                          │  Container  │
   │         │messages │                          │ Claude SDK  │
   │         │ tasks   │                          │ SOUL.md (ro)│
   │         └─────────┘                          │ TOOLS.md(ro)│
   │                                              │ MEMORY (rw) │
   │              IPC Poller ←── JSON files ←──── │ CONTEXT(rw) │
   │              │                               │ skills/ (ro)│
   └──────────────┘                               └─────────────┘
```

**Key properties:**
- **Container isolation** — each agent session runs in its own Docker container. The container can only see explicitly mounted directories. This is the security boundary.
- **Filesystem-based IPC** — containers communicate with the host by writing JSON files to a mounted directory. The host polls, validates, executes, and cleans up. No sockets, no HTTP servers inside containers.
- **Living files** — markdown files that persist across sessions, giving the agent identity, memory, and context.
- **Per-group isolation** — each Telegram chat gets its own memory, context, and IPC authorization scope.

---

## Design Decisions

### Living Files: Four-File Memory System

OpenClaw uses 6+ markdown files. NanoClaw simplifies to a single `CLAUDE.md` per group. KuchiClaw uses four files with clean separation across two dimensions:

| | Global (shared) | Per-group (isolated) |
|---|---|---|
| **Static reference** | SOUL.md (identity/rules), TOOLS.md (capabilities) | — |
| **Durable memory** | — | MEMORY.md (curated facts) |
| **Working memory** | — | CONTEXT.md (session scratchpad) |

- **SOUL.md** — personality, behavior rules, boundaries. Read-only mount. Same for every session, every group.
- **TOOLS.md** — documents available tools, usage patterns, and constraints. Read-only mount. Updated as skills are added.
- **MEMORY.md** — per-group long-lived curated facts (preferences, decisions, knowledge). Read-write mount. Only grows with durable information. The agent writes corrections to a `## Lessons` section immediately when corrected (Behavior Loop pattern).
- **CONTEXT.md** — per-group session working memory. Read-write mount. Scratchpad for session notes. Can be compacted or rotated without losing anything valuable.

A fifth file, **HEARTBEAT.md**, was added later as a global read-only checklist for scheduled self-maintenance tasks (email inbox checks, memory housekeeping).

### Container Strategy

Same as NanoClaw. The container IS the security boundary. Each agent invocation gets its own ephemeral container (`docker run -i --rm`) with only explicitly mounted paths visible. Secrets are passed via stdin — never written to disk or mounted as files. The container runs as a non-root `agent` user (Claude Code refuses `bypassPermissions` as root).

The container image is ~698MB due to the Claude Agent SDK bundle. No browser is needed — the SDK's built-in `WebSearch` and `WebFetch` tools work inside containers.

Since M12, the spawn is hardened (`--init --cap-drop=ALL --security-opt no-new-privileges --pids-limit`, opt-in `--memory`/`--cpus`) and lifecycle-managed: collision-proof names, host-set owner labels, daemon-side kill on timeout, fail-closed reaping of strays at startup and shutdown, and `--mount type=bind` so a missing mount source fails the spawn instead of being silently created. See Phase 12 below.

### IPC Mechanism

Filesystem-based JSON polling, same as NanoClaw. Each container mounts its **own** per-group namespace `data/ipc/<group>/` at `/workspace/ipc/` — a container can only write into its own directory. The host polls every second, and derives a request's identity from the mount path it arrives on (the directory name **is** the group), never from any field the container writes. It validates each request against authorization rules, executes it, and deletes the file (or quarantines it to `data/ipc-errors/`, outside any container mount, on failure).

**Identity is mount-derived, not payload-derived** — the security-critical property. The old shared-directory design trusted a container-written `group` field; the current design cannot be spoofed because a container has no write access to any other group's namespace. Reads are TOCTOU-safe (`O_NOFOLLOW`/`O_NONBLOCK`, regular-file + single-hardlink checks, bounded size), and canonical identity validators (`src/ipc-auth.ts`) gate every destination.

Two-tier authorization: the main group has unrestricted IPC access (can message any chat, manage any group's tasks). Non-main groups are scoped to their own chat and tasks only, enforced at every consumption point (IPC execute, task persistence, scheduler dequeue, crash recovery, queue ingress).

### Two-Tier Skills System

Skills extend what the agent can do. KuchiClaw supports two tiers that coexist:

1. **Simple skills** (CLI scripts + TOOLS.md docs) — scripts in `skills/` mounted read-only into the container. The agent reads TOOLS.md for usage docs and shells out. No protocol overhead. Example: `node skills/fastmail.mjs send "to" "subject" "body"`.

2. **MCP skills** (Model Context Protocol servers) — standard MCP servers passed to the SDK via `mcpServers` config. The SDK auto-discovers tools and handles invocation. Used when an MCP server already exists or when structured tool schemas add value.

Adding a new skill = drop a script in `skills/` + document in TOOLS.md, or add an entry to `mcp-servers.json`.

### Session Continuity

The problem: if a user says "Plan a trip to Japan", then "Check the cron job", then "What about hotels for the Japan trip?" — how does the agent connect message 3 back to message 1?

Three approaches were considered:
- **Option A: Always resume last session** — breaks on interleaved topics
- **Option B: Living files as the safety net** — MEMORY.md has durable facts. Even without session continuity, the agent knows about the trip
- **Option C: Recent message history** — last N messages from SQLite in the prompt. Claude naturally connects related topics

**KuchiClaw uses B+C combined.** No session ID resumption. Each invocation is a fresh container. Continuity comes from MEMORY.md (durable facts) + recent message history from SQLite (conversational context). Session resumption is a possible future optimization, not a requirement.

### Context Compaction

Phased approach:
- **Phase 1:** Fresh session each invocation. Agent writes durable facts to MEMORY.md, session notes to CONTEXT.md.
- **Phase 2:** Pre-session context flush — before a session ends, persist anything important to MEMORY.md. CONTEXT.md can then be safely rotated.
- **Phase 3 (if needed):** Full in-session compaction — summarize old messages when approaching context limits. Only worth building if sessions regularly hit the context window.

### Database

SQLite via `better-sqlite3`. Synchronous API is fine for a single-process orchestrator. Tables: `messages` (conversation history + processing status for crash recovery), `scheduled_tasks` (cron/interval/once), `task_run_logs` (execution history).

### Channel Abstraction

Telegram-first, but a minimal 5-method `Channel` interface (`connect`, `sendMessage`, `isConnected`, `ownsJid`, `disconnect`) makes adding other channels straightforward. Group/supergroup chats require @mention to trigger the bot. DMs always trigger. Unknown senders are filtered via an allowlist.

### Multi-Group Isolation

Each Telegram chat maps to its own group folder with isolated MEMORY.md and CONTEXT.md:

```
Global (shared):     SOUL.md, TOOLS.md, HEARTBEAT.md
                        │
        ┌───────────────┼───────────────┐
        │               │               │
  groups/tg-123456/  groups/tg--1001234/ groups/main/
   MEMORY.md          MEMORY.md          MEMORY.md
   CONTEXT.md         CONTEXT.md         CONTEXT.md
```

Group folder naming uses `{channel}-{chatId}` (e.g., `tg-123456789`), extensible for future channels (`wa-` for WhatsApp). One configured chat maps to `main` — the admin group with unrestricted IPC access.

### Authentication

Claude Max OAuth token with automatic refresh. Auth resolution priority (reordered in M12 P4.1 — see Auth lineage below):

1. **`CLAUDE_CODE_OAUTH_TOKEN` env var** — a dedicated `claude setup-token` grant with its own refresh lineage; the VPS primary path. The refresh token is never passed alongside it.
2. **`data/oauth.json`** — OAuth access token + refresh token stored locally. Both are passed to containers via `ContainerInput`. The container refreshes the token at the start of each run via `POST https://platform.claude.com/v1/oauth/token` (standard OAuth2 refresh_token grant) and returns fresh tokens in `ContainerOutput.newTokens`. The host persists these back to `data/oauth.json`. Refresh happens inside containers rather than on the host because the VPS host is blocked by Cloudflare from `platform.claude.com`; containers have unrestricted network access. If a parallel container already consumed the refresh token, the container falls back to the original access token.
3. **`ANTHROPIC_API_KEY` env var** — fallback if no `oauth.json` exists. Pay-per-use API billing. Automatically switches to Sonnet 5 (instead of Opus) to reduce costs. Optional.
4. **macOS keychain** — local dev only. Claude Code stores credentials in `Claude Code-credentials` keychain entry.

Tokens are passed to containers via stdin — never mounted as files. Skill-specific secrets (e.g., `FASTMAIL_API_TOKEN`) flow through the same stdin mechanism, scoped per group: only containers of groups listed in `FASTMAIL_GROUPS` receive the token (unset = no group does). Inside the container, the refresh token is used and scrubbed before the agent starts — the agent-visible env holds only allowlisted, short-lived or entitled keys.

---

## Implementation Phases

The system was built incrementally. Each phase produced an end-to-end testable system. The sequencing was deliberate: SQLite was built before Telegram (you can't meaningfully integrate a messaging channel without persisting messages), and the queue was split from Telegram (get a working bot first, add concurrency control later).

### Phase 0: Scaffolding

TypeScript project with Docker setup. `npm run build` succeeds, `docker build` produces a working image.

### Phase 1: Basic Agent Loop (CLI)

Proved container isolation + IPC works end-to-end. Built the container runner (`docker run -i --rm` with proper mounts), stdin/stdout communication with sentinel markers, and the in-container agent runner (reads prompt from stdin, invokes Claude Agent SDK, emits response between markers).

`npx tsx src/cli.ts "What is 2+2?"` → spawns container → returns Claude's answer.

**Key files:** `src/cli.ts`, `src/container-runner.ts`, `container/entrypoint.ts`

### Phase 2: Persistent Context + Web Tools

Added the four-file living system. SOUL.md and TOOLS.md mounted read-only, MEMORY.md and CONTEXT.md read-write. System prompt built inside the container by reading mounted files + injected message history. CLI gained a `--group` flag.

Evaluated SDK built-in `WebSearch` and `WebFetch` inside containers — they work without any external APIs, so Tavily and Firecrawl were unnecessary. No extra dependencies, no API keys.

**Key files:** `src/group-folder.ts`, `SOUL.md`, `TOOLS.md`

### Phase 3: SQLite + Message History

Added `better-sqlite3` with WAL mode. Single `messages` table. Last 20 messages loaded from SQLite and injected into the system prompt, giving Claude conversational context across invocations. CLI gained a `--history` flag.

**Key files:** `src/db.ts`

### Phase 4: Telegram Integration

Telegram became the primary input/output channel via `node-telegram-bot-api` (long polling). Implemented the 5-method `Channel` interface. Added `/start` and `/status` bot commands, message chunking for responses exceeding Telegram's 4096-char limit, and typing indicators.

Auth logic was extracted into shared `src/auth.ts` (used by both CLI and orchestrator entrypoints).

**Key files:** `src/channels/telegram.ts`, `src/channels/registry.ts`, `src/auth.ts`

### Phase 5: Orchestrator + Queue

Added per-group FIFO queue with concurrency control (`MAX_CONTAINERS_PER_GROUP = 2`). Retry with exponential backoff (`2000ms * 2^(attempt-1)`, max 3 retries). Auth failures fail immediately. Graceful shutdown on SIGINT/SIGTERM waits for running containers with a 60s hard timeout.

`src/index.ts` replaced `src/bot.ts` as the primary entrypoint. CLI kept for one-off testing.

**Key files:** `src/index.ts`, `src/group-queue.ts`

### Phase 6: IPC + Skills System

Containers gained the ability to trigger host-side actions via IPC. The host polls `data/ipc/` for JSON request files, validates authorization, and executes (currently: send messages to any Telegram chat).

Built the two-tier skills system. First real skill: FastMail JMAP integration (`skills/fastmail.mjs`) — send, read, reply to email via CLI wrapper around the JMAP API. MCP server plumbing wired through `mcp-servers.json` → ContainerInput → SDK `query()`.

Added `dotenv` for `.env` loading in entrypoints.

**Key files:** `src/ipc.ts`, `skills/`, `mcp-servers.json`

### Phase 7: Scheduled Tasks + Heartbeat

Added a task scheduler (60s poll loop) supporting cron, interval, and one-shot tasks. Tasks are rows in `scheduled_tasks` — no hardcoded tasks, everything is dynamic. The scheduler enqueues due tasks into the same GroupQueue used for Telegram messages, maintaining execution isolation.

Interval drift prevention: advance `next_run` from previous scheduled time, not `Date.now()`. In-flight tracking via `Set<number>` prevents double-enqueue if a task takes longer than the poll interval.

Created `HEARTBEAT.md` — a global read-only living file with self-maintenance checklists (email inbox every ~4h, memory housekeeping daily). The heartbeat is a regular scheduled task, not a special system — it's created via IPC or manual DB insert.

Added vitest with 16 tests covering DB CRUD, task scheduling logic, and drift prevention.

**Key files:** `src/task-scheduler.ts`, `HEARTBEAT.md`

### Phase 8: Multi-Group Isolation

Each Telegram chat gets its own group folder with isolated MEMORY.md and CONTEXT.md. Group mapping via `chatIdToGroup()` with channel prefix (`tg-{chatId}`). @mention detection: bot calls `getMe()` on connect, group chats require `@botUsername` mention, DMs always trigger.

IPC authorization enforced per-group: non-main groups scoped to their own chat and tasks. Main group unrestricted.

Global sender allowlist via `ALLOWED_SENDER_IDS` env var — fail-closed: the orchestrator refuses to start when it's unset, messages without a resolvable sender ID are dropped, and allow-all must be spelled out as `ALLOWED_SENDER_IDS=*`.

**Key files:** `src/group-mapping.ts`, `src/channels/telegram.ts`, `src/index.ts`, `src/ipc.ts`

### Phase 9: Deploy to Hetzner

Deployed to a Hetzner CPX22 VPS running 24/7. Added OAuth token auto-refresh so the bot can use Claude Max without manual token management. Refresh happens inside containers (`container/entrypoint.ts`) rather than on the VPS host — the host is Cloudflare-blocked from `platform.claude.com`, but containers have unrestricted network access. Containers return fresh tokens in their output; the host persists them to `data/oauth.json` for the next run. Fallback to `ANTHROPIC_API_KEY` if no `oauth.json` exists.

Created a systemd service (`kuchiclaw.service`) running as a dedicated `kuchiclaw` user with security hardening (`ProtectSystem=strict`, `NoNewPrivileges`). Provisioning automated via `deploy/setup.sh`.

**Key files:** `src/oauth-refresh.ts`, `kuchiclaw.service`, `deploy/setup.sh`, `deploy/export-oauth.sh`

### Phase 10: Crash Recovery

On restart, the orchestrator detects and re-processes messages that were lost mid-flight. The `messages` table gained three columns: `processing_status` (`pending` → `processing` → `done` / `failed`), `chat_id`, and `sender_name`. Migration is idempotent — `ALTER TABLE ADD COLUMN` wrapped in try/catch, existing rows default to `done`.

Status transitions: user message stored as `pending` on receive, set to `processing` when the job is dequeued from the queue, `done` on successful container completion, `failed` on final retry exhaustion or agent error. On startup, `getOrphanedMessages()` finds user messages stuck in `pending`/`processing` that are older than 10 seconds (not a race with current startup) but younger than 1 hour (user has moved on). Orphans are re-enqueued into the GroupQueue.

The `chat_id` and `sender_name` columns were added (rather than parsing them back out of message content) to support future multi-channel recovery — without them, we couldn't determine which channel to re-send to.

**Key files:** `src/db.ts`, `src/group-queue.ts`, `src/index.ts`

### Phase 11: Living File Backup via Git

The agent's memory files (`groups/*/MEMORY.md`, `groups/*/CONTEXT.md`) evolve over time on the VPS. These need to be backed up independently of the code repo to prevent `git pull` deployments from overwriting them.

**Repo separation:** `groups/` is gitignored in the main `kuchiclaw` repo. Example living files live in `groups/example/` for reference. Real group directories are created at runtime by `ensureGroupFolder()` and backed up to a separate private `kuchiclaw-memory` GitHub repo.

**Trigger:** A systemd timer (`kuchiclaw-backup.timer`) runs daily at 03:00 UTC, invoking `skills/backup.sh` directly on the host — no container or agent involved. This means backups happen even if the orchestrator is down.

**What's backed up:**
- All `groups/*/MEMORY.md` and `groups/*/CONTEXT.md` files
- SQLite database snapshot (via `sqlite3 .backup`, safe with WAL mode)

**Git auth:** A private GitHub App with `contents: write` permission, installed only on the `kuchiclaw-memory` repo. The backup script generates a short-lived installation token (1hr) from the app's private key via JWT → GitHub API. No long-lived tokens to rotate.

**Change detection:** `git diff --cached --quiet` after staging — only commits and pushes if there are actual changes. No empty commits, no misleading error output in logs.

**Migration note (one-time):** The commit that gitignores `groups/` also removes `groups/main/MEMORY.md` and `groups/main/CONTEXT.md` from tracking. When you `git pull` this on the VPS, git will delete those files from disk. Back them up before pulling:

```bash
cp groups/main/MEMORY.md /tmp/memory-backup.md
cp groups/main/CONTEXT.md /tmp/context-backup.md
git pull
cp /tmp/memory-backup.md groups/main/MEMORY.md
cp /tmp/context-backup.md groups/main/CONTEXT.md
```

After this one-time migration, future `git pull` commands won't touch `groups/` at all.

**Key files:** `skills/backup.sh`, `deploy/kuchiclaw-backup.service`, `deploy/kuchiclaw-backup.timer`

### Phase 12: Hardening (M12, in progress)

Post-MVP hardening driven by a cross-model security audit and a study of how NanoClaw's runtime evolved after KuchiClaw forked its patterns. High-risk slices run a full two-model ladder (adversarially reviewed plan → cross-model implementation → three review channels). Shipped so far:

**IPC security boundary.** The shared IPC directory became per-group namespaces: each container mounts only `data/ipc/<group>/`, and the host derives request identity from the *directory a request arrives in* — the payload's `group` field lost all authority. Canonical identity validators (`src/ipc-auth.ts`) run at every consumption point, request files are read via TOCTOU-safe bounded fd reads with symlink rejection, and the error quarantine moved outside any container-mounted tree. A two-factor cutover attestation (filesystem marker + SQLite `user_version`, both outside the legacy trust domain) makes the new binary refuse to boot against a legacy tree.

**Orchestrator resilience.** A file-based startup circuit breaker is the primary crash-loop control (systemd's `StartLimit` is a deliberately loose failsafe); per-job auth failures throw instead of exiting the process; reply delivery is decoupled from the agent run (a Telegram outage can never re-run the agent); a runtime sweep re-enqueues stranded messages with a persisted replay cap.

**Auth lineage.** An explicit `CLAUDE_CODE_OAUTH_TOKEN` (a dedicated `claude setup-token` grant with its own refresh lineage) now outranks `oauth.json`, and the refresh token is never passed alongside an env-token grant — two devices sharing one refresh lineage was the documented root cause of auth crash-loops in this class of deployment.

**Container lifecycle.** A timed-out container is killed by name via the docker daemon (the old client-side SIGKILL provably never reached it) under a `running → terminating → settled` state machine: a stdout-drain latch prevents truncating a late flush, completed-output-at-timeout counts as success (no duplicate re-run), and unconfirmed death is a *containment failure* — the orchestrator settles the job, synchronously closes the queue, and restarts so the startup reap can prove no stray container holds rw mounts. Spawns are labeled and hardened (`--init --cap-drop=ALL --security-opt no-new-privileges --pids-limit`, opt-in memory/cpu caps), mounts use `--mount type=bind` so the daemon atomically rejects missing sources, startup fail-closed-reaps labeled and legacy strays, and a kernel-owned loopback listen socket serves as a single-instance operator backstop.

**Secret scoping.** The agent inside a container is treated as untrusted (prompt injection via messages, web content, or email is assumed), so long-lived credentials are kept out of its reach. The container entrypoint applies an *exact allowlist* of agent-visible env keys and refuses any secret whose value equals the OAuth refresh token — the refresh token is refreshed (with response validation) and scrubbed from the input before the SDK starts, so it is never agent-readable under any key or as any value; refusals surface as structured output warnings the host logs (bounded and sanitized). Skill secrets are explicit-entitlement only: `FASTMAIL_GROUPS` names the groups whose containers receive the Fastmail token (unset means none — fail-closed), validated by the same group-name validators as IPC. The entrypoint's full flow is exported as an injectable function (`runEntrypoint`) so host tests drive the real code path and assert the credential boundary at the exact moment the SDK is invoked. One documented dependency: heap-level isolation of the in-process refresh token relies on the host's `kernel.yama.ptrace_scope=1` (Ubuntu default) combined with `--cap-drop=ALL` — deployments on hosts with `ptrace_scope=0` lose that barrier.

**Runtime & supply chain.** Node 24 across host and container, with the base image digest-pinned and the container's dependency tree locked (`container/package-lock.json` + `npm ci`) so the agent runtime can't drift under a floating tag or transitive resolution. Model selection is explicit: `AGENT_MODEL` (default `opus`) with `AGENT_FALLBACK_MODEL` (default `sonnet`) threaded through to the SDK — the fallback is load-bearing because the Claude Max Opus-only weekly cap is shared with the operator's own coding sessions, and without it hitting the cap silently drops replies. The sender allowlist fails closed (startup refuses an unset `ALLOWED_SENDER_IDS`; allow-all requires a literal `*`), backup provisioning is part of `setup.sh` (timer enabled, `sqlite3` CLI installed, `OnFailure` alert on the backup unit), and `deploy/update.sh` makes pull→rebuild→reinstall a single step so host code and agent image can't skew.

**Key files:** `src/ipc-auth.ts`, `src/circuit-breaker.ts`, `src/container-runner.ts`, `src/docker.ts`, `src/docker-reap.ts`, `src/instance-lock.ts`, `deploy/cutover-m12-p1.sh`, `deploy/update.sh`, `container/prepare.ts`

### Phase Sequencing Rationale

1. **Phase 0 (Scaffolding)** — Docker image needed before anything else works
2. **Phase 3 (SQLite) before Phase 4 (Telegram)** — you can't meaningfully integrate a messaging channel without persisting messages
3. **Phases 5-6 (Queue + IPC) split from Telegram** — get a working bot first, add concurrency and IPC after. This gave us a working bot earlier
4. **Multi-Group kept last** — refinement of isolation, not a core capability. Everything works with a single group first
5. **Phases 9-11 (Deploy + Recovery + Backup)** — production-readiness triad. Deploy first, then harden with crash recovery and versioned backups

---

## Security Model

- **Containers are the security boundary** — agents see only mounted directories
- **Read-only mounts by default** — MEMORY.md and CONTEXT.md are the exceptions
- **Secrets via stdin, never files** — auth tokens and API keys passed through ContainerInput; the container sets only an exact allowlist of keys into the agent's env, the OAuth refresh token is never agent-visible, and skill secrets reach only groups entitled via `FASTMAIL_GROUPS`
- **IPC authorization** — every request validated before execution. Non-main groups scoped to own data
- **Non-root container user** — Claude Code refuses `bypassPermissions` as root
- **No personal account credentials** — dedicated service accounts only
- **OAuth tokens protected** — `data/oauth.json` is chmod 600, gitignored, never mounted into containers
- **Sender allowlist** — unknown Telegram users silently ignored
- **Production hardening** — dedicated `kuchiclaw` system user (uid 999), systemd `ProtectSystem=strict`, `NoNewPrivileges=yes`, `PrivateTmp=yes`
- **UID alignment** — container `agent` user has uid 999, matching the host `kuchiclaw` user, so mounted volumes (MEMORY.md, CONTEXT.md) are writable inside containers

---

## File Structure

```
kuchiclaw/
├── ARCHITECTURE.md                 # This document
├── CLAUDE.md                       # Project conventions for AI assistants
├── SOUL.md                         # Agent personality/rules (global, ro)
├── TOOLS.md                        # Agent tool documentation (global, ro)
├── HEARTBEAT.md                    # Self-maintenance checklist (global, ro)
├── mcp-servers.json                # MCP server configs for skills tier 2
├── Dockerfile                      # Agent container image
├── docker-compose.yml
├── src/
│   ├── index.ts                    # Main orchestrator entrypoint
│   ├── cli.ts                      # CLI entrypoint (testing)
│   ├── auth.ts                     # Auth helpers (OAuth refresh → API key → keychain)
│   ├── oauth-refresh.ts            # OAuth token auto-refresh (reads/writes data/oauth.json)
│   ├── container-runner.ts         # Docker container lifecycle
│   ├── db.ts                       # SQLite schema + queries
│   ├── group-folder.ts             # Per-group directory management
│   ├── group-mapping.ts            # Chat ID → group folder mapping
│   ├── group-queue.ts              # Per-group FIFO queue with concurrency
│   ├── ipc.ts                      # Filesystem IPC polling + authorization
│   ├── task-scheduler.ts           # Cron/interval/once scheduler
│   ├── config.ts                   # Configuration constants
│   ├── types.ts                    # Shared type definitions
│   └── channels/
│       ├── telegram.ts             # Telegram adapter (long polling, @mention, allowlist)
│       └── registry.ts             # Channel interface definition
├── container/
│   ├── entrypoint.ts               # Runs inside Docker (reads stdin, builds prompt, calls SDK)
│   └── package.json                # Container-specific deps (claude-agent-sdk only)
├── skills/                         # Simple skills — CLI scripts/API wrappers (ro mount)
│   ├── fastmail.mjs                # Email via JMAP (send, inbox, read, reply)
│   └── backup.sh                   # Living file + SQLite backup to private git repo
├── groups/                         # Per-group living files (gitignored, created at runtime)
│   ├── example/                    # Example files for reference (tracked)
│   │   ├── MEMORY.md
│   │   └── CONTEXT.md
│   └── main/                       # Created by ensureGroupFolder() (gitignored)
│       ├── MEMORY.md               # Long-lived curated facts (per-group, rw)
│       ├── CONTEXT.md              # Session working memory (per-group, rw)
│       └── logs/
├── deploy/
│   ├── setup.sh                    # VPS provisioning script
│   ├── export-oauth.sh             # Export OAuth tokens from macOS keychain
│   ├── kuchiclaw-backup.service    # systemd unit for daily backup
│   └── kuchiclaw-backup.timer      # systemd timer (daily 03:00 UTC)
├── kuchiclaw.service               # systemd unit file
└── data/
    ├── kuchiclaw.db                # SQLite database
    ├── oauth.json                  # OAuth tokens (chmod 600, gitignored)
    └── ipc/                        # IPC request directory
```

---

## Dependencies

Minimal by design. Host and container dependencies are kept separate.

**Host process:**

| Package | Purpose |
|---------|---------|
| `better-sqlite3` | SQLite database |
| `node-telegram-bot-api` | Telegram integration |
| `cron-parser` | Cron expression parsing for scheduler |
| `dotenv` | `.env` file loading |

**Inside container:**

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/claude-agent-sdk` | Agent runtime (bundles CLI + web tools) |

**Dev:**

| Package | Purpose |
|---------|---------|
| `vitest` | Test runner |

TypeScript, tsx, and Docker are dev/build tools.

---

## Deployment

### Platform: Hetzner Cloud VPS

KuchiClaw's architecture (host process spawning ephemeral Docker containers) eliminates most PaaS options. Six platforms were evaluated — Railway and Fly.io can't do nested containers, AWS Lightsail's burstable CPU throttles on container spawns, Contabo oversells CPU, Hostinger has renewal traps.

**Hetzner CPX22** ($6.99/mo + $1.40 backups + $0.50 IPv4 = $8.89/mo) — 2 shared vCPU (AMD), 4 GB RAM, 80 GB NVMe SSD, 20 TB bandwidth, Nuremberg datacenter, Ubuntu 24.04. Upgrade path to CPX32 (4 vCPU, 8 GB RAM) if RAM is tight.

```
Hetzner CPX22 (Nuremberg)
├── systemd service: kuchiclaw (Restart=always)
│   ├── runs as dedicated 'kuchiclaw' user
│   ├── polls Telegram (long-polling, no inbound ports)
│   ├── spawns Docker containers per agent invocation
│   ├── polls data/ipc/ for container requests
│   └── containers refresh OAuth token and return new tokens to host
├── /opt/kuchiclaw/
│   ├── .env (chmod 600) — TELEGRAM_BOT_TOKEN, FASTMAIL_API_TOKEN, etc.
│   ├── data/oauth.json (chmod 600) — OAuth access + refresh tokens
│   ├── data/kuchiclaw.db (SQLite, WAL mode)
│   ├── data/ipc/
│   └── groups/*/MEMORY.md, CONTEXT.md
└── Docker daemon (containers spawned on demand)
```

**Secrets management:**
- Dev (macOS): auto-read from keychain, zero config
- Production: `.env` file (chmod 600) with systemd `EnvironmentFile`, `data/oauth.json` (chmod 600) for OAuth tokens
- Secrets are never mounted into containers — always passed via stdin

**Provisioning:** `deploy/setup.sh` installs Docker + Node.js 24 + the `sqlite3` CLI (backup.sh needs it), creates the `kuchiclaw` user (in `docker` group), clones the repo, builds the Docker image, and installs all systemd units — service, alert watchdog, and the daily backup timer (enabled immediately). OAuth tokens are exported from the dev machine's keychain via `deploy/export-oauth.sh` and transferred via SCP.

**Update procedure:** one script, so a `git pull` can never be deployed without the
matching image rebuild and unit reinstall (that drift is how a host/container skew
sneaks into production):
```bash
ssh root@your-server 'bash /opt/kuchiclaw/deploy/update.sh'
journalctl -u kuchiclaw -f                           # verify
```

**Monitoring:**
```bash
journalctl -u kuchiclaw -f              # live logs
systemctl status kuchiclaw              # service status
ssh root@your-server 'docker ps'      # running containers
```

**Backup strategy:**
- Hetzner auto-backups ($1.40/mo, keeps 7 daily copies)
- Living file + SQLite backup via Git: `skills/backup.sh` runs daily via systemd timer, commits changes to a private `kuchiclaw-memory` repo. Git auth via private GitHub App (short-lived tokens, `contents: write` on one repo). See Phase 11 for details.

---

## Future Enhancements

Deferred ideas worth revisiting once the core system is stable:

- **Session ID resumption** — resume previous Claude sessions to reduce token usage and give richer context. Requires heuristics for when to resume vs start fresh.
- **Tiered retrieval** — when MEMORY.md grows large, read section headers first (tier 1), then pull relevant sections (tier 2). Reduces token waste.
- **Full in-session compaction** — summarize old messages when approaching context limits. Only needed if sessions regularly hit the context window.
- **Score decay / staleness** — date-stamp facts in MEMORY.md, periodically review and prune stale entries via scheduled task.
- **Daily logs** — `memory/YYYY-MM-DD.md` append-only logs alongside MEMORY.md. Auto-rotate, load today + yesterday only.
- **Deduplication** — detect and merge near-duplicate facts in MEMORY.md (cosine similarity or LLM-based).
- **Tavily / Firecrawl** — API-based web tools if SDK built-in WebSearch/WebFetch prove insufficient for JS-heavy or cluttered pages.
- **Apple Container support** — native macOS containers for lower overhead on dev machines.
- **WhatsApp channel** — second messaging adapter using the Channel interface.
- **Email channel adapter** — email as an input channel (poll FastMail inbox via JMAP → route to agent → reply). Different from the FastMail skill (which lets the agent proactively send email).
- **Global container cap** — `MAX_CONCURRENT_CONTAINERS` across all groups, in addition to the per-group cap.

---

## Prior Art

KuchiClaw's architecture draws from two existing projects. Understanding them helps explain the design choices above.

### NanoClaw (Primary Reference)

[NanoClaw](https://github.com/qwibitai/nanoclaw) is a ~3,900-line Node.js/TypeScript framework that distills OpenClaw's concepts into 15 source files. Key components:

- **Orchestrator** — single-process polling loop that routes messages to per-group queues, manages sessions with cursor-based tracking and rollback on failure
- **Container Runner** — `docker run -i --rm` with isolated mounts, secrets via stdin, output via sentinel markers, configurable timeouts and idle detection
- **Filesystem IPC** — containers write JSON to mounted directories, host polls/validates/executes with two-tier authorization
- **Group Queue** — per-group FIFO with concurrency limits (`MAX_CONCURRENT_CONTAINERS = 5`), exponential backoff retry, task prioritization
- **SQLite** — tables for chats, messages, scheduled tasks, task run logs, registered groups, sessions
- **Task Scheduler** — 60s poll loop supporting cron, interval, and one-shot tasks with drift prevention

### OpenClaw (High-Level Reference)

[OpenClaw](https://openclaw.ai/) is a 196K-star, 434K-line personal AI assistant framework. Key patterns adopted:

- **Living files** — SOUL.md, MEMORY.md, HEARTBEAT.md, TOOLS.md as persistent context loaded into agent sessions
- **Gateway pattern** — single daemon owns all messaging surfaces
- **Context compaction** — auto-summarize old messages near context limit, with memory flush before compaction
- **Channel adapters** — normalize messages from different platforms to a common format

### Claude Agent SDK

TypeScript package `@anthropic-ai/claude-agent-sdk`. KuchiClaw uses `query()` for one-off stateless sessions (async iterator). Key options: `allowedTools`, `permissionMode: "bypassPermissions"`, `systemPrompt`, `mcpServers`. Built-in tools include Read, Edit, Write, Glob, Grep, Bash, WebSearch, and WebFetch.
