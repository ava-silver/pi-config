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

The setup script installs extension dependencies and creates `settings.json` from the example.

## Add tracked files

The `.gitignore` ignores new paths by default to prevent runtime state from being committed accidentally. Add an explicit exception when you create a new tracked top-level file or directory.

## Settings

`settings.json` is gitignored because Pi rewrites it at runtime. `setup.sh` copies `settings.example.json` to `settings.json` if it is missing. To keep your own settings under version control, symlink `settings.json` to a file in another repository before you run `setup.sh`.

To format, lint, typecheck and test the extensions, run `bun run verify` in `extensions/`.
