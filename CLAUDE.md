# KuchiClaw

Minimal AI agent framework inspired by NanoClaw/OpenClaw. Node.js + TypeScript + Docker + Claude Agent SDK.

## Project Philosophy

- Understand every line of code — if it can be removed without breaking core functionality, remove it
- No premature abstraction — start concrete, refactor only when patterns emerge
- This is a portfolio project: clean code, meaningful comments (why not what), clear documentation

## Architecture

- Single Node.js process orchestrator (no microservices)
- Docker containers for agent isolation (each session = ephemeral container)
- Filesystem-based IPC (containers write JSON → host polls/validates/executes)
- SQLite for persistent state (messages, sessions, groups, tasks)
- Five living files: SOUL.md (identity, global, ro), TOOLS.md (capabilities, global, ro), MEMORY.md (durable facts, per-group, rw), CONTEXT.md (session scratchpad, per-group, rw), HEARTBEAT.md (self-maintenance checklist, global, ro)
- Authentication priority: explicit `CLAUDE_CODE_OAUTH_TOKEN` env var (a dedicated `claude setup-token` grant — the VPS primary path, own refresh lineage) → Claude Max OAuth auto-refresh (`data/oauth.json`) → `ANTHROPIC_API_KEY` env var (auto-downgrades to Sonnet 4.6 to reduce costs) → macOS keychain (local dev). On the oauth.json path only, access + refresh tokens are passed to containers via stdin; containers refresh the token themselves (VPS host is Cloudflare-blocked from `platform.claude.com`, containers are not) and return new tokens in output for the host to persist. The refresh token is never passed alongside an env-token grant — mixing lineages causes auth crash-loops
- Container runs as non-root `agent` user (Claude Code refuses bypassPermissions as root)
- Telegram as primary messaging channel

## Current State

M0 (scaffolding), M1 (basic agent loop), M2 (persistent context + web tools), M3 (SQLite + message history), M4 (Telegram integration), M5 (orchestrator + queue), M6 (IPC + skills system), M7 (scheduled tasks + heartbeat), M8 (multi-group isolation), M9 (deploy to Hetzner), M10 (crash recovery), and M11 (living file backup via git) are complete. **M9 + M10 + M11 = MVP.**

Working flow (CLI): `npx tsx src/cli.ts "prompt"` or `npx tsx src/cli.ts --group mygroup "prompt"` → stores prompt in SQLite → loads recent message history → spawns ephemeral Docker container with living files mounted + message history injected → Claude Agent SDK runs inside with system prompt from SOUL.md + TOOLS.md + MEMORY.md + CONTEXT.md + recent messages → response returned via sentinel markers → response stored in SQLite. Use `--history` to view conversation log.

Working flow (Telegram): `npx tsx src/index.ts` (secrets loaded from `.env`) → orchestrator connects Telegram channel, starts IPC polling, starts task scheduler (60s poll) → each Telegram chat maps to its own isolated group via `chatIdToGroup("tg", chatId)` — one chat designated as `MAIN_CHAT_ID` maps to `main`, all others get `tg-{chatId}` → incoming messages stored in SQLite and enqueued in per-group FIFO queue → queue drains up to `MAX_CONTAINERS_PER_GROUP` (default 2) concurrent containers per group → container runs agent with skills/, ipc/, and HEARTBEAT.md mounted, plus `## Session Context` in system prompt (group name + chat ID) → agent can write IPC requests to send messages or manage scheduled tasks → response stored in SQLite and sent back to Telegram. Scheduled tasks (cron/interval/one-shot) enqueue into the same GroupQueue. MCP servers loaded from `mcp-servers.json` and passed to SDK. Failed containers retry with exponential backoff (max 3 attempts). Graceful shutdown on SIGINT/SIGTERM waits for running containers. On startup, orphaned messages (pending/processing, 10s–1hr old) are detected and re-enqueued for crash recovery. Group chats require @mention to trigger the bot. Global sender allowlist via `ALLOWED_SENDER_IDS`. Non-main groups scoped to their own chat/tasks via IPC authorization; main group has full access.

## Key Files

