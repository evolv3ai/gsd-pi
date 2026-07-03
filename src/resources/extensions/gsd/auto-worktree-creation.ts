// gsd-pi — Auto-worktree creation module.
//
// Owns the creation path for milestone worktrees: repository readiness,
// branch reuse/start-point selection, initial untracked-content import,
// post-create hook, cwd transition, and session registry update.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { classifyProject } from "./detection.js";
import { GSDError, GSD_GIT_ERROR, GSD_IO_ERROR } from "./errors.js";
import { readIntegrationBranch } from "./git-service.js";
import { nativeBranchExists } from "./native-git-bridge.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import {
  autoWorktreeBranch,
  fastForwardReusedMilestoneBranchIfSafe,
  _resolveAutoWorktreeStartPoint,
} from "./auto-worktree-branch-lifecycle.js";
import { setActiveWorkspace } from "./auto-worktree-session-registry.js";
import { runWorktreePostCreateHook } from "./worktree-post-create-hook.js";
import { createWorktree } from "./worktree-manager.js";
import { nudgeGitBranchCache } from "./worktree.js";
import { resolveWorktreeProjectRoot } from "./worktree-root.js";
import { createWorkspace } from "./workspace.js";
import { debugLog } from "./debug-logger.js";
import { logWarning } from "./workflow-logger.js";

function importUntrackedProjectRootContentIntoEmptyWorktree(
  projectRoot: string,
  worktreeRoot: string,
  milestoneId: string,
): number {
  const worktreeClassification = classifyProject(worktreeRoot);
  if (worktreeClassification.kind !== "greenfield") return 0;

  const projectRootClassification = classifyProject(projectRoot);
  if (
    projectRootClassification.kind === "greenfield" ||
    projectRootClassification.kind === "invalid-repo" ||
    projectRootClassification.untrackedFiles.length === 0
  ) {
    return 0;
  }

  let copied = 0;
  for (const relPath of projectRootClassification.untrackedFiles) {
    const src = join(projectRoot, relPath);
    if (!existsSync(src)) continue;

    const dst = join(worktreeRoot, relPath);
    if (existsSync(dst)) continue;

    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true, force: false });
    copied++;
  }

  if (copied > 0) {
    debugLog("createAutoWorktree", {
      phase: "import-untracked-project-content",
      milestoneId,
      copied,
    });
  }

  return copied;
}

export function createAutoWorktree(
  basePath: string,
  milestoneId: string,
): string {
  basePath = resolveWorktreeProjectRoot(basePath);

  // Check if repo has commits — git worktree requires a valid HEAD.
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: basePath,
      stdio: "pipe",
    });
  } catch {
    throw new GSDError(
      GSD_GIT_ERROR,
      "Cannot create worktree: repository has no commits yet. Worktree isolation requires at least one commit.",
    );
  }

  const branch = autoWorktreeBranch(milestoneId);

  // Check if the milestone branch already exists — it survives auto-mode
  // stop/pause and contains committed work from prior sessions. If it exists,
  // re-attach the worktree to it WITHOUT resetting. Only create a fresh branch
  // from the integration branch when no prior work exists.
  const branchExists = nativeBranchExists(basePath, branch);

  let info: { name: string; path: string; branch: string; exists: boolean };
  if (branchExists) {
    // #5538-followup: fast-forward the reused branch onto the integration
    // branch when safe so the next milestone forks from up-to-date code.
    // Without this, a milestone that was created before another milestone
    // merged into main would carry a stale base into its worktree.
    fastForwardReusedMilestoneBranchIfSafe(basePath, milestoneId, branch);

    // Re-attach worktree to the existing milestone branch (preserving commits).
    info = createWorktree(basePath, milestoneId, {
      branch,
      reuseExistingBranch: true,
    });
  } else {
    // Fresh start — create branch from integration branch.
    // Use the same 3-tier fallback as mergeMilestoneToMain (#3461):
    //   1. META.json integration branch (explicit per-milestone override)
    //   2. git.main_branch preference (user's configured working branch)
    //   3. nativeDetectMainBranch (origin/HEAD auto-detection)
    // Without tier 2, projects with main_branch=dev but origin/HEAD→master
    // would fork worktrees from the wrong (stale) branch.
    const integrationBranch = readIntegrationBranch(basePath, milestoneId)
      ?? undefined;
    const gitPrefs = loadEffectiveGSDPreferences()?.preferences?.git;
    const startPoint = _resolveAutoWorktreeStartPoint(
      integrationBranch,
      gitPrefs?.main_branch,
      (branchName) => nativeBranchExists(basePath, branchName),
    );
    info = createWorktree(basePath, milestoneId, {
      branch,
      startPoint,
    });
  }

  // Phase C: copyPlanningArtifacts and reconcilePlanCheckboxes were
  // deleted. Both addressed the same problem (worktree-local .gsd/
  // projection lagging behind project-root state) by maintaining a stale
  // copy. Now that auto-mode writers in workflow-projections.ts,
  // triage-resolution.ts, rule-registry.ts, and auto-post-unit.ts route
  // through s.canonicalProjectRoot, the worktree never needs a local
  // .gsd/ — both reads and writes converge on the project-root .gsd/.
  // The original concerns (#759, #778) no longer apply because there is
  // no second copy to drift.
  importUntrackedProjectRootContentIntoEmptyWorktree(
    basePath,
    info.path,
    milestoneId,
  );

  // Run user-configured post-create hook (#597) — e.g. copy .env, symlink assets.
  const hookError = runWorktreePostCreateHook(basePath, info.path);
  if (hookError) {
    // Non-fatal — log but don't prevent worktree usage.
    logWarning("reconcile", hookError, { worktree: info.name });
  }

  const previousCwd = process.cwd();

  try {
    process.chdir(info.path);
    setActiveWorkspace(createWorkspace(basePath));
  } catch (err) {
    // If chdir fails, the worktree was created but we couldn't enter it.
    // Don't set activeWorkspace -- caller can retry or clean up.
    throw new GSDError(
      GSD_IO_ERROR,
      `Auto-worktree created at ${info.path} but chdir failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  nudgeGitBranchCache(previousCwd);
  return info.path;
}
