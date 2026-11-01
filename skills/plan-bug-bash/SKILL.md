---
name: plan-bug-bash
disable-model-invocation: true
description: 'Plan a bug bash from a Jira epic — synthesize what shipped, brainstorm validation tasks grouped by shared-resource contention, and produce an Excel sheet to upload to Google Drive. Use when the user says "plan bug bash", "/plan-bug-bash", "create a bug bash spreadsheet", or wants to turn an epic into validation test cases.'
allowed-tools: Read, Write, Bash, Glob, Grep, Skill
---

# Plan Bug Bash

Drives an epic to a bug bash plan: the **bug bash** is the meeting where testers validate the shipped work. Produces two artifacts in the **current working directory**: `BUG-BASH.md` (reviewable plan) and `<project>-bug-bash.xlsx` (the sheet).

On invocation, glob for `BUG-BASH.md`; if it exists, summarize it and ask whether to resume iterating or start fresh.

Load the `acli` skill before any Jira or Confluence call. `grill-me` is required for Phases 1–2 — if missing, install: `npx -y skills@latest add https://github.com/mattpocock/skills -g -y -a claude-code -s grill-me`.

## Phase 1 — Context (what shipped)

Ask for the target epic key if not provided. Then use `acli`:
- Fetch the epic (summary + description) and confirm its summary back to the user.
- Fetch all child issues (summary + description). These are the **primary** signal for what was built.
- If a ticket is ambiguous or thin, dig into its linked PRs or the RFC/design doc for more detail.

Synthesize a summary of what shipped, then invoke `grill-me` focused on **what was actually built and what's risky** — surface gaps, ambiguous behaviors, and areas most worth validating. Goal: shared understanding before drafting tasks, so the first draft is close to final.

## Phase 2 — Draft → `BUG-BASH.md`

Follow the structure in `BUG-BASH-FORMAT.md` (bundled alongside this skill).

1. **Tasks are not 1:1 with tickets.** A task is a single verifiable behavior a tester can confirm in one sitting (minutes to ~an hour). One ticket may spawn several tasks; several small tickets may collapse into one. Propose the split and iterate with the user until approved.
2. **Group tasks by shared-resource contention.** Tasks that would collide on a mutable/exclusive resource (same Datadog org + integration, a specific cloud resource, etc.) go in the same group so one reporter owns them or they're serialized. Independent/read-only work can parallelize. Don't be prescriptive about the contention unit — it depends on the project.
3. Write the `## Contentious Resources` section so the user and model align on where testers could step on each other. (This section is for review only — it does **not** go in the spreadsheet; the grouping makes contention self-evident.)
4. Invoke `grill-me` again on the **task split and groupings** — is each task verifiable, is the sizing right, are the contention groups correct?
5. Iterate until the user approves.

## Phase 3 — Generate the sheet

Generate `<project>-bug-bash.xlsx` from `BUG-BASH.md` using `uv` (deps are declared inline via PEP 723, no global install needed):

```bash
uv run <skill-dir>/generate_xlsx.py BUG-BASH.md
```

The script emits one header row per group, a blank row between groups, and an **Additional Issues** section at the bottom for folks to log findings during the bash. Group columns: **Task/Test Case · What to Validate · Reporter · Status · Notes** (Status is a Not Started/Pass/Fail dropdown). Additional Issues columns: **Type · What It Is · Reporter** (Type is a Bug / Suggested Improvement / Nice to Have / Other dropdown). Both dropdowns import as Google Sheets dropdown chips.

Then tell the user to upload the `.xlsx` to Google Drive themselves (Sheets auto-converts on upload) and, if they want colored chips, to set the Pass/Fail chip colors once via Data > Data validation.
