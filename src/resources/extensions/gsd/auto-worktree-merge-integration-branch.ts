// gsd-pi — Milestone merge integration-branch preparation.
//
// Owns branch-selection safety before the merge transaction touches the project
// root: resolve integration branch, fail closed on self-merge metadata, clear
// transient milestone state, reject detached HEAD, and checkout when needed.

import { GSDError, GSD_GIT_ERROR } from "./errors.js";
import {
  resolveMilestoneIntegrationBranch,
} from "./git-service.js";
import {
  nativeCheckoutBranch,
  nativeDetectMainBranch,
  nativeGetCurrentBranch,
} from "./native-git-bridge.js";
import { clearProjectRootStateFiles } from "./auto-worktree-cleanup.js";

export interface PrepareIntegrationBranchRequest {
  milestoneBranch: string;
  milestoneId: string;
  prefs: Parameters<typeof resolveMilestoneIntegrationBranch>[2];
  previousCwd: string;
  projectRoot: string;
}

export interface PreparedIntegrationBranch {
  mainBranch: string;
}

interface MergeIntegrationBranchDeps {
  chdir: typeof process.chdir;
  clearProjectRootStateFiles: typeof clearProjectRootStateFiles;
  nativeCheckoutBranch: typeof nativeCheckoutBranch;
  nativeDetectMainBranch: typeof nativeDetectMainBranch;
  nativeGetCurrentBranch: typeof nativeGetCurrentBranch;
  resolveMilestoneIntegrationBranch: typeof resolveMilestoneIntegrationBranch;
}

const defaultDeps: MergeIntegrationBranchDeps = {
  chdir: process.chdir.bind(process),
  clearProjectRootStateFiles,
  nativeCheckoutBranch,
  nativeDetectMainBranch,
  nativeGetCurrentBranch,
  resolveMilestoneIntegrationBranch,
};

let deps: MergeIntegrationBranchDeps = defaultDeps;

export function _setMergeIntegrationBranchDepsForTests(
  overrides: Partial<MergeIntegrationBranchDeps>,
): void {
  deps = { ...defaultDeps, ...overrides };
}

export function _resetMergeIntegrationBranchDepsForTests(): void {
  deps = defaultDeps;
}

function normalizeLocalBranchRef(branch: string): string {
  return branch.startsWith("refs/heads/")
    ? branch.slice("refs/heads/".length)
    : branch;
}

export function prepareIntegrationBranchForMilestoneMerge(
  request: PrepareIntegrationBranchRequest,
): PreparedIntegrationBranch {
  const { milestoneBranch, milestoneId, prefs, previousCwd, projectRoot } = request;
  const branchResolution = deps.resolveMilestoneIntegrationBranch(projectRoot, milestoneId, prefs);
  const mainBranch = branchResolution.effectiveBranch ?? deps.nativeDetectMainBranch(projectRoot);

  if (normalizeLocalBranchRef(mainBranch) === milestoneBranch) {
    deps.chdir(previousCwd);
    throw new GSDError(
      GSD_GIT_ERROR,
      `Resolved integration branch "${mainBranch}" is the same ref as milestone branch ` +
      `"${milestoneBranch}" — refusing to self-merge. ${branchResolution.reason}. ` +
      `Repair milestone integration metadata before retrying milestone completion.`,
    );
  }

  deps.clearProjectRootStateFiles(projectRoot, milestoneId);

  const currentBranchAtBase = deps.nativeGetCurrentBranch(projectRoot);
  if (!currentBranchAtBase || currentBranchAtBase.length === 0) {
    deps.chdir(previousCwd);
    throw new GSDError(
      GSD_GIT_ERROR,
      `Project root is in detached HEAD state — cannot perform milestone merge. ` +
      `Checkout an integration branch (e.g. \`git checkout ${mainBranch}\`) before resuming.`,
    );
  }
  if (currentBranchAtBase !== mainBranch) {
    deps.nativeCheckoutBranch(projectRoot, mainBranch);
  }

  return { mainBranch };
}
