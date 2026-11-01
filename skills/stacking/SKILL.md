---
name: stacking
description: 'Size cohesive PRs when planning, splitting, or reviewing a change or PR stack. Triggers: "split this into PRs", "plan a stack", "size this PR", "stacking".'
---

# Stacking

Turn a change into small, cohesive PRs that each represent one independently reviewable concept.

## Workflow

1. State each proposed PR as one plain-English conceptual change. If its title is vague or needs “and,” adjust its boundary until the concept is cohesive.
2. Keep interdependent changes together. A reviewer must be able to judge the PR without understanding another PR; dependencies may provide code, but not missing rationale or half of the concept.
3. Split distinct concepts into separate PRs, even when they touch the same area. Each resulting PR must remain cohesive and independently explainable.
4. Prefer the smallest boundary that passes both checks: independently reviewable and one cohesive conceptual change. Do not split merely to reduce line count.
5. For a stack, list each PR's title, conceptual purpose, and dependency. The stack is ready when every title is specific and every boundary passes the two checks.
