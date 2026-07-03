// Project/App: gsd-pi
// File Purpose: Process-level transaction wrapper for milestone merge closeout.

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
