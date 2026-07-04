// gsd-pi — Auto-worktree entry and presence detection module.
//
// Owns the small interface for finding, entering, and identifying milestone
// worktrees. The legacy auto-worktree barrel re-exports these functions for
// compatibility while lifecycle callers can depend on this focused module.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { GSDError, GSD_GIT_ERROR, GSD_IO_ERROR } from "./errors.js";
import { nativeGetCurrentBranch } from "./native-git-bridge.js";
import { worktreePath } from "./worktree-manager.js";
import { worktreePathFor } from "./worktree-placement.js";
import { nudgeGitBranchCache } from "./worktree.js";
import {
  isGsdWorktreePath,
  normalizeWorktreePathForCompare,
  resolveWorktreeProjectRoot,
} from "./worktree-root.js";
import {
  getAutoWorktreeOriginalBase,
  setActiveWorkspace,
} from "./auto-worktree-session-registry.js";
import { createWorkspace } from "./workspace.js";
import { logWarning } from "./workflow-logger.js";

function safeCwd(fallback: string): string {
  try {
    return process.cwd();
  } catch {
    return fallback;
  }
}

/**
 * Detect if the process is currently inside an auto-worktree.
 * Uses the current directory structure plus git branch prefix so detection
 * still works after process restart when module state has been reset.
 */
export function isInAutoWorktree(basePath: string): boolean {
  const targetPath = isGsdWorktreePath(basePath) ? basePath : safeCwd("");
  if (!isGsdWorktreePath(targetPath)) return false;

  const storedBase = getAutoWorktreeOriginalBase();
  const projectRoot = resolveWorktreeProjectRoot(basePath, storedBase);
  const targetProjectRoot = resolveWorktreeProjectRoot(targetPath, storedBase);
  if (
    normalizeWorktreePathForCompare(projectRoot) !==
    normalizeWorktreePathForCompare(targetProjectRoot)
  ) {
    return false;
  }

  try {
    const branch = nativeGetCurrentBranch(targetPath);
    return branch.startsWith("milestone/");
  } catch {
    return false;
  }
}

/**
 * Get the filesystem path for an auto-worktree, or null if it doesn't exist
 * or is not a valid git worktree.
 *
 * Validates that the path is a real git worktree (has a .git file with a
 * gitdir: pointer) rather than just a stray directory. This prevents
 * mis-detection of leftover directories as active worktrees (#695).
 */
export function getAutoWorktreePath(
  basePath: string,
  milestoneId: string,
): string | null {
  basePath = resolveWorktreeProjectRoot(basePath);

  // basePath is already the resolved project root — go straight to placement
  // instead of worktreePath(), which would re-resolve the root.
  const p = worktreePathFor(basePath, milestoneId);
  if (!existsSync(p)) return null;

  // Validate this is a real git worktree, not a stray directory.
  // A git worktree has a .git *file* (not directory) containing "gitdir: <path>".
  const gitPath = join(p, ".git");
  if (!existsSync(gitPath)) return null;
  try {
    const content = readFileSync(gitPath, "utf8").trim();
    if (!content.startsWith("gitdir: ")) return null;
  } catch (e) {
    logWarning("worktree", `getAutoWorktreePath .git read failed: ${(e as Error).message}`);
    return null;
  }

  return p;
}

/**
 * Enter an existing auto-worktree (chdir into it, store originalBase).
 * Use for resume -- the worktree already exists from a prior create.
 *
 * Atomic: chdir + originalBase update in same try block.
 */
export function enterAutoWorktree(
  basePath: string,
  milestoneId: string,
): string {
  basePath = resolveWorktreeProjectRoot(basePath);

  const p = worktreePath(basePath, milestoneId);
  if (!existsSync(p)) {
    throw new GSDError(
      GSD_IO_ERROR,
      `Auto-worktree for ${milestoneId} does not exist at ${p}`,
    );
  }

  // Validate this is a real git worktree, not a stray directory (#695)
  const gitPath = join(p, ".git");
  if (!existsSync(gitPath)) {
    throw new GSDError(
      GSD_GIT_ERROR,
      `Auto-worktree path ${p} exists but is not a git worktree (no .git)`,
    );
  }
  try {
    const content = readFileSync(gitPath, "utf8").trim();
    if (!content.startsWith("gitdir: ")) {
      throw new GSDError(
        GSD_GIT_ERROR,
        `Auto-worktree path ${p} has a .git but it is not a worktree gitdir pointer`,
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("worktree")) throw err;
    throw new GSDError(
      GSD_IO_ERROR,
      `Auto-worktree path ${p} exists but .git is unreadable`,
    );
  }

  const previousCwd = process.cwd();

  try {
    process.chdir(p);
    setActiveWorkspace(createWorkspace(basePath));
  } catch (err) {
    throw new GSDError(
      GSD_IO_ERROR,
      `Failed to enter auto-worktree at ${p}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  nudgeGitBranchCache(previousCwd);
  return p;
}
