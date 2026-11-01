# BUG-BASH.md format

The plan artifact reviewed with the user before generating the sheet.

```markdown
# Bug Bash: <Project Name>

## Overview
<1-2 sentences: what shipped and what we're validating. Link the epic.>

## Contentious Resources
<Review-only — omitted from the spreadsheet. Lists resources where testers could collide.>
- **<resource>** — <why it's contentious / who could collide> — used by groups: <X>, <Y>

## Groups

### Group: <name>
<optional one-line note on the shared resource or theme binding this group>

| Task | What to Validate |
|------|------------------|
| <short task name> | <steps + expected result> |
| ... | ... |

### Group: <name>
...

## Additional Issues
Placeholder — filled in during the bash for cases folks find on the fly.
```

## Rules

- **Groups** are the contention boundary: everything in a group can be owned by one reporter or serialized safely. Name each group by its shared resource or feature theme (e.g. "AWS Integration – Sandbox Org", "Metrics Pipeline").
- Each group's table has exactly two columns: `Task` and `What to Validate`. The other sheet columns (Reporter, Status, Notes) are filled during the bash, so leave them out of the markdown.
- `## Contentious Resources` is for alignment during review only. The generated `.xlsx` never includes it — the grouping itself makes contention clear.
- The `## Additional Issues` heading triggers the generator to append a blank fill-in section at the bottom of the sheet. It uses different columns — **Type · What It Is · Reporter** — where Type is a dropdown (Bug / Suggested Improvement / Nice to Have / Other) for folks to log ad-hoc findings during the bash.
