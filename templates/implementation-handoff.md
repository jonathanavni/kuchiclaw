# Codex Implementation Handoff

> Copy this, fill in every angle-bracket placeholder, delete the guidance comments, and hand it to Codex. The discipline: **less history, more contract.**

## Task
Implement <specific item>.

## Branch / Worktree
Work in: <branch or worktree>
Base commit: <sha>
Do not modify unrelated files.

## Required Reading
- CLAUDE.md
- PLAN.md (Current State only)
- <relevant source files>
- <relevant tests>
- <schema/contract doc, only if the change touches it>
- <relevant .claude/memory/*.md files only — do not bulk-load memory>

## Context
- <5-10 bullets: current state, why this task matters, what already shipped, known risks>

## Scope
Implement:
- <specific behavior>
- <specific tests>
- <specific docs/schema updates, if any>

Do not implement:
- <explicit non-goals>
- <future work>
- <adjacent tempting refactors>

## File Ownership
Codex owns:
- <paths>

Codex must avoid:
- PLAN.md
- .claude/memory/*
- unrelated planning docs
- public contract files unless included in scope

## Acceptance Criteria
Behavior:
- <observable behavior>

Tests:
- <unit / integration / contract tests expected>
- <rejection-path tests, not just happy paths>

Docs:
- <docs or schema updates required>

Safety:
- <failure path / rejection path / race path>

## Verification Commands
Run:
- <test command>
- <build command>

## Reporting Back
Return:
- Summary of changes
- Files changed
- Tests run and results
- Risks / open questions
- Any intentional deviations from this handoff
