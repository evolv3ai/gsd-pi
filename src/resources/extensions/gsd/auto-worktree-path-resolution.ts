// gsd-pi — Auto-worktree path resolution seam.
//
// Keeps callers that only resolve existing auto-worktree paths on the focused
// entry/path module instead of the legacy auto-worktree compatibility barrel.

export { getAutoWorktreePath } from "./auto-worktree-entry.js";
