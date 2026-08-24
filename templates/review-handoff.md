# Codex Adversarial Review Handoff

> Copy this, fill in the placeholders, and dispatch in `adversarial-review` mode. Codex defaults to rejection — it must be convinced the diff is solid, not the other way around.

Review the diff from <base> to <head>.

## Intent
<one-paragraph statement of what the diff is supposed to do>

## Required Reading
- CLAUDE.md
- PLAN.md (Current State)
- <relevant planning / spec doc>
- <relevant source files>
- <relevant tests>
- <relevant .claude/memory/*.md files only>

## Focus
- <specific risk area 1>
- <specific risk area 2>
- <specific risk area 3>

## Return
- Status: PASS | NEEDS-ATTENTION
- Findings ordered by severity, with file:line references
- Exact fix recommendations where possible
- Test gaps
- Residual risk
