---
description: QA review from fresh context — spawns a reviewer subagent that defaults to rejection
---

# /review

Spawn a QA reviewer subagent with fresh context to review recent implementation work. The reviewer defaults to "NEEDS WORK" — it must be convinced the code is solid, not the other way around.

This is the **same-model** review channel. For high-risk code, pair it with a **cross-model** Codex pass (step 5) — the two catch largely disjoint issues. See [`docs/handoff-pattern.md`](../../docs/handoff-pattern.md) §7.

## When to Use

- After completing a milestone or multi-step feature
- Before committing a significant batch of changes
- When you want a second opinion on architectural choices
- For the security-critical surfaces (IPC authorization, container mounts, auth/OAuth token handling, secrets): run the full flow (Claude reviewer → Codex cross-model review → `/security-review`)

## Steps

1. **Determine review scope** — `git diff --stat` and `git diff --name-only` for the changed files; read `PLAN.md` for the current milestone's requirements and verification checklist.

2. **Scale review depth** by change magnitude:
   - Under 200 lines: full detail review of every line
   - 200–1000 lines: focused review on critical areas (security, IPC/auth, error handling)
   - Over 1000 lines: architectural-level review + spot-check critical paths

3. **Spawn reviewer subagent** (Agent tool) with a strong reasoning model and the prompt template below.

4. **Process the report:**
   - PASS → proceed to step 5 or commit/wrapup
   - NEEDS WORK → fix critical issues, then re-review
   - Don't argue with the reviewer — fix the issues, or explain to the user why you disagree.

5. **Cross-model review** — for IPC/auth, container-isolation, OAuth/secrets, or scheduler correctness code, run a Codex `adversarial-review` pass on the same diff. Mandatory for the container security boundary and auth code, recommended for IPC/scheduler changes, skip for internal refactors/tests/docs. See [`docs/handoff-pattern.md`](../../docs/handoff-pattern.md).

## Reviewer Prompt Template

Fill in `{{SCOPE}}`, `{{FILES}}`, `{{REQUIREMENTS}}`, and `{{VERIFICATION_CHECKLIST}}`.

```
You are a QA Reviewer for KuchiClaw (a minimal AI-agent framework: Node.js/TypeScript orchestrator + ephemeral Docker containers running the Claude Agent SDK, Telegram interface, SQLite state, filesystem IPC, systemd on a Hetzner VPS). Review recent implementation work with fresh eyes. Default to "NEEDS WORK" — only pass if everything is genuinely solid.

## Context
{{SCOPE}}

## Files to Review
{{FILES}}

## Requirements & Design Decisions
{{REQUIREMENTS}}

## Your Task

1. Read all files listed above — every new and modified file.
2. Check for these specific issues:

### Security (CRITICAL)
- The container is the security boundary — is anything mounted rw that shouldn't be? Can a prompt-injected agent escape its group's scope?
- IPC authorization: is `group`/`chatId` derived from the trusted path, never from container-supplied payload fields?
- Secret exposure: OAuth refresh token / Fastmail token reaching untrusted container env, secrets in logs or process argv, injection into containers
- Telegram input handling: sender allowlist, @mention gating, command injection

### Correctness (CRITICAL)
- Does the implementation match the requirements?
- Race conditions: concurrent containers, OAuth refresh, scheduler double-fire, queue drain, re-entrant IPC polling
- Error handling: unhandled rejections that crash the long-running orchestrator, swallowed errors, partial-failure states
- Container lifecycle: does a timeout actually stop the container? Do retries duplicate side effects?
- Crash recovery: orphaned-message re-enqueue edges

### API / Contract (HIGH)
- IPC request shape, DB schema, ContainerInput/Output types — kept in sync across host and container?

### Code Quality (MEDIUM)
- Dead code, unused exports, duplicated logic; files over ~200 lines (project convention); comments explain WHY not WHAT

### Docs (CRITICAL when relevant)
- If the diff changes behavior CLAUDE.md / ARCHITECTURE.md describe, verify those docs were updated in the same change. Flag drift.

3. If it's a running-service change, exercise it yourself where feasible:
{{VERIFICATION_CHECKLIST}}

4. Return a structured report:

## Status: PASS | NEEDS WORK

## Critical Issues (must fix before shipping)
- [file:line] Description. Why it matters. How to fix.

## Warnings (should fix, not blocking)
- [file:line] Description. Why it matters.

## Observations (nice to fix, low priority)
- [file:line] Description.

## What Works Well
- Positive observations.

Be thorough. Be harsh. The implementer wants to ship quality code, not hear that everything looks good.
```

## Rules

- Always use a strong reasoning model for the reviewer — it needs the horsepower to find subtle issues.
- Never skip the review for milestone completions, even when you're confident.
- The reviewer's report is advisory — the user makes the final call on what to fix.
- After fixing critical issues, consider re-running `/review` to verify the fixes.
- Cross-model review (step 5) is mandatory for the container security boundary and auth/secret code.
