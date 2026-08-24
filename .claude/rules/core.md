# Core Rules

## Code Quality

- Many small files (200–400 lines, 800 max). Functions under 50 lines. Max 4 levels of nesting.
- Schema-based input validation at system boundaries (API endpoints, external data). Trust internal code.
- After refactoring, identify dead code explicitly. Ask before deleting.

## Implementation Behavior

- Surface assumptions as a numbered list before non-trivial tasks. "Correct me now or I'll proceed with these."
- When confused, STOP and ask. Name the confusion, present the tradeoff, wait.
- Summarize changes after modifications: what changed, what was left alone, any concerns.
- Use corrective framing: "you should be doing X — are you still doing it?" beats "remember to do X."

## Safety

- Never hardcode credentials. Reference them from `.env` files.
- Before destructive operations (DELETE, DROP, force-push), confirm with the user.
- External communications (git push, API calls, PR comments) require explicit approval.

## Context Hygiene

- After compaction, re-read `PLAN.md` and the relevant files before continuing.
- Write important outputs (schemas, decisions) to files immediately.
- When switching between unrelated tasks, suggest `/clear`.
- Keep fewer than 10 MCP servers enabled.
