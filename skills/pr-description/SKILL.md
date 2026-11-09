---
name: pr-description
description: "Use when writing or updating a PR description."
---

# PR description

Write the description from scratch, based on the PR's intent and diff -- not on what was debated in the conversation. Follow the `write` skill for prose style. Skip preambles and keep prose brief; the diff is the source of truth for implementation details.

Before writing, gather what you need to answer each section below. What that takes depends on where you run: the PR, its diff, linked issues, CI logs, related PRs, or the repository's PR template. If the available context doesn't establish why the change is needed, ask the author rather than inventing a reason.

Follow the repository's PR template when one exists, and merge these sections into it. Always include **Why**, **Summary**, and **Evidence** if equivalents are not available in the existing PR template. Add other sections as the change needs them.

```markdown
## Why

<!-- the failure, user impact, or other reason for the change. link related PRs, especially for cross-repo work -->

## Summary

<!-- the smallest visual that makes the key point clear (see ./summary-visuals.md), plus a few short bullets. don't restate the diff -->

## Evidence

<!-- before/after proof the change works, beyond routine CI. screenshots for visual changes (see frontend.md) -->
**Before:** <!-- the issue -->
**After:** <!-- the fixed result -->

## Merge danger <!-- only if reverting would cause problems -->

<!-- what makes reverting hard, and what else the change could affect -->
```

Evidence is required. If nothing beyond CI has validated the change, validate it now. If you can't, ask the user how (if it isnt already obvious) before publishing.

Write the body to a temp file and pass it with `gh pr edit --body-file`. Read the current body first if the PR already has one.
