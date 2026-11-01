---
name: plan-project
disable-model-invocation: true
description: Take a project from an RFC/design doc to fully-fleshed Jira tickets under an epic, through four phases — context, scoping, planning, upload. Use when the user says "plan project", "/plan-project", "turn this RFC into tickets", "scope this project", or wants to break a design doc into Jira tickets.
allowed-tools: Read, Write, Bash, Glob, Grep, Skill
---

# Plan Project

Drives a project from research/RFC context to fleshed-out Jira tickets under an epic. Produces three artifacts in the **current working directory**: `CONTEXT.md`, `SCOPE.md`, `TICKETS.md`. Each phase produces a durable artifact, so **planning can resume from any phase** — on invocation, glob for these files and, if any exist, summarize them and ask whether to resume from the furthest-along phase or start fresh.

Load the `acli` skill before any Jira or Confluence call.

## Phase 0 — Inputs (fail fast)

Ask for (or use provided): context path/link, RFC/design doc, target epic key.
- Local files → `Read`. Confluence → `acli`. Figma → Figma MCP.
- Google Docs can't be fetched — ask the user to "Download as Markdown" and provide the file.
- **Fetch the epic via Jira and confirm its summary back** before proceeding; bail if the key doesn't resolve.

`grill-me` is required for phases 1–2. Check `~/.claude/skills/grill-me/SKILL.md` (or agent equivalent); if missing, install: `npx -y skills@latest add https://github.com/mattpocock/skills -g -y -a claude-code -s grill-me`.

## Phase 1 — Context → `CONTEXT.md`

Explore the inputs, then invoke the `grill-me` skill focused on the **concepts and terminology** of the RFC. Goal: a shared vocabulary, since it shapes every ticket.
- Identify key concepts. Suggest a project **name** (from the doc or your judgment) and explicitly ask if it's right or should differ.
- Surface any terms that seem conceptually **confused/conflated**; have the user clarify until the distinctions are clear.
- Write the agreed concepts, definitions, and name to `CONTEXT.md`.

## Phase 2 — Scoping → `SCOPE.md`

Invoke `grill-me` again (with `CONTEXT.md`) to nail down what's **explicitly in vs. out of scope**. Write `SCOPE.md` with:
- In-scope work (group into **milestones** only if it helps; not always needed) and out-of-scope.
- **Hard dependencies** for the work.
- **Observability / success metrics** — telemetry to prove rollout works and measure success.
- **Maintenance** — ownership and operational burden post-rollout; include code ownership only if there are cross-team ownership considerations.
- **Documentation** — docs/runbooks the work obligates, and optionally a blogpost if it warrants an announcement.
- **Rollout** (optional / minimal) — consider feature flags for anything public/customer-facing (UI, APIs, backend behavior); otherwise sequence code/docs changes correctly. Plus staged rollout/rollback where relevant.

Follow the structure in `SCOPE-FORMAT.md` (bundled alongside this skill). `SCOPE.md` is for stakeholder sharing — do not reference local files or `CONTEXT.md` in it. For any Prior Reading entry without a URL, use `[LINK NEEDED]` or ask the user for the link before writing.

After drafting the Ordering/Dependencies section, check for **uneven dependencies within a milestone** — if some tasks are blocked and others aren't, that milestone probably needs splitting so the dependency boundaries are clean. Flag these and propose a split before proceeding.

