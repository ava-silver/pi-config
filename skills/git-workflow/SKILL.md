---
name: git-workflow
description: Ava's git workflow at Datadog. Load BEFORE any git, gt, or gh pr command -- including commits, pushes, branches, PRs, syncing, or worktrees. Detects whether the repository uses Graphite and selects the correct commands.
user_invocable: false
---

# Git Workflow

## Choose the workflow

Run `is-graphite` in the repository before choosing mutation or sync commands.

- `graphite set up` -- use the Graphite commands below.
- `graphite not set up` -- never use `gt`; use normal Git commands. `git cr` and `git ac` already adapt to either workflow. Note that for config repos like `dotfiles` or `skills`, you should just commit to the working branch.

## Branch ownership safety
Before changing commits, tracking, parents, or remotes, run `git branch --show-current` and confirm the branch is the current user's (`$USER/*`) or a repository default branch.

- Never run `gt track`, restack, reparent, push, commit, or otherwise mutate a coworker's branch or stack.
- A non-default branch outside `$USER/*` is not the user's unless the user explicitly says otherwise.
- If work depends on a coworker's branch, stop and ask the user to prepare the branch or worktree. Do not create or attach it yourself.

## Branch naming
Keep an existing branch name only when it passes the ownership check above. When creating your own branch, use `ava.silver/{ticket}/{short-description}` -- e.g. `ava.silver/svls-1234/fix-timeout`.
Chore/no-ticket: `ava.silver/chore/{description}`

## Starting work -- branch + first commit + PR in one shot
```bash
git cr svls-1234 short description here
# → creates branch, stages all, commits [SVLS-1234] short description here, opens PR
# chore: git cr chore short description → commit "chore: short description"
```

**Already on a branch** (e.g. in a worktree with no commits yet): skip `git cr`:
```bash
git ac short description here
# Graphite: gt ss --no-edit -q
# Normal Git: git push
```

## Stacked (child) PRs -- Graphite only
**Always use `git cr` from the parent branch.** Do NOT reach for `gt create` -- it is not part of this workflow.

```bash
# On parent branch ava.silver/svls-1234/parent-work:
git cr svls-1235 child description here
# → creates ava.silver/svls-1235/child-description-here off the current branch,
#    stages all, commits, opens a child PR stacked on the parent
gt ss --no-edit -q   # pushes the full stack
```

`gt create` is not the default. Only use it if `git cr` cannot achieve the desired branch shape, and document why.

Keep every PR in a stack well-scoped and free of extraneous changes. Add each change to the PR where it fits best.

## Adding commits
```bash
git ac short description here   # stages all + commits (does NOT push)
# Graphite: gt ss --no-edit -q   # pushes the full stack and creates/updates its PRs
# Normal Git: git push
```

`git ac` auto-prepends the ticket from the branch name: `[SVLS-1234] short description`.

## Message style
Commit and branch messages describe intent, not the implementation detail. Keep them concise -- usually under seven words.

- Good: `pr feedback`, `fix redirect behavior`, `implement x feature`
- Avoid: `drop unneeded impl entry for connection_string_names passthrough`, `make flat sticky_settings local the source of truth`

## Key rules
- In Graphite repositories, never use `git push` -- use `gt ss --no-edit -q`, and use `gt s` instead of `git pull`.
- In non-Graphite repositories, never use `gt`; use normal Git commands, including `git push` when needed.
- After creating a PR, update the description with `/pr-description`
- Do not add Claude as a co-author to any commit

## Worktrees
Live at `~/dd/{repo-name}.worktrees/{branch-name}/` (slashes → `-`).
```bash
git worktree add ~/dd/{repo}.worktrees/{branch} {branch}
git checkout $(git main)
```
