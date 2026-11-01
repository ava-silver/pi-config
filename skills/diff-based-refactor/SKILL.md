---
name: diff-based-refactor
disable-model-invocation: true
description: 'Run explicit refactors as surgical, diff-first changes optimized for human review. Use when the user asks to refactor, restructure, or migrate existing code.'
---

# Diff-Based Refactor

Treat the target-branch diff as the refactor's product. Make the smallest surgical patch that achieves the requested design while preserving behavior and reviewability.

## Workflow

1. Define the requested outcome, behavioral invariants, scope, and target branch. Load the repository's git workflow before git operations. Establish the merge-base with the target branch so the canonical diff matches what GitHub will show and a human will review.
2. Check repository status. Prefer a clean tree. If changes already exist, explain the overlap risk and ask before proceeding, even when they appear unrelated.
3. Prefer a dedicated branch and PR for the refactor. If the work is not already isolated, recommend one and ask before editing; follow the user's choice.
4. Plan surgical edits around the diff, not an idealized rewrite. Preserve surrounding structure, ordering, names, comments, and formatting when changing them is unnecessary for the requested outcome.
5. Implement one logical step at a time. After each step, inspect the full diff from the target merge-base, choosing normal, whitespace-agnostic, word, or statistical views as useful. Account for every changed hunk.
6. If the patch grows beyond expectations, pause and explain the source of the growth before continuing. Ask before including each unrelated cleanup opportunity.
7. Follow repository-required formatters, generators, and validation even when they add churn. Keep required generated changes and identify their footprint rather than hand-editing around repository tooling.
8. At completion, review the full PR-shaped diff again. Confirm each hunk supports the refactor or required tooling, run repository-appropriate validation, and report unavoidable churn or remaining review risk.

## Decision Rule

When clean final design conflicts with a smaller correct diff, choose the smaller reviewable diff. Expand only when correctness, the requested outcome, or required repository tooling demands it.
