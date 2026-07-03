// gsd-pi — Narrow auto-worktree teardown seam.
//
// Keeps callers that only exit or clean up auto-worktrees off the legacy
// auto-worktree compatibility barrel while extraction continues.

export { teardownAutoWorktree } from "./auto-worktree.js";
