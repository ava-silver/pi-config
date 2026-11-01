# <Project Name> — Tickets

> Template for `TICKETS.md`. One ticket per block, separated by `---`, each headed by its
> `[[TN]]` token numbered from `1` (no real keys until upload). Each ticket must be self-contained — no bare references to
> local files, milestone markers (e.g. `M1.1`), or `SCOPE.md`/`CONTEXT.md` sections.
> Inline the relevant context directly; if an external doc (RFC, Confluence, Google Doc)
> is genuinely needed, link to its hosted URL.

## Titling tickets

The h2 heading becomes the Jira summary. Make each one:

- **Outcome over activity** -- name the result, not the effort. "Rate limiting in login endpoint", not "Investigate rate limiting" or "Work on auth".
- **Self-contained** -- legible without the epic or sibling tickets. Spell out the subject; a reader scanning the backlog should know what it touches without opening it.
- **Specific enough to disambiguate** -- the title alone must distinguish it from its siblings. If two tickets could share a title, both are too vague.
- **One PR's worth** -- describe a single unit of work at the granularity of one merge, not a milestone ("Phase 2") or a sub-task ("fix typo in handler").
- **Parallel phrasing across siblings** -- tickets under one epic share grammatical shape so the set reads as a coherent plan.

## Cross-references

Every ticket is identified by the token `[[TN]]` — used in its `##` heading **and** in
every reference to it, in prose and in `### Dependencies`. `N` numbers the tickets from
`1` in order (e.g. `[[T3]]`). This is the only form allowed; never write a bare `Ticket 3`,
`Ticket #3`, `M1.2`, or a plain `## 3.` number. The heading is the lookup table: `## [[T3]]`
defines what every `[[T3]]` reference points at.

- Keep pairing the token with the name (per the skill's naming rule): `[[T3]] (auth middleware)`.
  The token is the substitution target; the `(name)` stays put for readability.
- After upload, replace each heading's token with its real key — `## [SVLS-1234] Title` —
  so re-runs don't double-create, then find/replace every remaining `[[T3]]` →
  `[SVLS-1234](https://<domain>/browse/SVLS-1234)`. One replace per ticket; the token's
  rigid shape makes this safe. `rg '\[\[T\d+\]\]' TICKETS.md` must come back empty afterward.

---

## [[T1]] <Title>

**Summary:** one-liner of the work (becomes the Jira title).

**Context:** why this ticket exists and what problem it solves. Inline the relevant
background directly — do not reference local files or milestone markers. If an external
doc is needed, link to its hosted URL (e.g. Google Doc, Confluence). Self-contained
enough that someone can pick it up cold without reading the RFC.

**Code links:** (optional) GitHub links to relevant packages, files, or specific lines. Omit if not applicable.

**Acceptance criteria:**
- [ ] concrete, checkable outcome
- [ ] ...

**Caveats / notes:** (optional) edge cases, gotchas, non-obvious decisions. Omit if there's nothing genuinely surprising — don't restate dependencies or context already captured above.

### Dependencies
`[[T2]], [[T4]]` (or `none`; blocking only — omit soft/conceptual deps; these become Jira
"Blocks" links at upload, not description text)

---

## [[T2]] <Title>

**Summary:** ...

**Context:** ... (reference other tickets inline with the token, e.g. "extends the schema from [[T1]] (data model)")

**Code links:** ...

**Acceptance criteria:**
- [ ] ...

**Caveats / notes:** ...

### Dependencies
`none`
