# Claude + Codex Handoff Pattern

The canonical reference for how the orchestrator (Claude Code) hands work off to the adversary/implementer (Codex). Read it before any non-trivial Codex dispatch.

> The pattern is model-agnostic. "Claude" and "Codex" are the two families this repo is wired for, but the roles matter more than the brands — you could run the orchestrator on one frontier model and the adversary on another (Gemini, GLM, etc.). What makes it work is that the model reviewing or attacking the code is a *different family* than the one that wrote it.

Companion essay: [Two Models Today, Meta-Harnesses Tomorrow](https://jonathanavni.com/blog/two-models-today-meta-harnesses-tomorrow).

---

## Purpose

This repo runs a Claude Code-native operating model: `CLAUDE.md`, `.claude/commands/*`, `.claude/memory/*`, `PLAN.md`, and a review cadence. Codex *extends* that workflow, it does not replace it.

Use Claude Code as the **continuity owner** and Codex as a **fresh-context, different-model-family agent** for bounded review or implementation.

Codex runs from inside Claude Code through the [OpenAI Codex plugin](https://github.com/openai/codex-plugin-cc). Install and authenticate it per the plugin's README before using this pattern.

---

## 1. Dispatch Mechanics

Codex from Claude Code runs through the local Codex CLI via a companion script shipped with the plugin.

**Claude dispatches Codex via direct bash to the companion script.** Claude is the dispatcher; the user does not have to type a slash command for Codex to get involved. When the workflow patterns below warrant Codex (plan-stage adversarial review, post-impl review, scoped implementation, deeper investigation), invoke proactively:

```bash
node "<path-to>/codex-companion.mjs" <mode> "<prompt>"
```

> The exact companion-script path and flag set are owned by the plugin and change across versions. Treat the plugin's own docs as the source of truth, and pin the working invocation for your machine in `.claude/memory/gotchas.md`.

Modes (current plugin):

- **`task`** — rescue-equivalent. Use for: deeper-investigation passes, second-opinion debugging, scoped implementation when Codex is the better-suited writer, "I'm stuck, let the other model try."
- **`adversarial-review`** — adversarial diff or plan review. Use for: pre-impl plan review, post-impl diff review, gating-code stress test, contract-drift checks.
- **`review`** — built-in reviewer (less adversarial, more correctness-checking). Rarely the right choice; prefer `adversarial-review` for design stress-tests.

For long prompts, write the prompt to a file first and pass its contents, rather than inlining a multi-line string. Dispatch long-running work in the background and wait on the completion notification.

**Slash commands** (`/codex:review`, `/codex:adversarial-review`, `/codex:rescue`) exist for direct user invocation. Claude should use the direct-bash path instead — it is operationally simpler and is what the slash commands call internally anyway.

---

## 2. Role Split

### Claude owns continuity

Claude is the project-thread owner:

- Run session kickoff (`/start`) and wrapup (`/wrapup`)
- Read and maintain `PLAN.md`
- Read and maintain `.claude/memory/*`
- Update planning docs after work lands
- Coordinate branches, worktrees, and reviews
- Decide sequencing across milestones
- Preserve project intent across sessions

Claude holds the broader narrative: which milestone we are on, which decisions are locked, which risks are active, and what should happen next.

### Codex owns bounded challenge or execution

Codex is best used for:

- Adversarial plan review before risky work
- Post-implementation review before merge
- Isolated implementation slices with clear file ownership
- Tests and edge-case hardening
- Contract and wire-shape review
- Surfacing stale surfaces the orchestrator missed

Codex receives a precise contract, not a vague instruction to learn the entire project.

---

## 3. Build vs Audit Mode

Codex behaves differently depending on the shape of the work. Pick the framing on dispatch; do not conflate.

### Build mode (verifier framing)

Claude has drafted a plan or shipped a diff. Codex is shown the artifact and asked to pressure-test it. Default to rejection; cite `file:line` for every claim.

Use for: plan reviews, post-impl reviews, contract/wire-shape reviews, migration reviews, payment-path reviews.

### Audit mode (blind parallel framing)

The work is open-ended ("find tech debt across the codebase," "what did we miss"). Showing Codex the orchestrator's findings biases it toward convergence and reproduces shared blind spots.

Run Codex *independently* on the same scope brief, with no findings shown. Then synthesize:

- Items in both = high confidence
- Claude-only = Codex's blind spot
- Codex-only = Claude's blind spot

Use for: tech-debt sweeps, perf audits, security audits, "what did we miss" reviews.

Audit mode is structurally better for "find," verifier mode is structurally better for "challenge."

---

## 4. Plan-Review and Code-Review Sequencing (the ladder)

For high-risk or gating work, run the full ladder. **Claude is continuity owner; Codex implements bounded slices.** Step 4 is the load-bearing default — Claude implementing the slice in parallel defeats the cross-model coverage the ladder exists to provide.

1. The human gives the high-level requirements and the acceptance/test criteria.
2. Claude drafts the plan (root causes, risks, sequencing, decisions).
3. Codex adversarial pre-impl review on the plan (build mode, verifier framing).
4. Claude synthesizes findings and locks the plan.
5. **Codex implements one bounded slice** on a dedicated branch / worktree (see §9). Claude does not implement in parallel for high-risk-surface work; its role here is integration-gating, not authorship.
6. Claude `/review` (fresh-context QA) on the diff.
7. Codex adversarial post-impl review on the same diff.
8. Round 2 if needed (see §5).
9. Claude integrates, merges intentionally, and updates `PLAN.md` and memory.

**High-risk surfaces — always run the full ladder, with the implementation step defaulting to Codex.** Generalize this list to your own project; common members:

- Database schema changes / migrations
- Auth, sessions, access control
- Payment, billing, or money-movement code
- Public API or wire-shape contracts (REST, MCP, RPC, SDK types)
- Bulk data-write or backfill jobs
- Anything touching a locked gate, threshold, or invariant

**Carve-outs — Claude may implement when:**

- The bounded slice is a single-file edit (~50 LoC or less) mechanically absorbing pre-impl review findings.
- The change is an isolated test addition with no production-code touch.
- The change is internal copy / docs polish on a non-public surface.
- Time-criticality plus the user explicitly asks Claude to implement.

In every other high-risk case, default to Codex. If Claude finds itself reaching for the editor on high-risk-surface code without a carve-out reason, that is the signal to stop and hand off.

Lower-risk work (single-file edits, scripts, internal docs) can use a subset of the ladder — often Claude-only, or Claude plus a post-impl Codex pass.

---

## 5. Round-2 / Iteration Rules

When round 1 returns `NEEDS-ATTENTION` and Claude absorbs the findings, **run round 2 on the absorbed-fix diff for gating / correctness code.** This is not theater. Round 2 routinely catches:

- Stale sub-sections in a doc when only the top-level was amended (sub-section drift)
- New bugs introduced by absorbing round-1 findings
- Cross-cutting concerns the round-1 fix exposed

**Cap at round 3.** If round 4 is forming, the design primitive is wrong — redesign, do not patch further. Symptoms of a stuck design:

- Findings get *harder* each round (not narrower)
- New findings span the same load-bearing area each round
- The absorbed fix keeps creating sibling issues

### 5.1 Absorption-completion sweep (mandatory before round N+1)

Sub-section drift is the highest-frequency round-2/3 finding class — awareness is not enough, so this is a gate, not a reminder. After absorbing **any** review finding into a doc or spec, run this sweep **before** declaring the version done or dispatching the next round:

1. **Extract the changed token(s)** — the renamed function, the new count, the rejected gate, the changed contract value.
2. **Grep the full doc** for each old token. Every surviving hit is drift — fix it inline, or replace it with a "see X for canonical spec" reference.
3. **Grep sibling locked docs** whose semantics the amendment governs. A fix that lives only as "intent" in your plan while a locked doc still spells out the rejected approach is a reintroduction hole.
4. **Only then** mark the finding absorbed in the `PLAN.md` Decisions Log. If you decide *not* to change a hit, say why — silence reads as "missed it."

---

## 6. Synthesis Discipline

`NEEDS-ATTENTION` from Codex is a serious review input — **not** an automatic stop-the-line verdict.

Codex does not have full context on:

- **Product stage** — early/pre-launch vs mature. Pre-launch with no users means operational drift outweighs attacker theater.
- **Threat model** — defensive against operational drift vs hardening against sophisticated attackers.
- **Priority** — correctness vs cost vs observability.
- **Round history** — a round-3 finding may be an acceptable tradeoff even when adversarially defensible.

After `NEEDS-ATTENTION`:

1. **Classify each finding** by user-visible impact (correctness vs cost vs observability).
2. **Weigh against project stage.**
3. **Consider round history** — narrower findings → patch; harder findings → redesign or punt.
4. **Document the synthesis in the `PLAN.md` Decisions Log** — future sessions need to see *why* a finding was absorbed, declined, or punted, not just that it was.

`NEEDS-ATTENTION` means "here are the findings, decide." It does not mean "do not merge." The same discipline applies to Claude `/review` findings — both reviewers default to rejection by design.

---

## 7. Claude `/review` and Codex Complementarity

`/review` and Codex are two review channels, not one fallback for the other. They catch different bug classes:

**Claude `/review`** (fresh-context QA)
- Same model family as the implementer
- Full project context — `CLAUDE.md` + memory + repo conventions loaded
- Defaults to rejection
- Strong on: convention violations, "does this match how the rest of the codebase does X," subtle correctness inside domain logic, doc/spec drift

**Codex adversarial review**
- Different model family
- Less project context (only what is in the handoff packet)
- Defaults to rejection
- Strong on: deeper-merge semantics, cross-system races, contract drift across files, silent reinterpretation of locked gates, blind spots the orchestrator's family shares

Empirically across many sessions, each catches issues the other misses, and the two finding-sets are largely disjoint. For gating / correctness / security / payment code, **run both on the same diff** — not one or the other. Same-model review (only `/review`, or only Codex) shares blind spots within its own family. Cross-model is the high-leverage move.

### 7.1 A security-specialized third channel

If your toolchain ships a security-specialized reviewer (Claude Code's built-in `/security-review`, for example), treat it as a *third* channel on top of generalist `/review` + Codex, not a universal gate. Run it, in addition to the normal ladder, when a change touches a security surface:

- Auth, sessions, access control
- Payment, billing, or money-movement code
- Public API wire, rate-limit / quota / payment gates
- Secret and credential handling
- Database migrations and the queries they expose

Skip it on refactors, pure docs, and non-security features. It is typically same-model (Claude) and diff-aware (blind to pre-existing code), so keep the Codex pass for cross-model coverage, and run a baseline sweep separately for the code that already exists.

---

## 8. Codex Must-Not-Do List

To preserve single-owner project continuity, Codex must not:

- Edit `PLAN.md`
- Edit `.claude/memory/*`
- Update planning / roadmap docs
- Make milestone-sequencing decisions
- Make launch-readiness calls
- Reinterpret locked gates or thresholds
- Decide tradeoffs between cost and correctness
- Touch unrelated files outside the handoff packet's stated scope
- Push, merge, or close branches without Claude orchestration

If a Codex review or implementation surfaces a planning decision, it goes back to Claude (and the user) — not absorbed silently. Codex implements or reviews; Claude synthesizes and updates project state.

---

## 9. Branch and Worktree Discipline

Claude and Codex should not edit the same worktree at the same time.

Convention:

- `main` is the clean integration branch.
- `claude/<task>` is Claude's implementation branch.
- `codex/<task>` is Codex's implementation or review branch when Codex is doing the writing.

For implementation handoffs, Claude tells Codex: the branch/worktree to use, the base commit, the files Codex owns, the files Codex must not touch, and whether Codex may update docs or only code and tests.

For review handoffs, Codex does not edit unless explicitly asked. It returns findings with `file:line` references and severity.

---

## 10. Handoff Templates

Fill-in-the-blank packets live in [`../templates/`](../templates/):

- [`templates/implementation-handoff.md`](../templates/implementation-handoff.md)
- [`templates/review-handoff.md`](../templates/review-handoff.md)

### Required-reading rules

Keep Codex's required reading short and task-specific. Always include `CLAUDE.md`, `PLAN.md` Current State, the relevant source files, and the relevant tests. Add `SCHEMA.md` (or your other contract docs) only when the change touches the schema or a contract. Add the relevant planning doc from `docs/` when one governs the work. Do not bulk-load all of `.claude/memory/` by default — include only the memory files relevant to the task.

### Good vs bad handoff

Bad:

```
Implement the new endpoint.
```

Better:

```
Implement default-branch URL correctness in the repo-import path.

Problem:
Source URLs are built assuming every repo's default branch is `main`.

Scope:
- Plumb the real default branch from the repo-fetch path into normalization.
- Build source.url and raw_url from the actual default branch.
- Add a regression test for a repo whose default branch is `master`.
- Do not change discovery, search, or the source interfaces.

Acceptance:
- Existing import tests pass.
- New non-main default-branch test fails before the change and passes after.
- No public API wire-shape changes.
```

If the scope cannot be expressed as concrete behavior + tests, ask Codex for plan review first, not implementation.

---

## 11. Implementation Slices That Fit Codex Well

Good Codex implementation tasks:

- Add a focused CLI around already-planned library code
- Add tests for a known edge-case class
- Implement one migration + wrapper + tests
- Update generated types for a locked wire-shape
- Harden a parser against ambiguous input
- Implement one sub-task of a larger track, not the whole track

Poor Codex implementation tasks:

- "Finish phase 4"
- "Improve quality"
- "Clean up the data layer"
- Any task where the desired behavior is not yet locked
- Any task requiring broad product judgment without a plan

Keep work local (Claude) when it is mostly project-state writing, product/strategic synthesis, blocked on live user judgment, or a small single-file edit whose handoff packet would take longer to draft than the change.

---

## 12. Acceptance Criteria Discipline

Codex handoffs must include **rejection-path tests, not just happy paths**. For example:

- Rate-limit / quota code tests under-limit, at-limit, and over-limit behavior
- Input-handling code tests malformed input and the error envelope shape
- Write-path code tests that stale writes are rejected
- Wire-shape changes test for contract drift

If a task changes a gate, threshold, or public contract, require before/after artifacts. Do not accept silent reinterpretation of a locked gate — a recurring failure mode.

---

## 13. Reporting Formats

### Implementation report

```
## Summary
- ...

## Files Changed
- ...

## Verification
- <test command> PASS
- <build command> PASS
- Not run: <reason>

## Risks / Follow-ups
- ...

## Deviations From Handoff
- None
```

### Review report

```
## Status: PASS | NEEDS-ATTENTION

## Findings
- [P1] file:line — issue, impact, fix
- [P2] file:line — issue, impact, fix

## Test Gaps
- ...

## Residual Risk
- ...
```

Use `PASS | NEEDS-ATTENTION` verbatim so both labels are greppable in session logs and the decisions log.

---

## Summary Rule

**Hand Codex less history and more contract.**

Claude preserves the broad project narrative. Codex receives the exact task, exact context, exact files, exact invariants, exact tests, and exact non-goals. That is the highest-leverage way to use a second model family from inside Claude Code.
