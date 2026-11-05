---
name: insights
description: 'Retrospective: mine pi session logs for pain points and improvement signals.'
disable-model-invocation: true
---

# Insights

Mine Pi session logs for repeated friction, then compare it with the current setup to find improvements worth making.

To understand one specific past session instead, use `session_read` (and `session_search` to find it). Failed tool calls appear in its default transcript. This skill is for multi-session review.

**Run this as a standalone session, not injected into another task.** Mid-session injection causes the agent to take shortcuts -- inline analysis instead of subagents, no validation, no checkpointing.

## State

Reviewed session IDs live in `~/.pi/agent/skills/insights/reviewed.json`. The extraction script creates this file when missing. Never analyze a reviewed session again (unless `--include-reviewed` is passed explicitly).

The script excludes the active `PI_SESSION_FILE`, follows only each session's active branch, and deduplicates identical transcripts. A validated result checkpoints every duplicate source ID.

## Load current context

Before analysis, inspect:

- `~/.pi/agent/skills/` -- existing skills
- `~/dotfiles/pi/` -- extensions, settings, prompts, and keybindings
- `~/.pi/agent/AGENTS.md` -- standing instructions

This context may postdate the sessions. Treat it as current coverage, not evidence that historical friction never happened.

## Choose a bounded scope

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

## Mine sessions

Group the indexed sessions by `cwd` and spawn one subagent per repo with `subagent_spawn`. Give each its repo's evidence files, read from `index.json`. Synthesize in the parent after all subagents return.

Give each agent its repo's session evidence files and a concise temporary summary of the current setup. Each agent reads every session and identifies only demonstrated friction:

- user corrections or retries
- explicit frustration
- failed tools or subagents (`status: "error"`; `done` is success)
- tasks that end without resolution
- model switches plausibly linked to frustration, excluding initial selection
- manual workarounds that a current skill or configuration should handle

Do not treat ordinary iteration, initial requirements, or words such as "actually" in technical prose as pain. Require exact, short substrings from evidence records.

Each agent returns a JSON array with one entry per session, using this schema:

```json
[
  {
    "session_id": "id from index.json",
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
]
```

`record_id` may reference a **user message**, a **tool error**, or a **subagent result** — all three are citable, and each must come from the session in the same entry. Severity is 1 for minor friction, 2 for material or repeated friction, and 3 for task-derailing failure. Return at most five pain points per session, and include sessions with none.

## Validate and checkpoint

Split each successful agent's array into one JSON file per session, keeping only `pain_points` and `already_addressed_by`. Validate exact evidence before using or checkpointing it:

```bash
python3 ~/.pi/agent/skills/insights/extract_sessions.py validate \
  --session-file /tmp/insights-sessions/<session-id>.json \
  --result-file /tmp/insights-results/<session-id>.json \
  --checkpoint
```

Invalid session results must not be synthesized or checkpointed. Correct them or rerun that repo's agent. If some subagents fail, validate and checkpoint only successful results.

## Synthesize

Use only validated results:

1. Cluster equivalent pain points and count distinct deduplicated sessions.
2. Rank clusters by frequency x severity.
3. Deprioritize friction already covered by today's skills or configuration.
4. Separate repeated workflow problems from repository-specific one-offs and normal clarification.
5. For each top issue, recommend the smallest concrete fix: an existing skill, new skill, `AGENTS.md`, dotfiles tweak, or extension.
6. Report the selected scope and sampling bias. Frequencies describe the sample, not all sessions.

Also report extraction, validation, subagent, or data-quality problems found during the run.