Then **soft-nudge** sharing with stakeholders/PMs/EMs (it's easier to catch scoping issues before tickets exist): run `pbcopy < SCOPE.md` and tell the user it's already on their clipboard, ready to "Paste from Markdown" into a Google Doc. Don't block — let the user say proceed.

## Phase 3 — Planning → `TICKETS.md`

**North star:** every ticket should be ready to develop on — no open questions, no unclear or ambiguous parts. If a ticket still has unknowns, resolve them with the user (or capture an explicit spike) before considering it done.

**Always name, never just number:** whenever you refer to a ticket or milestone in chat (here and in Phase 2), lead with its short name, not a bare number (e.g. "the auth middleware ticket", "the rollout milestone"). Bare numbers are easy to confuse. **Inside `TICKETS.md`**, every cross-reference to another ticket — prose and `### Dependencies` alike — uses the `[[TN]]` token (e.g. `[[T3]] (auth middleware)`), per `TICKETS-FORMAT.md`. This is what makes the Phase 4 key-substitution a clean find/replace.

1. List the tickets implied by `SCOPE.md`. A task in the scoping doc doesn't map 1:1 to a ticket — carefully consider whether each task should be one ticket or several. The target is roughly a couple days of engineering time and a single conceptual task per ticket. Flag anything that looks too big or too small, and offer to split or consolidate. If a scaffolding ticket (shared types, base components, infra setup) would make downstream tickets more parallelizable, propose one. Iterate until they approve the split.
2. Write the drafts to `TICKETS.md`, each separated by `---`, numbered from `1` (no real keys yet), following the structure in `TICKETS-FORMAT.md` (bundled alongside this skill).
3. For each dependency, confirm it's **hard** (blocking) vs. soft (conceptual) — check the doc/context, ask the user if unclear. Only hard deps go in the `### Dependencies` section. Remove transitive redundancies: if A → B → C and A → C, the A → C link is implied and should be dropped.
4. After writing the initial draft, generate a Mermaid diagram (invoke the `diagram` skill) showing the tickets as a dependency graph -- render with a **white background** (`-b white`). Keep the diagram in sync: any time `TICKETS.md` changes, regenerate it. The diagram makes ticket structure and blocking relationships much easier to review during back-and-forth.
5. Have the user thoroughly review; iterate until they say it's ready to upload. Tickets are always appended with the next incrementing number. The order in `TICKETS.md` is the order they'll be created in Jira, so place new tickets where they logically belong (milestone grouping or dependency order) as you add them.

## Phase 4 — Upload

Before creating anything, run a **self-containment check** — each ticket must make sense without the reader having to open the RFC or scoping doc. Scan for bare references like "see the RFC" or "as described in SCOPE.md" and replace them with the actual context inline. If a genuine external reference is needed (design doc, Confluence page, Google Doc), link directly to the hosted URL — never reference a local file path.

Parsing `TICKETS.md` relies on `mq`. Ensure it's installed first: `command -v mq || brew install mq`. Then:
```bash
mq '.h2' TICKETS.md                                    # ordered list of tickets to create
mq '.p' TICKETS.md | grep -A1 "^Dependencies$"        # all dep values, paired with ticket order
```

- Create every ticket under the **epic from Phase 0**, defaulting to issue type **Task** per the `acli` skill; override per-ticket only if explicitly flagged as a Bug/Story. Everything except dependencies maps into the description; the Summary becomes the Jira title.
- Create the tickets in sequential order, so that the epic order matches `TICKETS.md`.
- **Do not** put dependencies in the description. After all tickets exist, create Jira issue links of type **"Blocks"** (ticket B "is blocked by" A). The `### Dependencies` token list (`[[T2]], [[T4]]`) gives B's blockers directly. Print the full planned link list for confirmation before creating any links.
- Write the **real keys back into `TICKETS.md`**:
  1. Annotate each `## N.` heading with its key — `## 3. [SVLS-1234] Title` — so re-runs don't double-create. This is the lookup table.
  2. For each ticket, find/replace every `[[TN]]` token across the file with `[SVLS-XXXX](https://<domain>/browse/SVLS-XXXX)` (use the Jira domain from the `acli` skill). One replace per ticket; the token's rigid shape makes it safe.
  3. Verify no token survived: `rg '\[\[T\d+\]\]' TICKETS.md` must return nothing. A leftover token means a reference never got linked.
- **Sync resolved bodies back to Jira.** A ticket created before its forward-referenced tickets exist was uploaded with raw `[[TN]]` tokens still in its description. Those are *inline prose* references (Dependencies-section tokens never go in the description — they become Blocks links). For every ticket whose body contained an inline `[[TN]]`, re-push the resolved description with `acli jira workitem edit` so the live Jira body matches `TICKETS.md`, not the unresolved token text.