**Implemented (M0-M8):**
- `src/index.ts` — Main orchestrator entrypoint: connects Telegram channel, starts IPC polling + task scheduler, loads MCP config, routes messages through per-group queue via chatIdToGroup, graceful shutdown on SIGINT/SIGTERM
- `src/group-queue.ts` — Per-group FIFO queue with per-group concurrency cap, exponential backoff retry, auth-failure detection, onComplete/onError callbacks for task logging. Calls `getSecrets()` per job (not at startup) so OAuth tokens stay fresh — access tokens expire after 8h and the process is long-lived
- `src/group-mapping.ts` — Maps channel chat IDs to group folder names (`chatIdToGroup`, `groupToChatId`). MAIN_CHAT_ID is channel-qualified (e.g., `tg-<your-chat-id>`)
- `src/ipc.ts` / `src/ipc-poll.ts` — Filesystem-based IPC. Each container mounts its own per-group namespace `data/ipc/<group>/`; the host derives request identity from the mount path (the directory a request arrives in), never from the container-written payload. `ipc-poll.ts` polls each group subdir with bounded enumeration + TOCTOU-safe fd reads; `ipc.ts` holds `execute`/handlers/authorization (message, task_create/pause/resume/cancel/list). Destination authorization runs at every consumption point via canonical identity validators (`src/ipc-auth.ts`): tg-only group names, canonical-decimal chat ids. Two-tier authorization (main=unrestricted, others=scoped to own chat/tasks). Failures quarantined to `data/ipc-errors/` (outside any container mount)
- `src/task-scheduler.ts` — Polls every 60s for due tasks, supports cron (via cron-parser), interval (with drift prevention), and one-shot schedules, enqueues into GroupQueue, in-flight tracking via Set
- `src/cli.ts` — CLI entrypoint: reads prompt from args/stdin, gets auth token, supports `--group` and `--history` flags, stores messages in SQLite, injects recent history into container
- `src/auth.ts` — Authentication helpers: resolves auth via OAuth auto-refresh → API key (with Sonnet downgrade) → keychain, returns `AuthResult` with secrets + `isApiKeyFallback` flag, collects skill secrets (FASTMAIL_API_TOKEN) from env (shared by cli.ts and index.ts)
- `src/oauth-refresh.ts` — OAuth token auto-refresh for Claude Max: reads/writes `data/oauth.json`, refreshes access token on demand when within 5 min of expiry, returns null on failure (caller falls back). Also exports `getRefreshToken()` and `updateOAuthData()` for the container-side refresh flow
- `src/channels/registry.ts` — Channel interface definition (connect, sendMessage, isConnected, ownsJid, disconnect) + IncomingMessage type (with chatType, senderId)
- `src/channels/telegram.ts` — Telegram adapter: long polling via node-telegram-bot-api, /start and /status commands, message chunking, MarkdownV2 rendering (with plain text fallback), typing indicator, @mention filtering for group chats, sender allowlist
- `src/container-runner.ts` — Spawns `docker run -i --rm` with living file + IPC + skills mounts, passes ContainerInput via stdin, parses sentinel markers from stdout. Persists `newTokens` from container output to `oauth.json` if the container refreshed them
- `src/db.ts` — SQLite database: `messages` (with `processing_status`/`chat_id`/`sender_name` for crash recovery), `scheduled_tasks`, `task_run_logs` tables, insert/query functions, history formatting, orphaned message detection, `resetDb()` for test injection
- `src/group-folder.ts` — Manages per-group directory structure (MEMORY.md, CONTEXT.md, logs/) and ensures IPC directory exists
- `src/config.ts` — Constants: image name, sentinel markers, timeout, paths, queue config, IPC config, skills/MCP paths, scheduler poll interval, MAIN_CHAT_ID, ALLOWED_SENDER_IDS
- `src/types.ts` — ContainerInput/ContainerOutput/IpcRequest (with task ops)/McpServerConfig/ScheduledTask/TaskRunLog type definitions
- `container/entrypoint.ts` — Runs inside Docker: reads stdin, sets all secrets as env vars, builds system prompt from living files (incl. HEARTBEAT.md) + Session Context (group + chatId) + message history, passes mcpServers to SDK `query()`, emits result between markers
- `container/package.json` — Container deps (claude-agent-sdk only)
- `Dockerfile` — Node 20 slim + git + claude-agent-sdk + tsx, runs as non-root `agent` user (uid 999, matching host `kuchiclaw` user for volume permissions)
- `SOUL.md` — Agent personality and behavior rules (global, read-only)
- `TOOLS.md` — Available tools documentation including IPC, skills, and scheduled tasks (global, read-only)
- `HEARTBEAT.md` — Self-maintenance checklist for heartbeat tasks (global, read-only)
- `mcp-servers.json` — MCP server configurations (empty by default, add servers as needed)
- `skills/` — Simple skills directory (CLI scripts/API wrappers, mounted read-only into containers). Includes `fastmail.mjs` (email via JMAP as koochi@fastmail.com), `backup.sh` (living file + SQLite backup to private git repo)
- `groups/example/` — Example living files for reference (tracked in git). Real groups are gitignored — created at runtime by `ensureGroupFolder()`
- `data/kuchiclaw.db` — SQLite database (auto-created on first run)
- `data/ipc/<group>/` — per-group IPC request directories (each container writes only to its own; host polls all). `data/ipc-errors/` (outside the mounted tree) quarantines failed/malformed requests. `data/ipc-layout-v2` — cutover attestation marker (see `deploy/cutover-m12-p1.sh`)
- `data/oauth.json` — OAuth tokens for auto-refresh (accessToken, refreshToken, expiresAt; chmod 600, gitignored)

