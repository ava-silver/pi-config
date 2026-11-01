---
name: insights
description: 'Retrospective: mine pi session logs for pain points and improvement signals.'
disable-model-invocation: true
---

# Insights

Mine Pi session logs for repeated friction, then compare it with the current setup to find improvements worth making.

This skill has two modes. Choose one before doing anything else.

---

## Mode A — Focused analysis (one specific session)

Use this when the user names a specific session, asks what went wrong in a past session, or wants to incorporate lessons from a previous session into current work.

**Read the session directly — no extraction pipeline, no checkpointing:**

```bash
# By session ID:
python3 ~/.pi/agent/skills/insights/extract_sessions.py read \
  --session <session-id> > /tmp/insights-session.json

# Or by file path:
python3 ~/.pi/agent/skills/insights/extract_sessions.py read \
  --file /path/to/session.jsonl > /tmp/insights-session.json
```

Then analyze the JSON inline. The session file contains `records` — each has a `record_id`, `type`, `role`, and `text`. Look for:

- Tool errors (`type: "tool_error"`)
- Failed subagents (`type: "subagent_result"`, `status: "error"`)
- User corrections or retries
- Tasks that never resolved

Report what happened and what would prevent it. Do **not** checkpoint — this mode is read-only.

---

## Mode B — Retrospective (multi-session review)

**Run this as a standalone session, not injected into another task.** Mid-session injection causes the agent to take shortcuts — inline analysis instead of subagents, no validation, no checkpointing.

### State

Reviewed session IDs live in `~/.pi/agent/skills/insights/reviewed.json`. The extraction script creates this file when missing. Never analyze a reviewed session again (unless `--include-reviewed` is passed explicitly).

The script excludes the active `PI_SESSION_FILE`, follows only each session's active branch, and deduplicates identical transcripts. A validated result checkpoints every duplicate source ID.

### Load current context

Before analysis, inspect:

- `~/.pi/agent/skills/` -- existing skills
- `~/dotfiles/pi/` -- extensions, settings, prompts, and keybindings
- `~/.pi/agent/AGENTS.md` -- standing instructions

This context may postdate the sessions. Treat it as current coverage, not evidence that historical friction never happened.

### Choose a bounded scope

List unreviewed session metadata without putting transcripts in the tool output:

```bash
python3 ~/.pi/agent/skills/insights/extract_sessions.py list > /tmp/insights-candidates.json
```

Use `jq` to summarize candidates by `cwd`, date, message count, model changes, and failures. If the user did not specify a scope, ask them to choose repositories or a similarly coherent slice.

Extract at most 30 sessions. `--cwd` and `--session` are repeatable; multiple CWD filters form a union, and CWD/session filters compose as an intersection. Pass `--include-reviewed` to re-analyze already-checkpointed sessions.

```bash
rm -rf /tmp/insights-sessions
python3 ~/.pi/agent/skills/insights/extract_sessions.py extract \
  --cwd datadog-ci \
  --cwd serverless-ci \
  --limit 30 \
  --output-dir /tmp/insights-sessions
```

To extract specific sessions by file path (bypassing discovery):

```bash
python3 ~/.pi/agent/skills/insights/extract_sessions.py extract \
  --file /path/to/session.jsonl \
  --file /path/to/another.jsonl \
  --output-dir /tmp/insights-sessions
```

The command writes one full evidence file per session plus `index.json`. Do not analyze more batches unless the user asks to continue.

### Mine sessions

Use one `workflow` agent per indexed session. Keep the fan-out at 30 or fewer agent calls so the workflow stays below its 32-call budget. Pass the parsed index as workflow arguments rather than spending an agent call loading it. Synthesize in the parent after the workflow returns.

Give each agent its session evidence file and a concise temporary summary of the current setup. Each agent identifies only demonstrated friction:

- user corrections or retries
- explicit frustration
- failed tools or subagents (`status: "error"`; `done` is success)
- tasks that end without resolution
- model switches plausibly linked to frustration, excluding initial selection
- manual workarounds that a current skill or configuration should handle

Do not treat ordinary iteration, initial requirements, or words such as "actually" in technical prose as pain. Require exact, short substrings from evidence records.

Use this schema:

```json
{
  "pain_points": [
    {
      "record_id": "entry-id",
      "quote": "exact substring from that record",
      "category": "...",
      "severity": 1
    }
  ],
  "already_addressed_by": "existing skill/config, or none"
}
```

`record_id` may reference a **user message**, a **tool error**, or a **subagent result** — all three are citable. Severity is 1 for minor friction, 2 for material or repeated friction, and 3 for task-derailing failure. Return at most five pain points per session.

### Validate and checkpoint

Write each successful agent's structured result to its own JSON file. Validate exact evidence before using or checkpointing it:

```bash
python3 ~/.pi/agent/skills/insights/extract_sessions.py validate \
  --session-file /tmp/insights-sessions/<session-id>.json \
  --result-file /tmp/insights-results/<session-id>.json \
  --checkpoint
```

Invalid results must not be synthesized or checkpointed. Correct or rerun them. If the workflow partially fails, validate and checkpoint only successful results.

### Synthesize

Use only validated results:

1. Cluster equivalent pain points and count distinct deduplicated sessions.
2. Rank clusters by frequency x severity.
3. Deprioritize friction already covered by today's skills or configuration.
4. Separate repeated workflow problems from repository-specific one-offs and normal clarification.
5. For each top issue, recommend the smallest concrete fix: an existing skill, new skill, `AGENTS.md`, dotfiles tweak, or extension.
6. Report the selected scope and sampling bias. Frequencies describe the sample, not all sessions.

Also report extraction, validation, workflow, or data-quality problems found during the run.
