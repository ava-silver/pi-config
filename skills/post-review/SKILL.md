---
name: post-review
disable-model-invocation: true
description: Post a GitHub PR review with inline comments. Use when the user says 'post review', 'submit review', 'post comments on PR', 'leave review', or wants to post code review feedback as a GitHub review with inline comments.
allowed-tools: Bash(gh api:*), Bash(gh pr view:*), Bash(gh pr diff:*), AskUserQuestion
---

# Post Review

## Key Rules

1. **All actionable comments must be inline** -- GitHub's review body doesn't support threaded replies. Body = brief summary only.
2. **Label every review `Automated AI Review`** -- GitHub reviews have no title field, so start the `body` with `## Automated AI Review (human curated)`, followed by the brief summary.
3. **Ask for approval level first** (COMMENT / REQUEST_CHANGES / APPROVE) via AskUserQuestion before posting anything.
4. **Use heredoc piped to `--input -`** -- `--field` silently rejects the comments array.

## Workflow

1. Identify the PR (or `gh pr view --json number,url`).
2. Gather from the conversation: inline comments with file path, line number, body; and a 1-2 sentence summary for the review body.
3. Ask approval level via AskUserQuestion.
4. Get head SHA: `gh api repos/{owner}/{repo}/pulls/{number} --jq '.head.sha'`
5. Post:

```bash
cat <<'PAYLOAD' | gh api repos/{owner}/{repo}/pulls/{number}/reviews -X POST --input -
{
  "commit_id": "<sha>",
  "event": "REQUEST_CHANGES",
  "body": "## Automated AI Review\n\n<short summary only>",
  "comments": [
    { "path": "path/to/file.go", "line": 42, "side": "RIGHT", "body": "..." }
  ]
}
PAYLOAD
```

For multi-line spans add `"start_line"` and `"start_side": "RIGHT"`.

6. Report success and link to the review.
