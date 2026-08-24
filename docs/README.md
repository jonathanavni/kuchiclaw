# docs

Project documentation. KuchiClaw is a **public** repo with a **private** running instance, so docs split by visibility (see CLAUDE.md "Repository & Privacy Model").

## Public — methodology (committed)

- [`handoff-pattern.md`](handoff-pattern.md) — how the orchestrator (Claude) hands work off to the adversary/implementer (Codex). Read before any Codex handoff. This is reusable by anyone who clones the repo.

Superseded planning docs move to [`archive/`](archive/) rather than being deleted.

## Private — instance working docs (gitignored, local only)

`docs/internal/` holds documents that describe *this operator's* live deployment and are never committed: security audits, the remediation/hardening plan, and expansion research. The folder is gitignored wholesale — **any new audit/plan/research doc goes here and is auto-excluded**, no per-file `.gitignore` edits needed. Likewise `PLAN.md`, `PLAN-archive.md`, and `BACKLOG.md` at the repo root are gitignored working state.

Why: publishing detailed, unfixed-vulnerability findings about a live bot — or personal/family details from planning notes — would be irresponsible while the deployment is running. The framework code and the reusable workflow scaffolding are the public artifact; the operator's working state is not.