**Deployment (M9) + Backup (M11):**
- `kuchiclaw.service` — systemd unit file: runs as `kuchiclaw` user, `Restart=always` with `StartLimitBurst=5`/`StartLimitIntervalSec=300` so repeated crashes trip the unit into `failed` state and fire `OnFailure=kuchiclaw-alert@%n.service`. `EnvironmentFile=/opt/kuchiclaw/.env`, security hardening (NoNewPrivileges, ProtectSystem=strict, PrivateTmp=yes)
- `deploy/kuchiclaw-alert@.service` — Templated oneshot unit invoked by `OnFailure`. Runs `deploy/alert.sh` with the failed unit name as `%i`
- `deploy/alert.sh` — Telegram alert when systemd gives up restarting kuchiclaw. Curls Telegram's `sendMessage` API directly using `TELEGRAM_BOT_TOKEN` + `MAIN_CHAT_ID` from `.env`, includes last 20 journal lines. Has zero dependency on the kuchiclaw process — that's the whole point
- `deploy/setup.sh` — VPS provisioning script: installs Docker + Node.js 20, creates `kuchiclaw` user, clones repo, builds Docker image, installs both systemd units
- `deploy/export-oauth.sh` — Exports OAuth tokens from macOS keychain to `data/oauth.json` for transfer to VPS
- `deploy/kuchiclaw-backup.service` — systemd unit for daily living file + SQLite backup
- `deploy/kuchiclaw-backup.timer` — systemd timer triggering backup daily at 03:00 UTC

**Reference:**
- `project-plan.md` — Detailed milestones and architectural decisions

## Conventions

- TypeScript strict mode, ES modules
- Keep files under ~200 lines; split when they grow
- Minimal dependencies — host: better-sqlite3, node-telegram-bot-api, dotenv, cron-parser. Container: claude-agent-sdk (web tools are SDK built-in)
- Comments explain WHY, not WHAT
- No dashboards or web UIs — Telegram is the interface
- Tests via vitest (`npm test`). Test files colocated as `*.test.ts`. Use in-memory SQLite via `resetDb(new Database(":memory:"))` for DB tests.

## Workflow & Task Tracking

This project uses the **tinytandem** two-model workflow (Claude orchestrator + Codex adversary). See `docs/handoff-pattern.md` for the full pattern.

