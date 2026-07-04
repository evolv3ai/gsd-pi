// gsd-pi — Narrow auto-worktree path utility seam.
//
// Keeps path comparison, pathspec, and expected-warning callers off the legacy
// auto-worktree compatibility barrel while extraction continues.

export {
  _gitPathspecForWorktreePath,
  _isExpectedWorktreeUnlinkError,
  _isSamePath,
} from "./auto-worktree-cleanup.js";
