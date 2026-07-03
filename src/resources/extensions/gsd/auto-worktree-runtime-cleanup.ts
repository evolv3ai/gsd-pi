// gsd-pi — Narrow auto-worktree runtime cleanup seam.
//
// Keeps runtime cleanup callers off the legacy auto-worktree compatibility
// barrel while extraction continues.

export {
  cleanStaleRuntimeUnits,
  escapeStaleWorktree,
} from "./auto-worktree.js";
