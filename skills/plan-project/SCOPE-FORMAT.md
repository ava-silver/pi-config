> Template for `SCOPE.md`. Keep sections that apply; drop ones that don't.
> This document is for sharing with stakeholders — do not reference local files or
> internal agent artifacts. For any doc in Prior Reading without a link, use
> `[LINK NEEDED]` as a placeholder (or ask the user for the URL before writing).
>
> **Writing style:** this should read as human-written prose. Avoid random bolding,
> em-dashes, semicolons, and other awkward phrasing of text that read as AI-generated.
> When using lists, keep them well-structured and easy to read.

---

# <Project Name>: Scoping

## TLDR

Leave blank and ask the user to fill this in. 2-3 bullets, one line each.
- ...

## Prior Reading

Links a reader needs before evaluating the scope. Keep this minimal.

- RFC/design doc: [LINK NEEDED]
- Figma designs: [LINK NEEDED]
- _(add or remove entries as needed)_

## Goal

One or two sentences: what this project delivers and why.

## Background

Context a reader needs to evaluate the scope, such as prior work, existing systems/frameworks
being built on, and any in-flight efforts that do or don't block this. Link sources.

**Omit this section** if there's a linked RFC/design doc in Prior Reading — readers can follow
the link for background.

## In Scope

The work being planned into tickets. If it helps, group into **milestones** (only when
grouping clarifies — not every project needs them). Within each, list concrete tasks
and reference the code/areas they touch.

### Milestone 1: <name>
**Scope:** one line on what this milestone covers.
**Tasks:**
1. ...
2. ...

### Milestone 2: <name>
...

## Ordering / Dependencies

What blocks what, and in what order things must land. Centralize all sequencing here rather
than scattering it across milestones. Keep any Mermaid graph at the milestone level -- show how milestones gate each other,
not individual tasks. A graph is recommended when the milestone structure is non-trivial. A
prose or bullet list is fine for simpler cases. Task-level dependencies (e.g. "M2 is gated
on M1.3") belong in the Internal/External bullets below, not the graph.

For a graph: write it to `dependencies.mmd`, render it with
`bunx mmdc -i dependencies.mmd -o dependencies.png -b transparent`,
then embed the PNG here with `![](dependencies.png)`. (Fall back to npx if bunx is not available.)

Only include work that hasn't been done yet or features that haven't been released. Reviews,
coordination, and approvals from other teams are not dependencies.

- **Internal:** dependencies between milestones or tasks within this plan (e.g. "M2 is gated on M1.3").
- **External:** incomplete work or unreleased features owned by other teams or systems, with status if known.

## Out of Scope

Work explicitly excluded that isn't already ruled out by the RFC/design doc — things a reader
might reasonably expect to be in scope. Being explicit here prevents scope creep during planning.

## Observability / Success Metrics

How we'll know the rollout works and whether it succeeded:
- **Telemetry:** metrics, logs, traces, dashboards to add or rely on.
- **Success metrics:** the numbers that define success (adoption, error rate, latency,
  conversion, etc.) and where they're measured.

## Maintenance

Operational burden after rollout:
- **Ownership:** who owns this going forward. Include **code ownership / CODEOWNERS**
  only if there are cross-team ownership considerations.
- **Operational:** alerting, runbooks, on-call impact, recurring upkeep.

## Documentation

What needs writing so others can use/operate this, and who's the audience:
- **Docs:** user-facing docs, internal runbooks, READMEs, API reference — whatever the
  work obligates. Note where they live.
- **Blogpost (optional):** if the work warrants external/internal announcement, scope a
  blogpost as a deliverable (audience, key message, owner).

## Rollout (optional)

Keep minimal or omit if not relevant:
- **Feature flags:** consider a flag for anything public/customer-facing — any change to
  observable behavior (UI, APIs, backend behavior) — so it can be shipped dark, tested,
  and rolled back without a revert. Note the flag(s) and gating.
- Staged rollout / cohorts and rollback plan, where relevant.
