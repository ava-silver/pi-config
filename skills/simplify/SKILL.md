---
name: simplify
description: Simplify code and comments without changing behavior. Use after implementing code, during code review, or when writing or reviewing comments.
---
Simplify changes in the current branch or the scope the user specifies. For comment-only tasks, simplify only those comments rather than reviewing the whole branch.

## Workflow

1. Identify the requested scope and inspect its diff.
2. Simplify names, comments, state, and structure using the rules below.
3. Review the resulting diff and confirm externally visible behavior is unchanged, including public APIs, serialized data, and CLI flags.
4. Run the relevant existing checks and report their results.

## Word choice in code and comments

Variable names, function names, and comments are all prose. Apply Orwell's rules: use short words, cut needless words, prefer active voice, and replace jargon with everyday English.

Keep the codebase's established vocabulary. Where words are equally precise, simplify toward short, concrete, everyday English: `prune`, `run`, `watch`, `stop`, `drop`, `walk`.

### Names

1. **One word per concept, one concept per word.** Keep a vocabulary. If `sync` names "pulling remote changes," it cannot also name "flushing edits to disk;" rename one of them.
2. **Cut words the context already carries.** A module named `workspaceWatcher` does not need `startNativeWorkspaceWatcher`; `watchWorkspace` says the same thing.
3. **A compound name is usually a hedge.** Prefer a readable description such as `baseline` over a specification such as `lastObservedDiskContent`.

### Comments

State, in plain English, the constraint the code cannot show: why the **non-obvious** exists.

- ✅ If a function has non-obvious constraints or side effects, explain them in a doc comment.
- 🗑️ If a comment narrates change history from the conversation, delete it.
- 🗑️ If a comment restates code whose behavior is self-evident, delete it.

## Code structure

1. **Inverted pyramid.** Within a file, lead with the exported or significant functions and push helpers below them. Don't bury the lead.
2. **Combine overlapping concepts.** If two types, functions, or constants overlap significantly, merge them. The fewer distinct concepts a reader must hold in their head, the better.
3. **Use shared code.** Common utilities (ex. file path parsing) may exist in the codebase already. Check for library or utility functions before inlining.
4. **Derivability.** If a value can be computed from values already in scope, don't pass or store it separately. Removing derivable state often simplifies signatures, types, and control flow in one move. Example: an `isDirty` parameter that is always `editorContent !== baseline` can be dropped.

## Overfitting

Code must stand on its own. If a change only makes sense to someone who watched it happen (this conversation, this PR), it is overfitted. Write for the reader who arrives with no history.

- If a name or comment needs the conversation to be understood, rewrite it against the codebase's own vocabulary.
- **No backwards compatibility with unshipped code.** Supporting an old signature, alias, or data shape that only existed earlier in the same branch is compatibility with something that was never deployed. Delete the old path and update its callers.
