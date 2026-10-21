# Pi configuration

This repository provides a [Pi](https://pi.dev) configuration template. Install it at `~/.pi/agent`, where Pi loads its configuration.

## Requirements

Install Git, Pi, and [Bun](https://bun.com/).

## Install

If `~/.pi/agent` does not exist, clone your fork directly:

```bash
git clone <repository-url> ~/.pi/agent
~/.pi/agent/setup.sh
```

If Pi has already created the directory, move it aside first:

```bash
mv ~/.pi/agent ~/.pi/agent.backup
git clone <repository-url> ~/.pi/agent
~/.pi/agent/setup.sh
```

Copy only the runtime state you want to retain from the backup. Do not commit credentials or session data.

The setup script installs extension dependencies.

## Add tracked files

The `.gitignore` ignores new paths by default to prevent runtime state from being committed accidentally. Add an explicit exception when you create a new tracked top-level file or directory.

## Branches and `just`

`main` holds everything shared. A machine-specific branch (e.g. `personal`) is `main` plus exactly one overlay commit that only touches `settings.json` and `models.json`. Land code changes on `main`; never commit code to the overlay branch.

Run `just` to list recipes. The common ones:

- `just commit "message" [paths...]` -- commit working-tree changes to `main` (from either branch; defaults to every changed file except `settings.json` / `models.json`), then rebase `personal` onto it. Local only.
- `just sync` -- fast-forward `main` to `origin/main` and rebase `personal` onto it. Local only.
- `just publish` -- push `main`, and `personal` with `--force-with-lease` (it is rewritten on every restack).
- `just status`, `just check`, `just overlay`.

Both `commit` and `sync` stash and restore any uncommitted work (including pi's runtime edits to `settings.json`) and return you to the branch you started on.
