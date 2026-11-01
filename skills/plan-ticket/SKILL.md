---
name: plan-ticket
disable-model-invocation: true
description: Create an implementation plan from the current worktree branch, Jira ticket, and relevant codebase context. Use when the user says "plan ticket", "/plan-ticket", "create a plan", "implementation plan", or wants planning from a branch like ava.silver/svls-1234/description; accepts "no grill", "skip grill", or "--no-grill" to skip the grill-me review.
---

# Plan Ticket

Creates an implementation plan. By default, stress-tests it with `grill-me` before treating it as settled.

## Key Rules

1. **Planning only** — do not edit code, commit, push, or update tickets unless explicitly asked.
2. Load `acli` before any Jira or Confluence calls. Load `git-workflow` before any git commands.
3. Ask clarifying questions only after exploring ticket and codebase — if the answer is findable, find it.

## Arguments

- `--no-grill` / `no grill` / `skip grill` — skip grill-me.
- Any other text is extra context to incorporate alongside the ticket.

## Workflow

1. **Get current branch**: `git branch --show-current`. Extract ticket segment (e.g. `svls-1234` → `SVLS-1234`). If none, ask.
2. **Fetch the Jira issue** — summary, description, acceptance criteria, parent, linked docs.
3. **Explore the codebase** — `rg` for terms from the ticket; find related implementations, tests, config, ownership. Read the code, not just file names.
4. **Draft the plan**: goal + non-goals, current vs. target behavior, implementation steps, files to change, test plan, risks and open questions.
5. **Grill** (unless disabled): invoke `grill-me` with the plan and open questions. Revise as answers settle.
