// Project/App: gsd-pi
// File Purpose: Process-level transaction wrapper for milestone merge closeout.

import { mergeMilestoneToMain } from "./auto-worktree-merge.js";

export interface MilestoneMergeTransactionResult {
  pushed: boolean;
  codeFilesChanged: boolean;
  commitMessage?: string;
  prCreated?: boolean;
}

export interface MilestoneMergeTransactionInput {
  basePath: string;
  milestoneId: string;
  roadmapContent: string;
}

export type MilestoneMergeTransactionRunner = (
  basePath: string,
  milestoneId: string,
  roadmapContent: string,
) => MilestoneMergeTransactionResult;

export interface MilestoneMergeTransactionDeps {
  mergeMilestone: MilestoneMergeTransactionRunner;
}

export function runMilestoneMergeTransaction(
  deps: MilestoneMergeTransactionDeps,
  input: MilestoneMergeTransactionInput,
): MilestoneMergeTransactionResult {
  return deps.mergeMilestone(
    input.basePath,
    input.milestoneId,
    input.roadmapContent,
  );
}

export function createMilestoneMergeTransaction(
  mergeMilestone: MilestoneMergeTransactionRunner,
): MilestoneMergeTransactionRunner {
  return function mergeMilestoneTransaction(basePath, milestoneId, roadmapContent) {
    return runMilestoneMergeTransaction(
      { mergeMilestone },
      { basePath, milestoneId, roadmapContent },
    );
  };
}

/**
 * Production merge transaction adapter.
 *
 * This is the only production construction point that knows the legacy
 * `auto-worktree.ts` merge primitive. Lifecycle callers depend on the
 * transaction runner interface, not the legacy implementation module.
 */
export function createDefaultMilestoneMergeTransaction(
  mergeMilestone: MilestoneMergeTransactionRunner = mergeMilestoneToMain,
): MilestoneMergeTransactionRunner {
  return createMilestoneMergeTransaction(mergeMilestone);
}
