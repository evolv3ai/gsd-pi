<!-- Project/App: gsd-pi -->
<!-- File Purpose: ADR for the Worktree Placement module and the canonical .gsd-worktrees/ location. -->

# ADR-031: Worktree Placement — Canonical `.gsd-worktrees/` Sibling and One Placement Seam

**Status:** Accepted
**Date:** 2026-06-09
**Author:** GSD architecture review
**Related:** ADR-002 (external state directory — closure note amended by this ADR), ADR-015 (Worktree Safety module), ADR-016 trio (worktree lifecycle/projection split, fail-closed safety), ADR-017 (drift-driven reconciliation)

## Context

### The shipped reality ADR-002 does not record

ADR-002 closed "Not Adopted" with the statement *"No external state directory exists or is planned."* That statement is contradicted by the shipped code: `repo-identity.ts` computes a per-repo identity hash, resolves an external `~/.gsd/projects/<hash>/` state directory, and manages the `<project>/.gsd → external` symlink; `migrate-external.ts` migrates in-tree `.gsd/` directories into that layout. The external state directory exists, ships, and is in active use.

### The consequence: worktrees materialize in the home directory

Worktrees were placed at `<projectRoot>/.gsd/worktrees/<MID>`. When `.gsd` is the external-state symlink, that logical path crosses the symlink and the worktree **physically materializes** at `~/.gsd/projects/<hash>/worktrees/<MID>`. After `process.chdir`, the realpath the agent — and the user — sees is an opaque hash path in the home directory. User-facing symptoms: work appears to happen "in a `~/.gsd/XXXX` folder", IDEs and file pickers can't find the working copy, and relative tooling breaks.

### The architectural cost

Because the placement decision leaked, every consumer had to reverse-engineer project identity from a path string. At the time of this ADR the codebase carried **six** independent implementations of "is this path a GSD worktree / where is its project root": `worktree-root.ts` (authoritative, 3 marker regexes + env fallbacks + a HOME-detection guard), `paths.ts` (`isInsideGsdWorktree`), `auto-worktree.ts` (`escapeStaleWorktree` string-slice), `commands/catalog.ts` (verbatim copies of `findWorktreeSegment` and `resolveProjectRootFromGitFile`), `doctor-environment.ts`, and `tools/exec-tool.ts` (`parseWorktreeBase`) — plus marker regexes in `bg-shell/utilities.ts`, `auto-start.ts`, `captures.ts`, and `worktree-session-state.ts`. Several of these did not recognize the external-state layout at all.

## Decision

### 1. Canonical placement: `<projectRoot>/.gsd-worktrees/<name>`

New worktrees are created under a **real directory sibling** of `.gsd`, never under it. `repo-identity.ts` symlinks only `.gsd`, so the canonical container never crosses the symlink: the working copy stays at the project root regardless of where `.gsd` state lives. This kills the `~/.gsd/<hash>/worktrees/<MID>` symptom at the source.

`.gsd-worktrees/` is **not** covered by a blanket `.gsd` gitignore entry. It gets its own entry in `BASELINE_PATTERNS` and `GSD_RUNTIME_PATTERNS` (gitignore.ts — canonical source of truth), `RUNTIME_EXCLUSION_PATHS` (git-service.ts), the worktree-diff `SKIP_PATHS` (worktree-manager.ts), and the doctor's critical-pattern check (which requires it independently of the blanket check).

### 2. Legacy placement stays recognized — resolution prefers existing worktrees

In-flight milestones must survive upgrades. The legacy container (`<projectRoot>/.gsd/worktrees/`, possibly resolving through the symlink to `~/.gsd/projects/<hash>/worktrees/`) remains a recognized layout:

- **Creation** always uses the canonical container (including re-creation after a stale legacy directory is cleaned up).
- **Resolution** (`worktreePathFor`) returns an existing worktree's actual location — canonical first, then legacy — and falls back to canonical for new ones.
- **Containment and safety checks** (`isInsideWorktreesDir`, the write-gate, Worktree Safety's expected-root validation) accept membership in either container.
- **Scans** (listing, reentry, doctor orphan checks, parallel worker discovery) enumerate both containers.

### 3. One placement seam: the Worktree Placement module

`worktree-placement.ts` owns the forward direction (project root + name → physical path): `CANONICAL_WORKTREES_DIRNAME`, `canonicalWorktreesDir`, `legacyWorktreesDir`, `worktreesDirs`, `worktreePathFor`. `worktree-manager.ts` re-exports basePath-resolving wrappers (`worktreesDir`, `allWorktreesDirs`, `worktreePath`).

The reverse direction (path → project identity) stays in `worktree-root.ts`: `findWorktreeSegment` is the **only** marker-matching implementation, now recognizing three layouts — canonical (`/.gsd-worktrees/`), legacy direct (`/.gsd/worktrees/`), and external-state (`~/.gsd/projects/<hash>/worktrees/`). `projectRootFromWorktreePath` is the thin path→root-prefix helper over it; the duplicate detectors listed in Context (`escapeStaleWorktree`, `parseWorktreeBase`, `doctor-environment`, `captures`, `worktree-session-state`) were deleted and routed through it.

Two consumers cannot import the seam and keep deliberate, comment-pinned copies that must be hand-synchronized when a layout changes: `bg-shell/utilities.ts` mirrors the reverse marker regexes (bg-shell does not import the gsd extension), and `packages/mcp-server`'s `worktreeContainers` mirrors the forward container pair (the MCP server cannot statically import the extension tree).

### 4. Decision-record reconciliation

ADR-002's closure note is amended to record that the external state directory **was** subsequently shipped (repo-identity symlink layout) and that worktree placement no longer depends on it. ADR-016 (fail-closed) is amended: the canonical Unit root for source-writing Units is `<projectRoot>/.gsd-worktrees/<milestone>`, with the legacy path accepted for pre-existing worktrees.

## Environment contracts

Documented here because they were previously undocumented load-bearing behavior:

- **`GSD_PROJECT_ROOT`** — worker-process override for project-root resolution. `resolveWorktreeProjectRoot` honors it only when the base path is a recognized worktree path; shell-completion honors it unconditionally.
- **`GSD_STATE_DIR`** — overrides `~/.gsd` as the parent of the external-state `projects/` directory during layout detection.

## Consequences

- New milestone worktrees appear at `<projectRoot>/.gsd-worktrees/<MID>` — visible, findable, project-local.
- Existing legacy worktrees keep working: resolution, safety validation, merge, teardown, and doctor repair all accept both containers. No migration step is required; legacy worktrees age out as milestones complete.
- A new layout (if ever needed) is taught in two seam files — `worktree-placement.ts` (forward) and `findWorktreeSegment` (reverse) — plus the two comment-pinned boundary copies that cannot import the seam: `bg-shell/utilities.ts` (reverse) and `packages/mcp-server`'s `worktreeContainers` (forward).
- The HOME-detection guard in `worktree-root.ts` and the stale-worktree escape heuristic remain for legacy paths; they are dead weight for canonical paths and can be retired with the legacy layout.
- `.gitignore` in existing projects gains the `.gsd-worktrees/` entry via the idempotent `ensureGitignore` bootstrap; the doctor flags it when missing.
