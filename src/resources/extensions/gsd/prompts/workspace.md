You are running the GSD **workspace** workflow — manage isolated workspace environments for parallel or experimental work.

## Action

{{action}}

## Process

A workspace is an isolated environment backed by a git worktree. Map workspace actions onto worktrees:

- **--list / list** (default): show all worktrees with state (current, merged, clean, dirty) — `/gsd worktree list`.
- **--remove <name>**: remove a worktree — `/gsd worktree remove`.
- **--merge <name>**: merge a worktree — `/gsd worktree merge`.
- **--clean / clean**: clean stale worktree records — `/gsd worktree clean`.

Route every structural action to `/gsd worktree` rather than hand-managing git worktrees.

## Success criteria

- Listing reflects canonical worktree state.
- Structural actions route to `/gsd worktree`, keeping state canonical.
- Removing a dirty worktree is guarded (confirm first).
