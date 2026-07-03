// gsd-pi — Narrow auto-worktree branch lifecycle seam.
//
// Keeps branch lifecycle callers off the legacy auto-worktree compatibility
// barrel while extraction continues.

export {
  autoWorktreeBranch,
  enterBranchModeForMilestone,
  fastForwardReusedMilestoneBranchIfSafe,
  _isBranchCheckedOutElsewhere,
  _resolveAutoWorktreeStartPoint,
} from "./auto-worktree.js";
