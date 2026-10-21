# Common tasks for this repo. Run `just` to list them.
#
# Branch model: `main` holds everything shared (code, extensions). `personal` is
# `main` plus exactly ONE overlay commit that only touches settings.json and
# models.json. Code changes always land on `main`; `personal` is then rebased onto it.

set positional-arguments

default:
    @just --list

# Branch, ahead/behind, and whether `personal` still follows the one-overlay-commit rule.
status:
    #!/usr/bin/env bash
    set -euo pipefail
    git fetch --quiet origin
    echo "branch: $(git branch --show-current)"
    git status --short --branch | head -1
    echo "main behind origin/main: $(git rev-list --count main..origin/main)"
    if git show-ref --verify --quiet refs/heads/personal; then
      n=$(git rev-list --count main..personal)
      echo "personal: $n commit(s) on top of local main (expected 1), $(git rev-list --count personal..origin/personal) behind origin/personal"
      [[ "$n" == 1 ]] || echo "warning: personal should be main + one overlay commit; squash with: git rebase -i main" >&2
      echo "overlay files: $(git diff --name-only main...personal | tr '\n' ' ')"
    fi

# Commit changes to main from either branch, then rebase personal onto it (no paths = all but the overlay files)
commit message *paths:
    @just _land "$@"

# Fast-forward main to origin/main and rebase personal onto it (local only)
sync:
    @just _land ""

# Push main, and personal (rewritten by every restack, so force-with-lease).
publish:
    #!/usr/bin/env bash
    set -euo pipefail
    git push origin main
    if git show-ref --verify --quiet refs/heads/personal; then
      git push --force-with-lease origin personal
    fi

# Internal: [message [paths...]]. Stashes everything, updates main, optionally commits the
# given files there, restacks personal, returns to the starting branch and restores the rest.
_land *args:
    #!/usr/bin/env bash
    set -euo pipefail
    msg="${1:-}"
    shift || true
    paths=("$@")
    overlay=(settings.json models.json)

    start=$(git branch --show-current)
    if [[ "$start" != main && "$start" != personal ]]; then
      echo "error: run this from main or personal (on '$start')" >&2
      exit 1
    fi
    has_personal=false
    git show-ref --verify --quiet refs/heads/personal && has_personal=true
    git fetch --quiet origin

    files=()
    if [[ -n "$msg" ]]; then
      if ((${#paths[@]})); then
        files=("${paths[@]}")
      else
        mapfile -t files < <({ git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u | grep -vxF -e settings.json -e models.json || true)
      fi
      for f in "${files[@]}"; do
        for o in "${overlay[@]}"; do
          if [[ "$f" == "$o" ]]; then
            echo "error: $o is overlay-owned and never goes to main. Edit it on personal and 'git commit --amend'." >&2
            exit 1
          fi
        done
      done
      if ((${#files[@]} == 0)); then
        echo "nothing to commit (settings.json/models.json are overlay files and are never committed to main)" >&2
        exit 1
      fi
    fi

    # Stash and return the new stash's commit sha (empty if nothing was stashed).
    stash() {
      local before after
      before=$(git rev-parse -q --verify refs/stash || true)
      git stash push --quiet --include-untracked -m "just: $1" "${@:2}" >/dev/null
      after=$(git rev-parse -q --verify refs/stash || true)
      [[ "$after" != "$before" ]] && echo "$after" || true
    }
    pop() {
      local ref
      ref=$(git stash list --format='%H %gd' | awk -v s="$1" '$1 == s { print $2; exit }')
      git stash pop --quiet "$ref"
    }
    trap 'echo "stopped partway (most likely a rebase conflict); nothing is lost. To finish: resolve and run git rebase --continue, then re-run the remaining steps by hand: git checkout '"$start"', and git stash pop for any stash named \"just: rest\" (see git stash list). To bail out: git rebase --abort." >&2' ERR

    files_sha=""
    rest_sha=""
    if [[ -n "$msg" ]]; then
      files_sha=$(stash files -- "${files[@]}")
    fi
    if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
      rest_sha=$(stash rest)
    fi

    git checkout --quiet main
    git rebase --quiet origin/main
    if [[ -n "$files_sha" ]]; then
      pop "$files_sha"
      git add -A -- "${files[@]}"
      git commit --quiet -m "$msg"
      echo "committed to main: $(git log --oneline -1)"
    fi
    if $has_personal; then
      git checkout --quiet personal
      git rebase --quiet main
    fi
    git checkout --quiet "$start"
    if [[ -n "$rest_sha" ]]; then
      pop "$rest_sha"
    fi
    echo "main: $(git log --oneline -1 main)"
    $has_personal && echo "personal: $(git log --oneline -1 personal) ($(git rev-list --count main..personal) on top of main)"
    echo "back on $start. Run 'just publish' to push."

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
    git diff main...personal

# Install extension dependencies.
setup:
    ./setup.sh

# Format, lint, typecheck and test the extensions.
check:
    cd extensions && bun run check
