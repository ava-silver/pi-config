---
name: adversarial-review
disable-model-invocation: true
description: 'Run two independent, interactive reviews of the current diff, adjudicate findings, and propose changes for user approval without editing files.'
---

# Adversarial Review

Stress-test the current change with two independent applications of the repository's code-review skill, then recommend what, if anything, should change. Do not implement recommendations.

## Workflow

1. Define the scope from the user's arguments. Otherwise review staged, unstaged, and untracked changes versus `HEAD`. If the working tree is clean, review the current PR diff against its base branch. Stop only if there are no working-tree changes and no associated PR.
2. Read `../code-review/SKILL.md`. Collect the diff, commit list, applicable standards, and available spec sources its process requires.
3. Spawn exactly two subagents in parallel. Give both the repository path, scope, diff command, commit list, standards sources, and spec source. Require each to:
   - Read and apply `code-review/SKILL.md` to the full scope.
   - Inspect every changed hunk plus relevant surrounding code and tests.
   - Make no edits and use only read-only git commands.
   - Spawn no subagents.
   - Use `ask_parent` instead of guessing when missing context or intent could materially change a finding. Investigate available sources first, then ask one focused question that states what remains unclear.
4. When a reviewer asks a question, verify whether the code, standards, requirements, or conversation already answer it. Respond with `subagent_answer`. Use `ask_user` only when the answer requires the user's intent; then relay the answer to the reviewer. Do not answer from assumption.
5. Add one emphasis to each review without narrowing the shared code-review rubric:
   - **Failure lens:** aggressively test logic, error paths, state transitions, security, compatibility, and operational behavior.
   - **Design lens:** aggressively test clarity, cohesion, duplication, boundaries, change risk, and whether tests expose behavior.
6. Verify every finding yourself against the code, standards, and requirements. Merge duplicates only after verification. Investigate uncertainty until resolved or list it as remaining risk.
7. Separate findings that belong to the current work from worthwhile changes outside its scope. Push back on a suggestion when you see:
   - **Scope creep:** it expands beyond the current change, including adding or changing code ownership.
   - **Disproportionate refactor:** its churn and review burden outweigh its benefit.
   - **Unclear requirement:** intended behavior needs clarification.
   - **Intentional tradeoff:** the current behavior serves another known constraint.
   - **Weak evidence:** it lacks a concrete, plausible failure mode.
   - **Compatibility risk:** it could break APIs, data, clients, or workflows that are currently in production. Don't assume code is in production, so this one is a softer suggestion.

   Reviewer agreement is evidence, not approval.
8. Present the changes you recommend and wait for the user to decide what to pursue. Do not edit files, even when a fix appears safe or obvious.
9. Report only:
   - **Proposed:** severity, issue, recommended change, rationale, affected files, and verification plan. Clearly flag scope expansion and other reasons the user may want to decline.
   - **Disagreed:** severity, claim, and concrete rejection reason.

## Guardrail

The workflow is read-only. Never edit files or stage, commit, amend, switch branches, reset, rebase, or push.
