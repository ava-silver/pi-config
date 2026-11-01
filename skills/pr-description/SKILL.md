---
name: pr-description
description: Update a PR description based on what's actually in the diff. Use when user says 'update PR description', 'write PR description', 'fill in PR description', 'pr description', or after creating a new PR. Writes the description as if from scratch -- not influenced by chat history or brainstorming.
allowed-tools: Bash, Read, Glob
---

# PR Description

## Key Rules

1. **Lead with why** — explain the failure, user impact, or constraint that motivates the change before summarizing it. Use evidence previously provided in the session, CI failures, or code links. Do not infer a cause that those sources do not support.
2. **Write from scratch** — otherwise ignore the conversation history. Describe the intent and outcome supported by the PR context and diff, not what was debated. Follow the `write` skill for prose style.
3. **Be brief** — the diff is the source of truth for implementation details. Don't restate it. Explanatory sections (e.g. "How") get a one-to-two sentence overview, not a play-by-play. Summary is a short bulleted list.
4. **Testing sections = manual only** — CI covers build, lint, and unit tests. Only include manual validation beyond CI done by you or the user, with the scope and result (for example, the image and platform built successfully).
5. **Link related PRs** — for cross-repository work, include each relevant related PR link and a short note explaining its relationship.
6. **Write to a temp file** — write the body to a temp file and pass it via `gh pr edit --body-file`. This is less error-prone than a heredoc (no backtick/quote escaping issues).
7. **No boilerplate** — avoid mentioning the Graphite stack or other context the reader can already deduce.

## Workflow

1. If you didn't create the PR and don't have context on it already, gather the PR's intent and implementation:
```bash
gh pr view --json title,body,files,commits,closingIssues
gh pr diff
```
If you don't have the relevant context, read linked issues and relevant failed CI logs when they explain why the change is needed. If the available context does not establish a why, ask the author rather than inventing one.

2. Check for a PR template:
```bash
cat .github/PULL_REQUEST_TEMPLATE.md 2>/dev/null || cat .github/pull_request_template.md 2>/dev/null
```
Fill every section. If no template, use Summary + Test Plan.

3. Write the description by writing the body to a temp file (e.g. with the Write tool), then:
```bash
gh pr edit --body-file /tmp/pr-body.md
```

## Diagrams

If the changes involve a non-obvious flow (e.g. a new state machine, multi-service interaction, or complex branching logic), add a Mermaid diagram using the `diagram` skill. GitHub renders Mermaid natively in PR descriptions -- output as an inline fenced block, no file needed. Only add a diagram when it meaningfully aids understanding; don't add one just to have one.

## Frontend PRs

For frontend-specific PR-description guidance, read ./frontend.md
