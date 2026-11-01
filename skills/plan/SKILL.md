---
name: plan
description: 'Create a proportionate implementation plan for a code change. Use ONLY when the user requests a plan for the change.'
---

# Plan

Create a proportionate, self-contained code-change plan. Use dedicated skills instead for Jira-backed, project, bug-bash, and context-handoff planning.

## Guardrail

Planning is an approval boundary. Inspect the repository and write only the plan under its root `.plans/` directory. Never edit implementation files; stop for approval.

## Workflow

1. **Establish evidence.** Read repository instructions, relevant code and tests, tooling, nearby patterns, and existing helpers. Resolve discoverable questions yourself. Ask only when a consequential choice depends on user intent or risk tolerance, and recommend an answer.
2. **Draft.** Create `.plans/` if needed and write a descriptively named Markdown file. Reuse a file only when it clearly covers the same task; otherwise, choose an unused name. Make it usable without chat context:
   - State the goal, non-goals, current behavior, constraints, affected files and symbols, intended behavior, ordered work, and verification.
   - Record rationale only for consequential choices and alternatives likely to be reconsidered. Use pseudocode only when an interface or data shape is itself a decision.
3. **Calibrate proportionately.** Review every consequential choice:
   - **Foundation:** Confirm that the language, framework, data model, and boundaries naturally fit the required behavior, state, control flow, and expected change.
   - **Standards:** Prefer repository constraints and strong local patterns. When precedent is weak, keep touched code idiomatic, clear, and well-typed without unrelated cleanup or tooling changes. Treat craftsmanship as the baseline.
   - **Failure cost:** Choose the least machinery adequate for credible failures. Weigh likelihood, impact, detectability, and recovery against implementation, review, and maintenance cost. Tie extra abstractions, guards, fallbacks, and compatibility paths to a requirement, strong convention, or evidence-backed failure.
   - **Verification:** Start with repository test norms. Make each production step fail at the boundary it owns. Do not add a post-hoc validator that merely rechecks invariants already guaranteed by construction; add separate validation only when it exercises an independent consumer, contract, or credible failure mode. Test durable behavior using the cheapest check that adds independent signal rather than replaying mocks or implementation details. Let visible, cheap, reversible failures justify lighter verification.
4. **Critique when useful.** Always self-review. Use one independent critic only when a meaningful, consequential design choice exists and its likely value exceeds coordination cost. Read `../subagents/SKILL.md`, then give the critic the requirements, repository path, standards, relevant code, and draft. Require it to assess both unjustified machinery and inadequately handled failures, report only evidence-backed findings with the smallest correction, and allow either axis to have none. Verify and adjudicate every finding yourself.
5. **Revise and stop.** Keep only the adjudicated plan, without critique history or boilerplate. Resolve user decisions; for remaining implementation discovery, provide a concrete decision rule.
6. **Report minimally.** Return the plan path, no more than five short bullets containing only key decisions.
