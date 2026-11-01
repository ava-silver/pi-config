---
name: new-skill
disable-model-invocation: true
description: Create a new Agent skill. Only use when directly invoked.
---

# New Skill

Create either documentation that guides judgment or a workflow that makes repeated work predictable.

Skills live at `~/.pi/agent/skills/<skill-name>/SKILL.md`. Every skill must be relevant (it changes agent behavior in a specific context), non-obvious (not discoverable from normal code exploration) and minimal (readable in under a minute). Write only the skill file; installation, commits, branches, and PRs require an explicit user request.

## Workflow

### 1. Gather requirements

Ask what the skill does, what to call it (kebab-case), and what tools it needs. Settle these choices:

- **Kind.** A documentation skill gives durable guidance and helps the agent make a judgment. A workflow skill makes the agent follow an ordered, repeatable process. Choose a workflow only when step order matters.
- **Invocation.** Model-invoked keeps a `description`, so the agent fires it autonomously and other skills can reach it -- but it sits in context every turn. User-invoked (`disable-model-invocation: true`) costs zero context but only the human can trigger it by name. Pick model-invocation only when the agent must reach the skill on its own.
- **Leading word.** Find the compact concept the agent already holds from pretraining that the skill turns on (for example, *tight* or *tracer bullets*). Repeat it as a token throughout the body, and word the description with it.

Finish when the kind, invocation, leading word, name, purpose, and tools are settled.

### 2. Write the skill file

> **YAML gotcha:** If the description contains `: ` (colon-space), wrap it in single quotes -- otherwise the YAML parser treats it as a mapping key and the skill is silently skipped. Trigger phrase lists like `Triggers: "foo", "bar"` are the common culprit.

Start every skill with:

```markdown
---
name: <skill-name>
description: '<One-line description + trigger phrases so the agent knows when to invoke it.>'
---
```

Format a documentation skill as focused guidance:

```markdown
# <Title>

<What it teaches, in 1-2 sentences.>

## <Topic>

<Rules or guidance grouped by topic.>
```

Format a workflow skill as an ordered process:

```markdown
# <Title>

<What it accomplishes, in 1-2 sentences.>

## Workflow

1. <First action. End with a checkable completion criterion.>
2. <Next action. End with a checkable completion criterion.>
```

Before finishing, prune these failure modes:

- **No-op** -- a line the model already obeys by default. Test each: does it change behavior versus the default? If not, delete it. A weak leading word (*be thorough*) is a no-op; the fix is a stronger word (*relentless*), not more words.
- **Negation** -- steering by prohibition backfires (*don't write verbose comments* makes verbosity available). Prompt the positive target instead (*write one-line comments*); keep a ban only as a hard guardrail, paired with what to do.
- **Duplication** -- the same meaning in two places. Keep one source of truth.
- **Sprawl** -- push on-demand reference into a linked file (progressive disclosure) so `SKILL.md` stays legible.
