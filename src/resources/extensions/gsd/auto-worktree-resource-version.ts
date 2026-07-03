// gsd-pi — Narrow auto-worktree resource version seam.
//
// Keeps resource freshness callers off the legacy auto-worktree compatibility
// barrel while extraction continues.

export {
  checkResourcesStale,
  readResourceVersion,
} from "./auto-worktree.js";