- **Session loop:** `/start` (read state, propose priorities — read-only) at session start; `/wrapup` (persist state + decisions) at session end; `/review` (fresh-context QA reviewer that defaults to rejection) after a milestone. Enter plan mode for any non-trivial task.
- **Planning docs:**
  - `PLAN.md` — active work: Current State (session-by-session, kept lean) + cumulative **Decisions Log** ("X over Y because Z", never archived). Read at `/start`, updated at `/wrapup`.
  - `PLAN-archive.md` — completed / no-longer-load-bearing detail (holds the original project-plan research + milestone + deployment record).
  - `BACKLOG.md` — idea funnel: unscoped potential work; graduates into `PLAN.md` when prioritized.
  - `ARCHITECTURE.md` — the polished public reference; update once a phase or major decision is complete.
  - `docs/handoff-pattern.md` — the public reusable methodology; `docs/internal/` (gitignored) holds this operator's audits, plans, and research (e.g. the M12 `hardening-plan.md`).
- **Memory:** `.claude/memory/` (indexed by `MEMORY.md`) holds standing decisions (`decisions_product.md`), `gotchas.md` (incl. the Codex dispatch invocation), and `conventions.md`. Portable — copy the folder to onboard another agent.
- **Cross-model handoffs:** for high-risk surfaces (IPC authorization, container mounts, auth/OAuth/secrets, scheduler correctness) run the full plan → implement → review ladder in `docs/handoff-pattern.md` §4, with Codex implementing the bounded slice and Claude gating integration. Templates in `templates/`.
- **Rules:** `.claude/rules/core.md` — code-quality, behavior, safety, and context-hygiene rules.
- Check in before starting implementation; mark items complete as you go.

## Repository & Privacy Model

KuchiClaw is a **public** portfolio project (github.com/jonathanavni/kuchiclaw) — the framework is meant to be cloned and reused — **and** the owner runs a **private** personal instance. These two goals coexist by keeping the reusable framework public and all personal/operational content local. **Never commit personal, operational, or live-deployment-sensitive content to this public repo.**

- **Public (committed):** framework source (`src/`, `container/`), `Dockerfile`, deploy scaffolding (`deploy/`, `kuchiclaw.service`), living-file *templates* (`SOUL.md`, `TOOLS.md`, `HEARTBEAT.md`, `groups/example/`), polished docs (`ARCHITECTURE.md`, `README.md`, `CLAUDE.md`), and the reusable workflow scaffolding (`.claude/commands/`, `.claude/rules/`, `.claude/settings.json`, `docs/handoff-pattern.md`, `templates/`).
- **Private (gitignored, never published):** secrets (`.env`, `data/`), agent memory (`groups/`, `.claude/memory/`), personal working state (`PLAN.md`, `PLAN-archive.md`, `BACKLOG.md`), internal working docs (`docs/internal/` — audits, plans, research), and personal Claude Code settings (`.claude/settings.local.json`).
- **Two hard rules:** (1) security-audit findings about the live deployment must never be committed while the deployment is live/unfixed — they're an attack roadmap; (2) anything under `docs/internal/` is auto-excluded by the folder gitignore, so **new audits/plans/research go there** — don't scatter them into `docs/` root. Mirrors the long-standing `groups/example/` (public) vs `groups/` (private) pattern.

## Security Model

- Containers are the security boundary — agents see only mounted directories
- Read-only mounts by default (MEMORY.md and CONTEXT.md are exceptions)
- Secrets passed via stdin, never mounted as files
- IPC requests validated before execution
- No personal account credentials — dedicated service accounts only
- `.env` file at project root for local secrets (gitignored). Loaded by `dotenv/config` in entrypoints. Contains `TELEGRAM_BOT_TOKEN`, `FASTMAIL_API_TOKEN`, `MAIN_CHAT_ID` (channel-qualified, e.g., `tg-<your-chat-id>`), `ALLOWED_SENDER_IDS` (comma-separated, optional).
- `data/oauth.json` stores OAuth tokens (chmod 600, gitignored). Never mounted into containers.
- Production: dedicated `kuchiclaw` system user owns `/opt/kuchiclaw/`, runs the systemd service, is in `docker` group. `.env` and `data/oauth.json` are chmod 600.
- `groups/` is gitignored in the main repo — agent memory is backed up to a separate private `kuchiclaw-memory` repo via `skills/backup.sh` on a systemd timer. This prevents `git pull` deployments from overwriting the agent's evolved memory.
- Backup git auth via private GitHub App: short-lived tokens (1hr), scoped `contents: write` on one repo. App private key stored on host at `data/github-app/`, never enters containers.
