# KuchiClaw

[![CI](https://github.com/jonathanavni/kuchiclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/jonathanavni/kuchiclaw/actions/workflows/ci.yml)

A minimal AI agent framework with Docker container isolation, built from scratch in TypeScript.

("Kuchi" — a nickname meaning "tiny one." This is the tiny claw.)

## Why does this exist?

I built KuchiClaw to learn the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) hands-on, to understand [OpenClaw](https://openclaw.ai/)'s architecture by building a simpler version of it, and to end up with something I'm actually going to use for personal automation. It's inspired by [NanoClaw](https://github.com/qwibitai/nanoclaw) (~3,900 lines), a lightweight alternative to OpenClaw (434K lines). KuchiClaw takes the same core architecture — ephemeral containers, living files, filesystem IPC — and builds the smallest version that works in production.

Today it's a production-ready, self-healing agent running 24/7 with durable backups. It's also not a framework you install — it's a reference implementation you clone, read, modify, and make your own. The architecture is intentionally simple enough that you can add new skills, swap out the messaging channel, or change the memory system without fighting abstractions.

## How it works

```
Telegram ──> Orchestrator ──> Per-Group Queue ──> Container Runner ──> Docker
   ^              |                                      |
   |              |                                      v
   |         +----+----+                          +-------------+
   |         | SQLite  |                          |  Container  |
   |         |messages |                          | Claude SDK  |
   |         | tasks   |                          | SOUL.md (ro)|
   |         +---------+                          | TOOLS.md(ro)|
   |                                              | MEMORY (rw) |
   |              IPC Poller <-- JSON files <---- | CONTEXT(rw) |
   |              |                               | skills/ (ro)|
   +--------------+                               +-------------+
```

Each user message triggers a fresh Docker container. The container gets the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), read-only personality/tool files, read-write memory files, and recent conversation history. The agent runs, responds, and the container is destroyed.

**Containers are the security boundary.** The agent can only see what's explicitly mounted. Secrets are passed via stdin — never written to disk. IPC requests are validated and authorized before execution.

**Memory persists across sessions** through four living files:

| File | Scope | Access | Purpose |
|------|-------|--------|---------|
| SOUL.md | Global | Read-only | Personality, behavior rules |
| TOOLS.md | Global | Read-only | Available tools and usage docs |
| MEMORY.md | Per-group | Read-write | Long-lived curated facts |
| CONTEXT.md | Per-group | Read-write | Session working memory |

For the full architecture deep-dive — design decisions, tradeoffs, and implementation phases — see [ARCHITECTURE.md](ARCHITECTURE.md).

## Clone it and make it yours

KuchiClaw is designed to be forked and customized. The codebase is ~2,000 lines across 15 source files. Here's what you can change:

- **Add skills** — drop a script in `skills/`, document it in TOOLS.md. The agent shells out to run it. Or add MCP servers via `mcp-servers.json`.
- **Change the personality** — edit [SOUL.md](SOUL.md). This is the agent's system prompt identity.
- **Add messaging channels** — implement the 5-method `Channel` interface in `src/channels/`. Telegram is included; WhatsApp, Discord, Slack, or email could follow the same pattern.
- **Extend the memory system** — the living file pattern is deliberately simple. Add new files, change the compaction strategy, or wire in vector search.
- **Add scheduled behaviors** — tasks are database rows (cron, interval, or one-shot). Create them via IPC or direct DB insert. The heartbeat system uses this for self-maintenance.

### Prerequisites

- Node.js 24+
- Docker
- A [Claude Max](https://claude.ai) subscription (for OAuth) or an [Anthropic API key](https://console.anthropic.com/)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### Quick start

```bash
git clone https://github.com/jonathanavni/kuchiclaw.git
cd kuchiclaw
npm install
npm run build
docker compose build
```

Create a `.env` file:

```bash
# Required
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
MAIN_CHAT_ID=tg-your-chat-id       # Send /start to the bot — it echoes your chat ID (prefix with tg-)
ALLOWED_SENDER_IDS=123456789        # /start also echoes your user ID; comma-separated ("*" = explicitly allow anyone)

# Optional
ANTHROPIC_API_KEY=sk-ant-...        # Fallback if OAuth isn't set up (auto-downgrades to Sonnet 5)
FASTMAIL_API_TOKEN=...              # For the email skill
FASTMAIL_GROUPS=main,tg-123         # Explicitly entitled groups (unset/empty = no access)
```

### Authentication

**Option A: Claude Max OAuth (recommended)** — uses your existing Claude Max subscription. Export tokens to `data/oauth.json`:

```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "expiresAt": 1767225600000
}
```

`expiresAt` is milliseconds since the epoch (as stored by the macOS keychain).

On macOS, `deploy/export-oauth.sh` extracts tokens from the keychain automatically. Tokens are refreshed at the start of each container run and persisted back to `oauth.json` — no manual rotation needed.

**Option B: API key** — set `ANTHROPIC_API_KEY` in `.env`. Pay-per-use billing. Automatically uses Sonnet 5 instead of Opus to reduce costs.

### Run

**Telegram bot (primary):**

```bash
npx tsx src/index.ts
```

**CLI (for testing):**

```bash
npx tsx src/cli.ts "What is 2+2?"
npx tsx src/cli.ts --group mygroup "Remember that I like coffee"
npx tsx src/cli.ts --history
```

## Adding skills

Skills extend what the agent can do. Two tiers:

### Simple skills (recommended)

Drop a script in `skills/`, document it in [TOOLS.md](TOOLS.md). The agent reads the docs and shells out.

```bash
# skills/weather.sh
#!/bin/bash
curl -s "https://wttr.in/$1?format=3"
```

Then add usage docs to TOOLS.md so the agent knows how to call it. That's it — no registration, no protocol, no framework code.

### MCP skills

For tools that benefit from structured schemas, add an entry to `mcp-servers.json`. The Claude Agent SDK auto-discovers tools from MCP servers.

## Repository structure

This repo contains **code and configuration only**. The agent's living memory files (`groups/*/MEMORY.md`, `groups/*/CONTEXT.md`) are created at runtime and backed up to a separate private repo. This separation prevents code deployments (`git pull`) from overwriting the agent's evolved memory.

```
kuchiclaw/                (this repo — public, code + config)
  SOUL.md                 Agent personality (edit this to change who the agent is)
  TOOLS.md                Tool documentation (edit this when adding skills)
  HEARTBEAT.md            Self-maintenance checklist
  src/                    ~4,000 lines across ~26 files
  container/              Runs inside Docker (Claude Agent SDK)
  skills/                 CLI scripts mounted into containers
  groups/example/         Example living files for reference
  deploy/                 VPS provisioning, systemd units, backup timer

kuchiclaw-memory/         (separate repo — private, agent memory)
  groups/*/MEMORY.md      Backed up daily from the VPS
  groups/*/CONTEXT.md
  kuchiclaw-backup.db     SQLite snapshot
```

## Deployment

KuchiClaw runs on a VPS as a systemd service. See [ARCHITECTURE.md — Deployment](ARCHITECTURE.md#deployment) for full details including platform evaluation, security hardening, and backup strategy.

```bash
# Provision a VPS (Ubuntu 24.04)
bash deploy/setup.sh

# Transfer secrets
scp .env root@your-server:/opt/kuchiclaw/.env
scp data/oauth.json root@your-server:/opt/kuchiclaw/data/oauth.json

# Start
systemctl start kuchiclaw
```

Fresh installs self-initialize their IPC layout on first start. Upgrading an instance that predates the M12 hardening requires the one-time `deploy/cutover-m12-p1.sh` — without it the startup attestation gate refuses to run against a legacy data tree.

Daily backups of living files and the SQLite database are pushed to a private GitHub repo via a systemd timer and a scoped GitHub App (short-lived tokens, `contents: write` on one repo). See `skills/backup.sh` for the implementation.

## Tests

```bash
npm test
```

## Architecture highlights

A few decisions that might be interesting if you're building something similar:

- **No microservices.** Single Node.js process orchestrates everything. Docker containers are ephemeral workers, not services.
- **Filesystem IPC over HTTP.** Containers write JSON files to a mounted directory. The host polls, validates, executes. No sockets, no HTTP servers inside containers, no port management.
- **Living files over vector databases.** Agent memory is markdown files the agent reads and writes directly. Simple, auditable, version-controllable. Scales to thousands of facts before you'd need anything fancier.
- **Per-group isolation.** Each Telegram chat gets its own memory, context, and IPC authorization scope. The main chat has admin access; others are sandboxed.
- **Crash recovery.** Messages track processing status in SQLite. On restart, orphaned messages are detected and re-enqueued automatically.
- **OAuth auto-refresh.** The bot uses a Claude Max subscription without manual token management. Tokens refresh at the start of each container run and are persisted back to the host.

## Prior art

- [NanoClaw](https://github.com/qwibitai/nanoclaw) — the primary reference (~3,900 lines, 15 files)
- [OpenClaw](https://openclaw.ai/) — the full-scale system NanoClaw simplifies (434K lines)
- [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) — the agent runtime inside containers

## License

MIT
