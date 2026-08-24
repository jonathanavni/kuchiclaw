---
description: Session kickoff — load project state and plan the session
---

# /start

Begin every session by loading project state and orienting. **Read-only — `/start` proposes; it does not write or start work.**

## Steps

1. **Read project state** — `PLAN.md` Current State + Decisions Log, and `.claude/memory/MEMORY.md` (follow its index to the relevant topic files). `ARCHITECTURE.md` is the polished public reference — skim it only if the session touches an area you're unsure about. See CLAUDE.md "Task Tracking" for the doc model.
2. **Check working state** — `git status` + `git worktree list` to surface uncommitted work, active branches, and stale worktrees, plus any running background jobs. This project deploys to a Hetzner VPS via systemd; note if the session might touch deploy state.
3. **Present status + propose priorities** — a brief summary (milestone, in-progress, blocked, next) plus a short, prioritized shortlist of candidate work for this session.
4. **Decide direction with the user** — discuss the shortlist; don't auto-start. The session's focus often emerges here, a turn or two after `/start`, and may be plural.

## Rules

- Do NOT start working automatically. Present status + proposals and wait for direction.
- If `PLAN.md` doesn't exist or is empty, say so and ask what to work on.
- Keep the status summary to ~10 lines — orientation, not a report.
- **Focus stamp (triggered, not a step):** once the session's direction is agreed, record a one-line `` `YYYY-MM-DD-<thread>` — focus: <agreed direction> `` marker atop `PLAN.md` Current State, so an interrupted or compacted session leaves a breadcrumb. `/wrapup` fills in the outcome.
