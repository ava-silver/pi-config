# Pi extensions

| Extension               | Description                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `agents-md.ts`          | Loads local and subdirectory `AGENTS.md` instructions into agent context.                |
| `ask-user/`             | Lets the agent ask you a multiple-choice question in the TUI.                            |
| `auto-update.ts`        | Checks for and installs Pi package updates once per day.                                 |
| `background/`           | Runs subagents and shell commands in the background.                                     |
| `caffeinate.ts`         | Keeps the display awake while the agent runs.                                            |
| `command-blocker.ts`    | Blocks configured commands (e.g. `bazel`, `bzl`, unsafe `gh pr merge`) via TS rules.     |
| `web-search/`           | Provides a compact wrapper around configured web search.                                 |
| `continue.ts`           | Adds `Ctrl+N` to send or queue `continue`.                                               |
| `custom-header.ts`      | Renders a custom Pi startup header.                                                      |
| `key-handlers.ts`       | Adds editor shortcuts for undoing deletes, copying prompts, and escalating cancellation. |
| `output-compaction.ts`  | Compacts completed tool output in the TUI.                                               |
| `powerline.ts`          | Replaces the default footer with a Powerline-style status bar.                           |
| `pr-feedback.ts`        | Fetches pull request feedback and asks the agent to assess it.                           |
| `repository-context.ts` | Adds cached GitHub repository and GitHub Actions or GitLab CI metadata to the prompt.    |
| `ui-performance.ts`     | Records event-loop stalls of at least one second to `~/.pi/agent/ui-blocking.jsonl`.     |

| `python-repl/` | Runs stateful Python in a temporary virtual environment. |
| `read-aloud/` | Rewrites and reads the latest response aloud. |
| `session-secret-redaction/` | Redacts detected secrets from Pi session files. |
| `shell.ts` | Runs shell commands with zsh aliases and escalating cancellation. |
| `skill-anywhere.ts` | Enables skill autocomplete and invocation anywhere in a prompt. |
| `slack-mcp/` | Searches Slack, reads channels, threads, and files, and creates message drafts. |
| `spend.ts` | Records session costs and shows spend graphs. |
| `workflows/` | Provides model-authored, multi-agent workflow orchestration. |
| `yeet.ts` | Stages, commits, and pushes repository changes through the git workflow. |

`repository-context.ts` stores metadata in `~/.pi/agent/repository-context.json`. Edit a repository entry to correct its GitHub URL, visibility, or `ci` locations, then run `/reload`.

## Development

```sh
bun install --frozen-lockfile
bun run check
```

Use `bun run format` to apply formatting. Restart Pi or run `/reload` after changing extension code.

Bun manages dependencies and commands. Tests use Node because the workflow sandbox relies on Node's permission model.

## Layout

Keep small extensions as top-level `.ts` files. Use a directory with `index.ts` once an extension needs multiple modules. Colocate unit tests as `*.test.ts`; reserve `test/` for integration tests.

All dependencies belong in the root `package.json` and `bun.lock`. Pi-provided packages remain peer dependencies, with matching pinned development versions used by `setup.sh`. Provision external executables through `Brewfile`, not extension runtime code.
