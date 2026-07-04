// gsd-pi — Milestone merge cleanup module.
//
// Owns the teardown ordering after a milestone has safely reached the
// integration branch: clear transient state, remove the worktree, delete the
// milestone branch only after removal succeeds, clear process-local workspace
// state, and anchor cwd back at the project root.

import { nativeBranchDelete } from "./native-git-bridge.js";
import { clearProjectRootStateFiles } from "./auto-worktree-cleanup.js";
import { setActiveWorkspace } from "./auto-worktree-session-registry.js";
import { removeWorktree } from "./worktree-manager.js";
import { nudgeGitBranchCache } from "./worktree.js";
import { debugLog } from "./debug-logger.js";
import { logWarning } from "./workflow-logger.js";

export interface MilestoneMergeCleanupRequest {
  projectRoot: string;
  milestoneId: string;
  milestoneBranch: string;
  previousCwd: string;
  clearProjectRootState?: boolean;
  chdirWarningContext?: string;
}

export interface MilestoneMergeCleanupResult {
  worktreeRemoved: boolean;
  branchDeleteAttempted: boolean;
  activeWorkspaceCleared: boolean;
}

interface MilestoneMergeCleanupDeps {
  clearProjectRootStateFiles: typeof clearProjectRootStateFiles;
  removeWorktree: typeof removeWorktree;
  nativeBranchDelete: typeof nativeBranchDelete;
  setActiveWorkspace: typeof setActiveWorkspace;
  nudgeGitBranchCache: typeof nudgeGitBranchCache;
  chdir: (path: string) => void;
}

const defaultDeps: MilestoneMergeCleanupDeps = {
  clearProjectRootStateFiles,
  removeWorktree,
  nativeBranchDelete,
  setActiveWorkspace,
  nudgeGitBranchCache,
  chdir: process.chdir.bind(process),
};

let deps: MilestoneMergeCleanupDeps = defaultDeps;

export function _setMilestoneCleanupDepsForTests(overrides: Partial<MilestoneMergeCleanupDeps>): void {
  deps = { ...defaultDeps, ...overrides };
}

export function _resetMilestoneCleanupDepsForTests(): void {
  deps = defaultDeps;
}

export function cleanupMergedMilestoneWorktree(
  request: MilestoneMergeCleanupRequest,
): MilestoneMergeCleanupResult {
  const {
    projectRoot,
    milestoneId,
    milestoneBranch,
    previousCwd,
    clearProjectRootState = false,
    chdirWarningContext = "after milestone cleanup",
  } = request;

  if (clearProjectRootState) {
    try {
      deps.clearProjectRootStateFiles(projectRoot, milestoneId);
    } catch (err) {
      logWarning("worktree", `clearProjectRootStateFiles failed during milestone cleanup: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let worktreeRemoved = true;
  try {
    worktreeRemoved = deps.removeWorktree(projectRoot, milestoneId, {
      branch: milestoneBranch,
      deleteBranch: false,
    });
  } catch (err) {
    worktreeRemoved = false;
    logWarning("worktree", `worktree removal failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!worktreeRemoved) {
    logWarning(
      "worktree",
      `Skipping milestone branch deletion for ${milestoneBranch}; worktree removal was aborted to preserve uncommitted milestone work.`,
    );
    deps.nudgeGitBranchCache(previousCwd);
    chdirToProjectRoot(projectRoot, chdirWarningContext);
    return {
      worktreeRemoved: false,
      branchDeleteAttempted: false,
      activeWorkspaceCleared: false,
    };
  }

  try {
    deps.nativeBranchDelete(projectRoot, milestoneBranch);
  } catch (err) {
    logWarning("worktree", `git branch-delete failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  deps.setActiveWorkspace(null);
  deps.nudgeGitBranchCache(previousCwd);
  chdirToProjectRoot(projectRoot, chdirWarningContext);

  return {
    worktreeRemoved: true,
    branchDeleteAttempted: true,
    activeWorkspaceCleared: true,
  };
}

function chdirToProjectRoot(projectRoot: string, context: string): void {
  try {
    deps.chdir(projectRoot);
  } catch (err) {
    logWarning("worktree", `chdir to project root ${context} failed: ${err instanceof Error ? err.message : String(err)}`);
    debugLog("mergeMilestoneToMain", {
      phase: "post-merge-chdir-failed",
      target: projectRoot,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
