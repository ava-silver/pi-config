# Common tasks for this repo. Run `just` to list them.
#
# Branch model: `main` holds everything shared (code, extensions). `personal` is
# `main` plus exactly ONE overlay commit that only touches settings.json and
# models.json. Land code changes on `main`, then `just sync` on `personal`.

default:
    @just --list

# Branch, ahead/behind, and whether `personal` still follows the one-overlay-commit rule.
status:
    #!/usr/bin/env bash
    set -euo pipefail
    git fetch --quiet origin
    branch=$(git branch --show-current)
    echo "branch: $branch"
    git status --short --branch | head -1
    echo "behind origin/main: $(git rev-list --count HEAD..origin/main)"
    if [[ "$branch" == personal ]]; then
      n=$(git rev-list --count origin/main..HEAD)
      echo "commits on top of origin/main: $n (expected 1)"
      [[ "$n" == 1 ]] || echo "warning: personal should be origin/main + one overlay commit; squash with: git rebase -i origin/main" >&2
      echo "files in overlay: $(git diff --name-only origin/main...HEAD | tr '\n' ' ')"
    fi

# Fetch and rebase the current branch onto the latest origin/main (autostashes pi's runtime edits).
sync:
    #!/usr/bin/env bash
    set -euo pipefail
    branch=$(git branch --show-current)
    git fetch origin
    git rebase --autostash origin/main
    if [[ "$branch" == personal ]]; then
      n=$(git rev-list --count origin/main..HEAD)
      [[ "$n" == 1 ]] || echo "warning: personal has $n commits on top of main (expected 1); see 'just status'" >&2
    fi
    echo "synced $branch with origin/main. Run 'just publish' to push."

# Push the current branch. personal is rewritten on every sync, so it needs a force (with lease).
publish:
    #!/usr/bin/env bash
    set -euo pipefail
    if [[ "$(git branch --show-current)" == personal ]]; then
      git push --force-with-lease origin personal
    else
      git push origin "$(git branch --show-current)"
    fi

# Discard local state and match the remote branch, e.g. after another machine force-pushed personal.
reset-to-remote:
    #!/usr/bin/env bash
    set -euo pipefail
    branch=$(git branch --show-current)
    git fetch origin
    git status --short
    read -r -p "Discard local changes and reset $branch to origin/$branch? [y/N] " answer
    [[ "$answer" == y ]] && git reset --hard "origin/$branch"

# Show what `personal` overrides relative to main.
overlay:
    git diff origin/main...personal

# Install extension dependencies.
setup:
    ./setup.sh

# Format, lint, typecheck and test the extensions.
check:
    cd extensions && bun run check
