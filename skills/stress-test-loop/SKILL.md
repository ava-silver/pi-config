---
name: stress-test-loop
disable-model-invocation: true
description: 'Run a persistent stress-testing conversation in which a subagent exercises a target and challenges each fix until both agents agree no actionable issues remain.'
---

# Stress-test loop

Pair the parent with one persistent partner. The parent edits the target; the partner independently exercises it and critiques each change.

## Workflow

1. Define the target, workspace, exercise method, constraints, success criteria, and coverage dimensions. When an analogous implementation or prior summary exists, compare ownership detection, managed names and mount paths, cleanup gates, provider defaults and idempotency, error rendering, cold-start guidance, and artifact compatibility.
2. Read `../subagents/SKILL.md`, then spawn one subagent where it can exercise the target. Keep it for the full loop; `subagent_message` can reactivate it after settlement with its transcript intact.
3. Before mutating external resources, agree on a unique namespace, ownership marker, baseline capture, and cleanup plan. Use unique names and labels, and never mutate the parent's fixture without coordination.
4. Ask the partner to maintain a coverage matrix and a stable finding ledger (`F1`, `F2`, ...). Classify each finding as an actionable code defect, product decision, external release blocker, or coverage gap or untested risk.
5. For lifecycle or preview fixes, retest each applicable path: fresh apply, exact no-op retry, changed configuration, disable or manual transition, uninstrument and repeated uninstrument, single-target failure, and multi-target failure when batching exists. Use real-environment changed-candidate tests when possible; a no-op preview alone is insufficient.
6. Each feedback round contains up to three currently known independent findings. Each finding includes severity, command or scenario, observed result, expected customer behavior, evidence file when available, proposed correction, and requested resolution. Dependent findings can follow later.
7. Verify every claim. Resolve each ledger item as fixed, rejected with evidence, accepted risk, or awaiting product input, then send the updated textual ledger through `subagent_message`. Record an owner and exit condition for accepted blockers.
8. Send milestones only when they affect coordination, such as resource creation, deployment or telemetry waits, and cleanup. Proactively message new context or corrections; this can also continue a settled partner.
9. Ask the user only for unavailable product intent or an irreducible tradeoff, relay the decision, and continue. Finish when no actionable defects remain; acknowledged product decisions, external blockers, and untested risks do not prevent settlement.
10. After consensus, use `subagent_wait` to collect the partner's settled final report before responding to the user. Report changes, ledger disposition, coverage, cleanup status, and remaining blockers or risks.

## Subagent prompt

```text
Act as the persistent stress-testing partner for [target] in [workspace]. Exercise it using [methods]; inspect relevant source and tests; and explore plausible edge cases. Do not edit source or spawn subagents.

Before external tests, coordinate unique resource names, an ownership marker, a baseline, and a cleanup plan. Maintain a coverage matrix and stable finding ledger. For lifecycle or preview fixes, retest each applicable path: fresh apply, exact no-op retry, changed configuration, disable or manual transition, uninstrument and repeated uninstrument, single-target failure, and batched multi-target failure. When an analogous implementation or prior summary exists, compare ownership, managed names and mount paths, cleanup, provider defaults and idempotency, errors, cold-start guidance, and artifacts.

Send all currently known findings in one concise round, up to three independent issues, then call ask_parent and wait. For each finding, provide its ID, classification, severity, exact command or scenario, observed result, expected customer behavior, evidence file when available, proposed correction, and requested resolution. Send a short milestone only when it changes coordination.

After each parent message, independently reassess the resolution and continue testing. Treat unsolicited messages as context or steering, including after settlement. Do not concede based on role, confidence, or repetition. Finish when no actionable defects remain, even if acknowledged product decisions, external blockers, or untested risks remain. Report the final ledger, coverage, cleanup status, and each blocker's owner and exit condition.
```
