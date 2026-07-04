// gsd-pi — Milestone branch/head reconciliation before merge.
//
// Owns the data-loss guard that keeps the named milestone branch aligned with
// the actual worktree HEAD. Detached worktree commits can otherwise sit beyond
// the branch ref and be silently omitted from the integration merge.

import { execFileSync } from "node:child_process";

import { debugLog } from "./debug-logger.js";
import { GSDError, GSD_GIT_ERROR } from "./errors.js";
import {
  nativeIsAncestor,
  nativeUpdateRef,
} from "./native-git-bridge.js";

export type MilestoneBranchHeadReconciliationResult =
  | { checked: false; updated: false; reason: "not-worktree" | "lookup-failed" }
  | { checked: true; updated: false; reason: "already-current" }
  | { checked: true; updated: true; reason: "fast-forwarded" };

export interface MilestoneBranchHeadReconciliationRequest {
  projectRoot: string;
  worktreeCwd: string;
  milestoneBranch: string;
  previousCwd: string;
}

export function reconcileMilestoneBranchHead(
  request: MilestoneBranchHeadReconciliationRequest,
): MilestoneBranchHeadReconciliationResult {
  const { projectRoot, worktreeCwd, milestoneBranch, previousCwd } = request;

  if (worktreeCwd === projectRoot) {
    return { checked: false, updated: false, reason: "not-worktree" };
  }

  try {
    const worktreeHead = gitRevParse(worktreeCwd, "HEAD");
    const branchHead = gitRevParse(projectRoot, milestoneBranch);

    if (!worktreeHead || !branchHead || worktreeHead === branchHead) {
      return { checked: true, updated: false, reason: "already-current" };
    }

    if (nativeIsAncestor(projectRoot, branchHead, worktreeHead)) {
      nativeUpdateRef(
        projectRoot,
        `refs/heads/${milestoneBranch}`,
        worktreeHead,
      );
      debugLog("mergeMilestoneToMain", {
        action: "fast-forward-branch-ref",
        milestoneBranch,
        oldRef: branchHead.slice(0, 8),
        newRef: worktreeHead.slice(0, 8),
      });
      return { checked: true, updated: true, reason: "fast-forwarded" };
    }

    process.chdir(previousCwd);
    throw new GSDError(
      GSD_GIT_ERROR,
      `Worktree HEAD (${worktreeHead.slice(0, 8)}) diverged from ` +
        `${milestoneBranch} (${branchHead.slice(0, 8)}). ` +
        `Manual reconciliation required before merge.`,
    );
  } catch (err) {
    if (err instanceof GSDError) throw err;
    debugLog("mergeMilestoneToMain", {
      action: "reconcile-skipped",
      reason: String(err),
    });
    return { checked: false, updated: false, reason: "lookup-failed" };
  }
}

function gitRevParse(cwd: string, ref: string): string {
  return execFileSync("git", ["rev-parse", ref], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}
