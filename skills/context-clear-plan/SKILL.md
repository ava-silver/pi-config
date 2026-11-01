---
name: context-clear-plan
disable-model-invocation: true
description: 'Write a plan that captures everything needed to continue the session after a context clear -- code being worked on, learned principles/takeaways, and next steps. Use when the user says "context clear plan", "/context-clear-plan", "plan for a fresh context", "checkpoint the session", or wants to clear context without re-explaining.'
---

# Context Clear Plan

Produce a plan dense enough that clearing the context window loses nothing: a fresh agent can read the plan and pick up exactly where this session left off, with no re-explanation from the user.

## Key Rules

1. **Confirm plan mode first.** If you are not in plan mode, STOP. Tell the user to put you in plan mode and wait -- do not write the plan, do not edit anything.
2. **Capture, don't re-derive.** The point is to preserve session context that a fresh agent could NOT recover by reading code or git history.
3. Keep it self-contained -- assume the reader has zero memory of this conversation.

## What the plan must include

- **Code in flight** -- files, functions, branches being worked on, and what state they're in (done / partial / untouched).
- **Principles & takeaways** -- decisions made, constraints, dead ends already ruled out, and anything the user corrected or clarified. This is what spares the user from repeating themselves.
- **Next steps** -- ordered, concrete actions remaining, plus any other items queued for the session.
- **Open questions** -- anything unresolved or awaiting a user decision.

End by presenting the plan via ExitPlanMode so the user can approve continuing from it.
