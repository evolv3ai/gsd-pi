// Project/App: gsd-pi
// File Purpose: Auto-mode worktree lifecycle, merge, and cleanup management.

/**
 * GSD Auto-Worktree -- lifecycle management for auto-mode worktrees.
 *
 * Auto-mode creates worktrees with `milestone/<MID>` branches (distinct from
 * manual `/worktree` which uses `worktree/<name>` branches). This module
 * manages create, enter, detect, and teardown for auto-mode worktrees.
 */

import {
  existsSync,
  cpSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { GSDError, GSD_GIT_ERROR } from "./errors.js";
import {
  reconcileWorktreeDb,
  isDbAvailable,
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
} from "./gsd-db.js";
import {
  closeWorkflowDatabase,
  getWorkflowDatabasePath,
  openWorkflowDatabasePath,
} from "./db-workspace.js";
import { atomicWriteSync } from "./atomic-write.js";
import { execFileSync } from "node:child_process";
import {
  canonicalPhaseDirName,
  gsdRoot,
  milestonesDir,
  resolveGsdPathContract,
  resolveMilestonePath,
} from "./paths.js";
import {
  removeWorktree,
  resolveGitDir,
} from "./worktree-manager.js";
import {
  detectWorktreeName,
  resolveGitHeadPath,
  nudgeGitBranchCache,
} from "./worktree.js";
import {
  projectRootFromWorktreePath,
  normalizeWorktreePathForCompare,
} from "./worktree-root.js";
import { autoResolveSafeConflictPaths } from "./git-conflict-resolve.js";
import { MergeConflictError, resolveMilestoneIntegrationBranch, RUNTIME_EXCLUSION_PATHS } from "./git-service.js";
import { publishMilestone } from "./publication.js";
import { debugLog } from "./debug-logger.js";
import { logWarning, logError } from "./workflow-logger.js";
import {
  autoWorktreeBranch,
} from "./auto-worktree-branch-lifecycle.js";
import {
  cleanupConflictState,
  gsdJsonlFilesWithConflictMarkers,
  hasConflictMarkers,
  popStashByRef,
  removeMergeStateFiles,
  stashAlreadyExistsFilesFromError,
  stashRefFromError,
} from "./worktree-git-recovery.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { MILESTONE_ID_RE } from "./milestone-ids.js";
import {
  nativeGetCurrentBranch,
  nativeDetectMainBranch,
  nativeWorkingTreeStatus,
  nativeAddAllWithExclusions,
  nativeCommit,
  nativeCheckoutBranch,
  nativeMergeSquash,
  nativeMergeRegular,
  nativeConflictFiles,
  nativeCheckoutTheirs,
  nativeAddPaths,
  nativeRmForce,
  nativeBranchDelete,
  nativeDiffNumstat,
  nativeUpdateRef,
  nativeIsAncestor,
  nativeLsFiles,
} from "./native-git-bridge.js";
import {
  CLOSEOUT_CONSISTENCY_BLOCKED_REASON,
} from "./closeout-consistency-gate.js";
import {
  formatCloseoutProofBlock,
  proveMilestoneCloseout,
} from "./milestone-closeout-proof.js";
import { gsdHome } from "./gsd-home.js";
import { createAutoWorktree } from "./auto-worktree-creation.js";
import {
  enterAutoWorktree,
  getAutoWorktreePath,
  isInAutoWorktree,
} from "./auto-worktree-entry.js";
import {
  getActiveWorkspace,
  setActiveWorkspace,
} from "./auto-worktree-session-registry.js";
import {
  _shouldReconcileWorktreeDb,
  clearProjectRootStateFiles,
} from "./auto-worktree-cleanup.js";

export {
  getActiveAutoWorktreeContext,
  getAutoWorktreeOriginalBase,
  _resetAutoWorktreeOriginalBaseForTests,
} from "./auto-worktree-session-registry.js";

export { createAutoWorktree } from "./auto-worktree-creation.js";
export { teardownAutoWorktree } from "./auto-worktree-teardown.js";

export {
  syncGsdStateToWorktree,
  syncGsdStateToWorktreeByScope,
  syncProjectRootToWorktree,
  syncStateToProjectRoot,
  syncWorktreeStateBack,
} from "./auto-worktree-sync.js";

export {
  enterAutoWorktree,
  getAutoWorktreePath,
  isInAutoWorktree,
} from "./auto-worktree-entry.js";

export {
  autoWorktreeBranch,
  enterBranchModeForMilestone,
  fastForwardReusedMilestoneBranchIfSafe,
  _isBranchCheckedOutElsewhere,
  _resolveAutoWorktreeStartPoint,
} from "./auto-worktree-branch-lifecycle.js";

const LEGACY_DEEP_SETUP_RUNTIME_UNIT_FILES = new Set([
  "workflow-preferences-WORKFLOW-PREFS.json",
  "discuss-project-PROJECT.json",
  "discuss-requirements-REQUIREMENTS.json",
  "research-decision-RESEARCH-DECISION.json",
  "research-project-RESEARCH-PROJECT.json",
]);

export {
  _gitPathspecForWorktreePath,
  _isExpectedWorktreeUnlinkError,
  _isSamePath,
  _shouldReconcileWorktreeDb,
} from "./auto-worktree-cleanup.js";


function stripGsdDisplayPrefix(value: string | undefined | null, id: string): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  const idLower = id.toLowerCase();
  if (lower.startsWith(`${idLower}:`)) return raw.slice(id.length + 1).trim() || undefined;
  return raw;
}

// ─── Module State ──────────────────────────────────────────────────────────

/**
 * Optional override for the shelter restore copy step (milestone merge #2505).
 * Production leaves this null so restoreShelter uses the real cpSync; tests
 * inject a throwing function to deterministically exercise the best-effort
 * failure path (auto-worktree.ts:1809) and the shelter-retention guarantee,
 * which is otherwise unreachable because shelter and restore run synchronously
 * in one mergeMilestoneToMain call (the filesystem cannot change between them).
 * @internal
 */
let _restoreEntryFn: ((src: string, dest: string) => void) | null = null;

function findRegularMergeChangedPaths(basePath: string, milestoneBranch: string, mainBranch: string): Set<string> {
  const changedPaths = new Set<string>();
  let mergeLog = "";
  try {
    mergeLog = execFileSync("git", ["rev-list", "--merges", "--parents", mainBranch], {
      cwd: basePath,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
  } catch (err) {
    logWarning("worktree", `regular merge lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    return changedPaths;
  }

  for (const line of mergeLog.split("\n").filter(Boolean)) {
    const [mergeCommit, firstParent, ...otherParents] = line.split(" ");
    if (!mergeCommit || !firstParent || otherParents.length === 0) continue;
    const mergedMilestone = otherParents.some((parent) => {
      try {
        return nativeIsAncestor(basePath, milestoneBranch, parent);
      } catch {
        return false;
      }
    });
    if (!mergedMilestone) continue;

    try {
      const output = execFileSync("git", ["diff", "--name-only", firstParent, mergeCommit], {
        cwd: basePath,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      }).trim();
      for (const path of output.split("\n").filter(Boolean)) {
        if (!path.startsWith(".gsd/")) changedPaths.add(path);
      }
    } catch (err) {
      logWarning("worktree", `regular merge diff lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return changedPaths;
  }

  return changedPaths;
}

// ─── Build Artifact Auto-Resolve ─────────────────────────────────────────────

export {
  isSafeToAutoResolve,
  SAFE_AUTO_RESOLVE_PATTERNS,
} from "./auto-worktree-conflict-auto-resolve.js";

// ─── Resource Staleness ───────────────────────────────────────────────────

/**
 * Read the resource version (semver) from the managed-resources manifest.
 * Uses gsdVersion instead of syncedAt so that launching a second session
 * doesn't falsely trigger staleness (#804).
 */
export function readResourceVersion(): string | null {
  const agentDir =
    process.env.GSD_CODING_AGENT_DIR || join(gsdHome(), "agent");
  const manifestPath = join(agentDir, "managed-resources.json");
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    return typeof manifest?.gsdVersion === "string"
      ? manifest.gsdVersion
      : null;
  } catch (e) {
    logWarning("worktree", `readResourceVersion failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Check if managed resources have been updated since session start.
 * Returns a warning message if stale, null otherwise.
 */
export function checkResourcesStale(
  versionOnStart: string | null,
): string | null {
  if (versionOnStart === null) return null;
  const current = readResourceVersion();
  if (current === null) return null;
  if (current !== versionOnStart) {
    return "GSD resources were updated since this session started. Restart gsd to load the new code.";
  }
  return null;
}

// ─── Stale Worktree Escape ────────────────────────────────────────────────

/**
 * Detect and escape a stale worktree cwd (#608).
 *
 * After milestone completion + merge, the worktree directory is removed but
 * the process cwd may still point inside `.gsd/worktrees/<MID>/`.
 * When a new session starts, `process.cwd()` is passed as `base` to startAuto
 * and all subsequent writes land in the wrong directory. This function detects
 * that scenario and chdir back to the project root.
 *
 * Returns the corrected base path.
 */
export function escapeStaleWorktree(base: string): string {
  const projectRoot = projectRootFromWorktreePath(base);
  if (projectRoot === null) return base;

  // Guard: If the candidate project root's .gsd IS the user-level ~/.gsd,
  // the string-slice heuristic matched the wrong /.gsd/ boundary. This happens
  // when .gsd is a symlink into ~/.gsd/projects/<hash> and process.cwd()
  // resolved through the symlink. Returning ~ would be catastrophic (#1676).
  const candidateGsd = normalizeWorktreePathForCompare(join(projectRoot, ".gsd"));
  const gsdHomeNorm = normalizeWorktreePathForCompare(gsdHome());
  if (candidateGsd === gsdHomeNorm || candidateGsd.startsWith(gsdHomeNorm + "/")) {
    // Don't chdir to home — return base unchanged.
    // resolveProjectRoot() in worktree.ts has the full git-file-based recovery
    // and will be called by the caller (startAuto → projectRoot()).
    return base;
  }

  try {
    process.chdir(projectRoot);
  } catch (e) {
    // If chdir fails, return the original — caller will handle errors downstream
    logWarning("worktree", `escapeStaleWorktree chdir failed: ${(e as Error).message}`);
    return base;
  }
  return projectRoot;
}

/**
 * Clean stale runtime unit files for completed milestones.
 *
 * After restart, stale runtime/units/*.json from prior milestones can
 * cause deriveState to resume the wrong milestone (#887). Removes files
 * for milestones that have a SUMMARY (fully complete).
 */
export function cleanStaleRuntimeUnits(
  gsdRootPath: string,
  hasMilestoneSummary: (mid: string) => boolean,
): number {
  const runtimeUnitsDir = join(gsdRootPath, "runtime", "units");
  if (!existsSync(runtimeUnitsDir)) return 0;

  let cleaned = 0;
  try {
    for (const file of readdirSync(runtimeUnitsDir)) {
      if (!file.endsWith(".json")) continue;
      if (LEGACY_DEEP_SETUP_RUNTIME_UNIT_FILES.has(file)) {
        try {
          unlinkSync(join(runtimeUnitsDir, file));
          cleaned++;
        } catch (err) {
          /* non-fatal */
          logWarning("worktree", `stale runtime unit unlink failed (${file}): ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }
      const staleDiscussMatch = file.match(/^discuss-milestone-(.+)\.json$/);
      if (staleDiscussMatch && !MILESTONE_ID_RE.test(staleDiscussMatch[1])) {
        try {
          unlinkSync(join(runtimeUnitsDir, file));
          cleaned++;
        } catch (err) {
          /* non-fatal */
          logWarning("worktree", `stale runtime unit unlink failed (${file}): ${err instanceof Error ? err.message : String(err)}`);
        }
        continue;
      }
      const midMatch = file.match(/(M\d+(?:-[a-z0-9]{6})?)/);
      if (!midMatch) continue;
      if (hasMilestoneSummary(midMatch[1])) {
        try {
          unlinkSync(join(runtimeUnitsDir, file));
          cleaned++;
        } catch (err) {
          /* non-fatal */
          logWarning("worktree", `stale runtime unit unlink failed (${file}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    /* non-fatal */
    logWarning("worktree", `stale runtime unit cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return cleaned;
}

export { runWorktreePostCreateHook } from "./worktree-post-create-hook.js";

function normalizeLocalBranchRef(branch: string): string {
  return branch.startsWith("refs/heads/")
    ? branch.slice("refs/heads/".length)
    : branch;
}

/**
 * Inject an override for the shelter restore copy step, returning a function
 * that restores the default (real cpSync) behavior. Used by tests to
 * deterministically exercise the best-effort restore-failure path
 * (auto-worktree.ts:1809) and the #2505 shelter-retention guarantee — which is
 * otherwise unreachable because shelter + restore run synchronously in one
 * mergeMilestoneToMain call. No production caller.
 * @internal
 */
export function _setRestoreEntryFnForTests(
  fn: ((src: string, dest: string) => void) | null,
): () => void {
  _restoreEntryFn = fn;
  return () => { _restoreEntryFn = null; };
}

// ─── Merge Milestone -> Main ───────────────────────────────────────────────

/**
 * Auto-commit any dirty (uncommitted) state in the given directory.
 * Returns true if a commit was made, false if working tree was clean.
 */
function autoCommitDirtyState(cwd: string): boolean {
  try {
    const status = nativeWorkingTreeStatus(cwd);
    if (!status) return false;
    nativeAddAllWithExclusions(cwd, RUNTIME_EXCLUSION_PATHS);
    const result = nativeCommit(
      cwd,
      "chore: auto-commit before milestone merge",
    );
    return result !== null;
  } catch (e) {
    debugLog("autoCommitDirtyState", { error: String(e) });
    throw new GSDError(
      GSD_GIT_ERROR,
      `Failed to auto-commit dirty worktree state before milestone merge: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Squash-merge the milestone branch into main with a rich commit message
 * listing all completed slices, then tear down the worktree.
 *
 * Sequence:
 *  1. Auto-commit dirty worktree state
 *  2. chdir to originalBasePath
 *  3. git checkout main
 *  4. git merge --squash milestone/<MID>
 *  5. git commit with rich message
 *  6. Auto-push if enabled
 *  7. Delete milestone branch
 *  8. Remove worktree directory
 *  9. Clear originalBase
 *
 * On merge conflict: throws MergeConflictError.
 * On "nothing to commit" after squash: safe only if milestone work is already
 * on the integration branch.  Throws if unanchored code changes would be lost.
 *
 * @internal **Do not call directly.** This is the inner squash-merge primitive
 * for the Worktree Lifecycle Module (ADR-016 phase 2 / A3, issue #5619).
 * Production callers must go through `WorktreeLifecycle.mergeMilestoneStandalone`
 * or `WorktreeLifecycle.exitMilestone({ merge: true })`. The export keyword
 * is preserved for legacy tests and the default transaction adapter; production
 * wiring depends on `createDefaultMilestoneMergeTransaction()` instead.
 */
export function mergeMilestoneToMain(
  originalBasePath_: string,
  milestoneId: string,
  roadmapContent: string,
): { commitMessage: string; pushed: boolean; prCreated: boolean; codeFilesChanged: boolean } {
  const worktreeCwd = process.cwd();
  const milestoneBranch = autoWorktreeBranch(milestoneId);

  // 1. Auto-commit dirty state before leaving.
  //    Guard: when we entered through an auto-worktree (originalBase is set),
  //    only auto-commit when cwd is on the milestone branch. In parallel mode,
  //    cwd may be on the integration branch after a prior merge's
  //    MergeConflictError left cwd unrestored. Auto-committing on the
  //    integration branch captures dirty files from OTHER milestones under a
  //    misleading commit message, contaminating the main branch (#2929).
  //
  //    When activeWorkspace is null (branch mode, no worktree), autoCommitDirtyState
  //    runs unconditionally — the caller is responsible for cwd placement.
  {
    let shouldAutoCommit = true;
    if (getActiveWorkspace() !== null) {
      try {
        const currentBranch = nativeGetCurrentBranch(worktreeCwd);
        shouldAutoCommit = currentBranch === milestoneBranch;
      } catch {
        // If we can't determine the branch, skip the auto-commit to be safe
        shouldAutoCommit = false;
      }
    }
    if (shouldAutoCommit) {
      autoCommitDirtyState(worktreeCwd);
    }
  }

  // Reconcile worktree DB into main DB before leaving worktree context.
  // Skip when both paths resolve to the same physical file (shared WAL /
  // symlink layout) — ATTACHing a WAL-mode file to itself corrupts the
  // database (#2823).
  if (isDbAvailable()) {
    const contract = resolveGsdPathContract(worktreeCwd, originalBasePath_);
    const worktreeDbPath = join(contract.worktreeGsd ?? join(worktreeCwd, ".gsd"), "gsd.db");
    const mainDbPath = contract.projectDb;
    try {
      const activeDbPath = getWorkflowDatabasePath();
      if (activeDbPath && _shouldReconcileWorktreeDb(activeDbPath, mainDbPath)) {
        closeWorkflowDatabase();
        if (!openWorkflowDatabasePath(mainDbPath)) {
          throw new Error(`cannot open project DB at ${mainDbPath}`);
        }
      }
      if (_shouldReconcileWorktreeDb(worktreeDbPath, mainDbPath)) {
        reconcileWorktreeDb(mainDbPath, worktreeDbPath);
      }
    } catch (err) {
      const message = `DB reconciliation failed before milestone ${milestoneId} merge: ${err instanceof Error ? err.message : String(err)}`;
      logError("worktree", message);
      throw new GSDError(GSD_GIT_ERROR, `${message}. Recovery reason: ${CLOSEOUT_CONSISTENCY_BLOCKED_REASON}.`);
    }

    const closeoutProof = proveMilestoneCloseout(milestoneId);
    if (!closeoutProof.ok) {
      throw new GSDError(GSD_GIT_ERROR, formatCloseoutProofBlock(closeoutProof));
    }
  }

  // 2. Get completed slices for commit message
  let completedSlices: { id: string; title: string; tasks: Array<{ id: string; title: string }> }[] = [];
  if (isDbAvailable()) {
    completedSlices = getMilestoneSlices(milestoneId)
      .filter(s => s.status === "complete")
      .map(s => ({
        id: s.id,
        title: stripGsdDisplayPrefix(s.title, s.id) ?? s.id,
        tasks: getSliceTasks(milestoneId, s.id)
          .filter((task) => task.status === "complete")
          .map((task) => ({
            id: task.id,
            title: stripGsdDisplayPrefix(task.title, task.id) ?? task.id,
          })),
      }));
  }
  // Fallback: parse roadmap content when DB is unavailable
  if (completedSlices.length === 0 && roadmapContent) {
    const sliceRe = /- \[x\] \*\*(\w+):\s*(.+?)\*\*/gi;
    let m: RegExpExecArray | null;
    while ((m = sliceRe.exec(roadmapContent)) !== null) {
      completedSlices.push({ id: m[1], title: m[2], tasks: [] });
    }
  }

  // 3. chdir to original base
  // Note: previousCwd captures the cwd at this point — i.e. the worktree cwd
  // entering the function. Subsequent throws restore to previousCwd, leaving
  // the caller in worktree-cwd; callers (worktree-resolver) are responsible
  // for any further cwd movement on the error path.
  const previousCwd = process.cwd();
  process.chdir(originalBasePath_);

  // 4. Resolve integration branch via shared resolver so stale/invalid
  //    milestone metadata can recover to configured/detected fallbacks.
  const prefs = loadEffectiveGSDPreferences()?.preferences?.git ?? {};
  const branchResolution = resolveMilestoneIntegrationBranch(originalBasePath_, milestoneId, prefs);
  const mainBranch = branchResolution.effectiveBranch ?? nativeDetectMainBranch(originalBasePath_);

  // Fail closed when the resolved integration branch is the milestone branch
  // itself (#5024). Stale or corrupt metadata (e.g. integrationBranch recorded
  // as "milestone/<MID>") would otherwise let the squash merge resolve to a
  // self-merge: nothing-to-commit + empty self-diff in the post-merge safety
  // check (#1792) collapse to a false success, and the worktree-resolver
  // emits worktree-merged for work that never landed on a distinct
  // integration branch.
  if (normalizeLocalBranchRef(mainBranch) === milestoneBranch) {
    process.chdir(previousCwd);
    throw new GSDError(
      GSD_GIT_ERROR,
      `Resolved integration branch "${mainBranch}" is the same ref as milestone branch ` +
      `"${milestoneBranch}" — refusing to self-merge. ${branchResolution.reason}. ` +
      `Repair milestone integration metadata before retrying milestone completion.`,
    );
  }

  // Remove transient project-root state files before any branch or merge
  // operation. Untracked milestone metadata can otherwise block squash merges.
  clearProjectRootStateFiles(originalBasePath_, milestoneId);

  // 5. Checkout integration branch (skip if already current — avoids git error
  //    when main is already checked out in the project-root worktree, #757)
  //
  // Refuse to proceed if the project root is in detached HEAD state. Silently
  // running `nativeCheckoutBranch(mainBranch)` on a detached HEAD would
  // abandon the user's deliberately-checked-out commit (mid-bisect, reviewing
  // a tag, CI checkout-sha) without warning. (Issue #4980 HIGH-10)
  const currentBranchAtBase = nativeGetCurrentBranch(originalBasePath_);
  if (!currentBranchAtBase || currentBranchAtBase.length === 0) {
    process.chdir(previousCwd);
    throw new GSDError(
      GSD_GIT_ERROR,
      `Project root is in detached HEAD state — cannot perform milestone merge. ` +
      `Checkout an integration branch (e.g. \`git checkout ${mainBranch}\`) before resuming.`,
    );
  }
  if (currentBranchAtBase !== mainBranch) {
    nativeCheckoutBranch(originalBasePath_, mainBranch);
  }

  // 6. Build rich commit message
  const dbMilestone = getMilestone(milestoneId);
  let milestoneTitle = stripGsdDisplayPrefix(dbMilestone?.title, milestoneId) ?? "";
  // Fallback: parse title from roadmap content header (e.g. "# M020: Backend foundation")
  if (!milestoneTitle && roadmapContent) {
    const titleMatch = roadmapContent.match(new RegExp(`^#\\s+${milestoneId}:\\s*(.+)`, "m"));
    if (titleMatch) milestoneTitle = titleMatch[1].trim();
  }
  milestoneTitle = milestoneTitle || milestoneId;
  const subject = `feat: ${milestoneTitle}`;
  const milestoneContext = milestoneTitle === milestoneId
    ? `Milestone: ${milestoneId}`
    : `Milestone: ${milestoneId} - ${milestoneTitle}`;
  let body = "";
  if (completedSlices.length > 0) {
    const sliceLines = completedSlices
      .map((s) => `- ${s.id}: ${s.title}`)
      .join("\n");
    const taskLines = completedSlices
      .flatMap((s) => s.tasks.map((task) => `- ${s.id}/${task.id}: ${task.title}`))
      .join("\n");
    const taskBlock = taskLines ? `\n\nCompleted tasks:\n${taskLines}` : "";
    body = `\n\nCompleted slices:\n${sliceLines}${taskBlock}\n\n${milestoneContext}\nGSD-Milestone: ${milestoneId}\nBranch: ${milestoneBranch}`;
  } else {
    body = `\n\n${milestoneContext}\nGSD-Milestone: ${milestoneId}\nBranch: ${milestoneBranch}`;
  }
  const commitMessage = subject + body;

  // 6b. Reconcile worktree HEAD with milestone branch ref (#1846).
  //     When the worktree HEAD detaches and advances past the named branch,
  //     the branch ref becomes stale. Squash-merging the stale ref silently
  //     orphans all commits between the branch ref and the actual worktree HEAD.
  //     Fix: fast-forward the branch ref to the worktree HEAD before merging.
  //     Only applies when merging from an actual worktree (worktreeCwd differs
  //     from originalBasePath_).
  if (worktreeCwd !== originalBasePath_) {
    try {
      const worktreeHead = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: worktreeCwd,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      }).trim();
      const branchHead = execFileSync("git", ["rev-parse", milestoneBranch], {
        cwd: originalBasePath_,
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      }).trim();

      if (worktreeHead && branchHead && worktreeHead !== branchHead) {
        if (nativeIsAncestor(originalBasePath_, branchHead, worktreeHead)) {
          // Worktree HEAD is strictly ahead — fast-forward the branch ref
          nativeUpdateRef(
            originalBasePath_,
            `refs/heads/${milestoneBranch}`,
            worktreeHead,
          );
          debugLog("mergeMilestoneToMain", {
            action: "fast-forward-branch-ref",
            milestoneBranch,
            oldRef: branchHead.slice(0, 8),
            newRef: worktreeHead.slice(0, 8),
          });
        } else {
          // Diverged — fail loudly rather than silently losing commits
          process.chdir(previousCwd);
          throw new GSDError(
            GSD_GIT_ERROR,
            `Worktree HEAD (${worktreeHead.slice(0, 8)}) diverged from ` +
              `${milestoneBranch} (${branchHead.slice(0, 8)}). ` +
              `Manual reconciliation required before merge.`,
          );
        }
      }
    } catch (err) {
      // Re-throw GSDError (divergence); swallow rev-parse failures
      // (e.g. worktree dir already removed by external cleanup)
      if (err instanceof GSDError) throw err;
      debugLog("mergeMilestoneToMain", {
        action: "reconcile-skipped",
        reason: String(err),
      });
    }
  }

  // Already regular-merged milestones can skip the squash path and proceed to cleanup (#5831).
  if (nativeIsAncestor(originalBasePath_, milestoneBranch, mainBranch)) {
    const codeChanges = nativeDiffNumstat(
      originalBasePath_,
      mainBranch,
      milestoneBranch,
    ).filter((entry) => !entry.path.startsWith(".gsd/"));
    if (codeChanges.length > 0) {
      const regularMergeChangedPaths = findRegularMergeChangedPaths(
        originalBasePath_,
        milestoneBranch,
        mainBranch,
      );
      const unanchoredCodeChanges = codeChanges.filter((entry) =>
        regularMergeChangedPaths.has(entry.path)
      );
      if (unanchoredCodeChanges.length > 0) {
        process.chdir(previousCwd);
        throw new GSDError(
          GSD_GIT_ERROR,
          `Milestone branch "${milestoneBranch}" is reachable from "${mainBranch}" ` +
            `but has ${unanchoredCodeChanges.length} milestone-touched code file(s) not on current "${mainBranch}". ` +
            `Aborting worktree teardown to prevent data loss.`,
        );
      }
    }
    debugLog("mergeMilestoneToMain", {
      action: "skip-squash-already-merged",
      milestoneId,
      milestoneBranch,
      mainBranch,
    });
    try {
      clearProjectRootStateFiles(originalBasePath_, milestoneId);
    } catch (err) {
      logWarning("worktree", `clearProjectRootStateFiles failed during already-merged cleanup: ${err instanceof Error ? err.message : String(err)}`);
    }
    let worktreeRemoved = true;
    try {
      worktreeRemoved = removeWorktree(originalBasePath_, milestoneId, {
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
      nudgeGitBranchCache(previousCwd);
      try {
        process.chdir(originalBasePath_);
      } catch (err) {
        logWarning("worktree", `chdir to project root after already-merged cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { commitMessage, pushed: false, prCreated: false, codeFilesChanged: true };
    }

    try {
      nativeBranchDelete(originalBasePath_, milestoneBranch);
    } catch (err) {
      logWarning("worktree", `git branch-delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setActiveWorkspace(null);
    nudgeGitBranchCache(previousCwd);
    try {
      process.chdir(originalBasePath_);
    } catch (err) {
      logWarning("worktree", `chdir to project root after already-merged cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { commitMessage, pushed: false, prCreated: false, codeFilesChanged: true };
  }

  // 7. Shelter queued milestone directories before the squash merge (#2505).
  // The milestone branch may contain copies of queued milestone dirs (via
  // copyPlanningArtifacts), so `git merge --squash` rejects when those same
  // files exist as untracked in the working tree. Temporarily move them to
  // a backup location, then restore after the merge+commit.
  //
  // MUST run BEFORE the pre-merge stash (step 7a) so `--include-untracked`
  // does not sweep queued CONTEXT files into the stash. If stash pop later
  // fails, files trapped inside the stash are permanently lost (#2505).
  const planningDir = milestonesDir(originalBasePath_);
  const shelterDir = join(gsdRoot(originalBasePath_), ".milestone-shelter");
  const shelteredDirs: string[] = [];
  let shelterRestored = false;
  const mergeDirNames = new Set<string>([milestoneId]);
  const resolvedMergeDir = resolveMilestonePath(originalBasePath_, milestoneId);
  if (resolvedMergeDir) {
    mergeDirNames.add(basename(resolvedMergeDir));
  } else {
    mergeDirNames.add(
      canonicalPhaseDirName(milestoneId, getMilestone(milestoneId)?.title),
    );
  }

  // Helper: restore sheltered milestone directories (#2505).
  // Called on both success and error paths to ensure queued CONTEXT files
  // are never permanently lost. Idempotent — the error path may fire after
  // the success path has already restored and removed the shelter dir; a
  // second call is a no-op instead of logging a misleading "shelter restore
  // failed: ENOENT" error for shelter sources that were cleaned up legitimately.
  const restoreShelter = (): void => {
    if (shelterRestored) return;
    shelterRestored = true;
    if (shelteredDirs.length === 0) return;
    let restoreFailed = false;
    for (const dirName of shelteredDirs) {
      const src = join(shelterDir, dirName);
      // If the shelter source is missing the restore cannot proceed for this
      // entry. Distinguish "legitimately missing" (shelter dir removed by a
      // prior successful restore or never copied) from a surprising ENOENT
      // inside an otherwise-populated shelter.
      if (!existsSync(src)) {
        logWarning(
          "worktree",
          `shelter source missing for ${dirName}; skipping restore (shelter already cleaned or entry never staged)`,
        );
        continue;
      }
      try {
        mkdirSync(planningDir, { recursive: true });
        // Test seam: when _restoreEntryFn is injected, route the copy through it
        // so the best-effort failure path (and shelter-retention guarantee) can
        // be exercised deterministically. Production leaves it null → real cpSync.
        const dest = join(planningDir, dirName);
        if (_restoreEntryFn) {
          _restoreEntryFn(src, dest);
        } else {
          cpSync(src, dest, { recursive: true, force: true });
        }
      } catch (err) { /* best-effort */
        restoreFailed = true;
        logError("worktree", `shelter restore failed (${dirName}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Preserve the shelter if any per-entry restore failed — it is the only
    // surviving copy of the queued milestone dirs (sources were deleted during
    // shelter). Deleting it here would permanently lose those files (#2505).
    if (restoreFailed) {
      logWarning("worktree", `shelter retained at ${shelterDir} — manual recovery required for unrestored entries`);
      return;
    }
    if (existsSync(shelterDir)) {
      try { rmSync(shelterDir, { recursive: true, force: true }); } catch (err) { /* best-effort */
        logWarning("worktree", `shelter cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  try {
    if (existsSync(planningDir)) {
      const entries = readdirSync(planningDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Only shelter directories that do NOT belong to the milestone being merged
        if (mergeDirNames.has(entry.name)) continue;
        const srcDir = join(planningDir, entry.name);
        const dstDir = join(shelterDir, entry.name);
        try {
          mkdirSync(shelterDir, { recursive: true });
          cpSync(srcDir, dstDir, { recursive: true, force: true });
          rmSync(srcDir, { recursive: true, force: true });
          shelteredDirs.push(entry.name);
        } catch (err) {
          // Non-fatal — if shelter fails, the merge may still succeed
          logWarning("worktree", `milestone shelter failed (${entry.name}): ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (err) {
    // Non-fatal — proceed with merge; untracked files may block it
    logWarning("worktree", `milestone shelter operation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 7a. Stash pre-existing dirty files so the squash merge is not blocked by
  //     unrelated local changes (#2151). Includes untracked files to handle
  //     locally-added files that conflict with tracked files on the milestone
  //     branch. Passing NO pathspec lets git skip gitignored paths silently;
  //     adding an explicit pathspec trips a `git add`-style fatal on ignored
  //     entries (e.g. a gitignored `.gsd` symlink under ADR-002) (#4573).
  //     Queued CONTEXT files under `.gsd/phases/*` (or legacy milestones/*)
  //     are already sheltered in step 7 above, so they won't be swept into the stash.
  // On Windows, SQLite holds mandatory file locks on the gsd.db WAL/SHM
  // sidecars while the connection is open. `git stash --include-untracked`
  // walks those files and fails with EBUSY (#4704). Close the DB before
  // stashing so Windows releases the handles; reopen after. No-op on
  // POSIX, where advisory locks don't block git.
  const needsDbCycle = process.platform === "win32" && isDbAvailable();
  const dbPathToReopen = needsDbCycle ? getWorkflowDatabasePath() : null;
  if (needsDbCycle) {
    try {
      closeWorkflowDatabase();
    } catch (err) {
      logWarning("worktree", `pre-stash db close failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let stashed = false;
  // Embed a unique marker in the stash message so subsequent pop/drop targets
  // the entry we created, not whatever happens to be at stash@{0} (concurrent
  // milestone merges share the project-root stash list and can shift positions).
  // (Issue #4980 HIGH-6)
  let stashMarker: string | null = null;
  try {
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: originalBasePath_,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
    }).trim();
    if (status) {
      stashMarker = `gsd-pre-merge:${milestoneId}:${process.pid}:${Date.now()}:${process.hrtime.bigint().toString(36)}`;
      execFileSync(
        "git",
        ["stash", "push", "--include-untracked", "-m", `gsd: pre-merge stash for ${milestoneId} [${stashMarker}]`],
        { cwd: originalBasePath_, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
      );
      stashed = true;
    }
  } catch (err) {
    // Stash failure is non-fatal — proceed without stash and let the merge
    // report the dirty tree if it fails.
    logWarning("worktree", `git stash failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 7b. Clean up stale merge state before attempting the merge (#2912).
  // A leftover MERGE_HEAD (from a previous failed merge, libgit2 native path,
  // or interrupted operation) causes git merge to refuse with
  // "fatal: You have not concluded your merge (MERGE_HEAD exists)".
  // Defensively remove merge artifacts before starting.
  removeMergeStateFiles(originalBasePath_, "pre-merge");

  // 8. Merge — respect merge_strategy preference (#549).
  // "squash" (default): stages changes without a merge commit; caller commits.
  // "merge": --no-ff --no-commit so caller can supply the commit message while
  // git records a real merge commit (MERGE_HEAD present when nativeCommit runs).
  const effectiveStrategy = prefs.merge_strategy === "merge" ? "merge" : "squash";
  const mergeResult = effectiveStrategy === "merge"
    ? nativeMergeRegular(originalBasePath_, milestoneBranch)
    : nativeMergeSquash(originalBasePath_, milestoneBranch);
  if (needsDbCycle && dbPathToReopen) {
    try {
      openWorkflowDatabasePath(dbPathToReopen);
    } catch (err) {
      logWarning("worktree", `post-merge db reopen failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!mergeResult.success) {
    // Dirty working tree — the merge was rejected before it started (e.g.
    // untracked .gsd/ files left by syncStateToProjectRoot).  Preserve the
    // milestone branch so commits are not lost.
    if (mergeResult.conflicts.includes("__dirty_working_tree__")) {
      // Defensively clean merge state — the native path may leave MERGE_HEAD
      // even when the merge is rejected (#2912).
      removeMergeStateFiles(originalBasePath_, "dirty-tree rejection");

      // Pop stash before throwing so local work is not lost.
      if (stashed) {
        try {
          popStashByRef(originalBasePath_, stashMarker);
        } catch (err) { /* stash pop conflict is non-fatal */
          logWarning("worktree", `git stash pop failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      restoreShelter();
      // Restore cwd so the caller is not stranded on the integration branch
      process.chdir(previousCwd);
      // Surface the actual dirty filenames from git stderr instead of
      // generically blaming .gsd/ (#2151).
      const fileList = mergeResult.dirtyFiles?.length
        ? `Dirty files:\n${mergeResult.dirtyFiles.map((f) => `  ${f}`).join("\n")}`
        : `Check \`git status\` in the project root for details.`;
      throw new GSDError(
        GSD_GIT_ERROR,
        `${effectiveStrategy === "merge" ? "Merge" : "Squash merge"} of ${milestoneBranch} rejected: working tree has dirty or untracked files ` +
          `that conflict with the merge. ${fileList}`,
      );
    }

    // Check for conflicts — use merge result first, fall back to nativeConflictFiles
    const conflictedFiles =
      mergeResult.conflicts.length > 0
        ? mergeResult.conflicts
        : nativeConflictFiles(originalBasePath_);

    if (conflictedFiles.length > 0) {
      // Separate auto-resolvable conflicts (GSD state files + build artifacts)
      // from real code conflicts. GSD state files diverge between branches
      // during normal operation. Build artifacts are machine-generated and
      // regenerable. Both are safe to accept from the milestone branch.
      const { resolved: autoResolved, remaining: codeConflicts } = autoResolveSafeConflictPaths(
        originalBasePath_,
        conflictedFiles,
      );
      if (autoResolved.length > 0) {
        logWarning("worktree", `auto-resolved safe merge conflicts: ${autoResolved.join(", ")}`);
      }

      // If there are still real code conflicts, escalate
      if (codeConflicts.length > 0) {
        cleanupConflictState(originalBasePath_);

        // Pop stash before throwing so local work is not lost (#2151).
        if (stashed) {
          try {
            popStashByRef(originalBasePath_, stashMarker);
          } catch (err) { /* stash pop conflict is non-fatal */
            logWarning("worktree", `git stash pop failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        restoreShelter();
        // Restore cwd so the caller is not stranded on the integration branch.
        // Without this, the next mergeMilestoneToMain call in a parallel merge
        // sequence uses process.cwd() (now the project root) as worktreeCwd,
        // causing autoCommitDirtyState to commit unrelated milestone files to
        // the integration branch (#2929).
        process.chdir(previousCwd);
        throw new MergeConflictError(
          codeConflicts,
          effectiveStrategy,
          milestoneBranch,
          mainBranch,
        );
      }
    }
    // No conflicts detected — possibly "already up to date", fall through to commit
  }

  // 9. Commit (handle nothing-to-commit gracefully)
  const commitResult = nativeCommit(originalBasePath_, commitMessage);
  const nothingToCommit = commitResult === null;

  // 9a. Clean up merge state files left by git merge --squash (#1853, #2912).
  // git only removes SQUASH_MSG when the commit reads it directly (plain
  // `git commit`).  nativeCommit uses `-F -` (stdin) or libgit2, neither
  // of which trigger git's SQUASH_MSG cleanup.  MERGE_HEAD is created by
  // libgit2's merge even in squash mode and is not removed by nativeCommit.
  // If left on disk, doctor reports `corrupt_merge_state` on every subsequent run.
  removeMergeStateFiles(originalBasePath_, "post-commit");

  // 9a-ii. Restore stashed files now that the merge+commit is complete (#2151).
  // Pop after commit so stashed changes do not interfere with the squash merge
  // or the commit content.  Conflict on pop is non-fatal — the stash entry is
  // preserved and the user can resolve manually with `git stash pop`.
  if (stashed) {
    let stashRefForDrop: string | null = null;
    try {
      stashRefForDrop = popStashByRef(originalBasePath_, stashMarker);
    } catch (e) {
      stashRefForDrop = stashRefFromError(e);
      logWarning("worktree", `git stash pop failed, attempting conflict resolution: ${(e as Error).message}`);
      // Stash pop after squash merge can conflict on .gsd/ state files that
      // diverged between branches.  Left unresolved, these UU entries block
      // every subsequent merge.  Auto-resolve them the same way we handle
      // .gsd/ conflicts during the merge itself: accept HEAD (the just-committed
      // version) and drop the now-applied stash.
      const uu = nativeConflictFiles(originalBasePath_);
      const gsdUU = uu.filter((f) => f.startsWith(".gsd/"));
      const nonGsdUU = uu.filter((f) => !f.startsWith(".gsd/"));
      const stashPopMessage = e instanceof Error ? e.message : String(e);
      const isUntrackedRestoreFailure = stashPopMessage.includes("could not restore untracked files from stash");
      const gsdContentConflicts: string[] = [];
      const alreadyExists = stashAlreadyExistsFilesFromError(e);

      // Untracked-file restore failures can leave marker conflicts in tracked
      // .gsd JSONL files without producing `U` status entries.
      if (isUntrackedRestoreFailure) {
        gsdContentConflicts.push(...gsdJsonlFilesWithConflictMarkers(originalBasePath_));
      }
      const gsdConflictFiles = [...new Set([...gsdUU, ...gsdContentConflicts])];

      if (gsdConflictFiles.length > 0) {
        for (const f of gsdConflictFiles) {
          try {
            // Accept the committed (HEAD) version of the state file
            execFileSync("git", ["checkout", "HEAD", "--", f], {
              cwd: originalBasePath_,
              stdio: ["ignore", "pipe", "pipe"],
              encoding: "utf-8",
            });
            nativeAddPaths(originalBasePath_, [f]);
          } catch (e) {
            // Last resort: remove the conflicted state file
            logWarning("worktree", `checkout HEAD failed for ${f}, removing: ${(e as Error).message}`);
            nativeRmForce(originalBasePath_, [f]);
          }
        }
      }

      if (gsdConflictFiles.length > 0 && nonGsdUU.length === 0) {
        // All detected conflicts were .gsd/ files. Before dropping, verify no
        // unresolved non-.gsd conflict markers or unmerged entries remain.
        const remainingUnmerged = nativeConflictFiles(originalBasePath_);
        const nonGsdUnmerged = remainingUnmerged.filter((f) => !f.startsWith(".gsd/"));
        const markerCandidates = Array.from(new Set([
          ...nonGsdUnmerged,
          ...nativeLsFiles(originalBasePath_, "."),
        ])).filter((f) => !f.startsWith(".gsd/"));
        const nonGsdMarkerConflicts = markerCandidates.filter((f) =>
          hasConflictMarkers(join(originalBasePath_, f)),
        );
        const hasRemainingNonGsdConflicts = nonGsdUnmerged.length > 0 || nonGsdMarkerConflicts.length > 0;
        if (hasRemainingNonGsdConflicts) {
          const files = Array.from(new Set([...nonGsdUnmerged, ...nonGsdMarkerConflicts]));
          logWarning("reconcile", "Leaving stash because non-.gsd conflicts remain after auto-resolution", {
            files: files.join(", "),
          });
        }

        // No non-.gsd conflicts remain — safe to drop the stash.
        if (!hasRemainingNonGsdConflicts && stashRefForDrop) {
          try {
            execFileSync("git", ["stash", "drop", stashRefForDrop], {
              cwd: originalBasePath_,
              stdio: ["ignore", "pipe", "pipe"],
              encoding: "utf-8",
            });
          } catch (err) { /* stash may already be consumed */
            logWarning("worktree", `git stash drop failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (!hasRemainingNonGsdConflicts) {
          logWarning("worktree", "recorded stash entry could not be resolved; skipping automatic drop");
        }
      } else if (
        gsdUU.length === 0 &&
        nonGsdUU.length === 0 &&
        alreadyExists.length > 0
      ) {
        // Untracked-file restore failure from stash pop where all collided paths
        // already exist after merge (committed on target). Safe to drop the stash
        // for the full alreadyExists set — they were untracked on source by
        // definition of the "already exists, no checkout" failure.
        if (stashRefForDrop) {
          try {
            execFileSync("git", ["stash", "drop", stashRefForDrop], {
              cwd: originalBasePath_,
              stdio: ["ignore", "pipe", "pipe"],
              encoding: "utf-8",
            });
          } catch (err) { /* stash may already be consumed */
            logWarning("worktree", `git stash drop failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          logWarning("worktree", "recorded stash entry could not be resolved; skipping automatic drop");
        }
      } else if (nonGsdUU.length > 0) {
        // Non-.gsd conflicts remain — leave stash for manual resolution
        logWarning("reconcile", "Stash pop conflict on non-.gsd files after merge", {
          files: nonGsdUU.join(", "),
        });
      } else {
        logWarning(
          "worktree",
          "git stash pop failed without resolvable conflict files; leaving stash for manual recovery",
        );
      }
    }
  }

  // 9a-iii. Restore sheltered queued milestone directories (#2505).
  restoreShelter();

  // 9b. Safety check (#1792): if nothing was committed, verify the milestone
  // work is already on the integration branch before allowing teardown.
  // Compare only non-.gsd/ paths — .gsd/ state files diverge normally and
  // are auto-resolved during the squash merge.
  if (nothingToCommit) {
    const numstat = nativeDiffNumstat(
      originalBasePath_,
      mainBranch,
      milestoneBranch,
    );
    const codeChanges = numstat.filter(
      (entry) => !entry.path.startsWith(".gsd/"),
    );
    if (codeChanges.length > 0) {
      // Milestone has unanchored code changes — abort teardown.
      process.chdir(previousCwd);
      throw new GSDError(
        GSD_GIT_ERROR,
        `${effectiveStrategy === "merge" ? "Merge" : "Squash merge"} produced nothing to commit but milestone branch "${milestoneBranch}" ` +
          `has ${codeChanges.length} code file(s) not on "${mainBranch}". ` +
          `Aborting worktree teardown to prevent data loss.`,
      );
    }
  }

  // 9c. Detect whether any non-.gsd/ code files were actually merged (#1906).
  // When a milestone only produced .gsd/ metadata (summaries, roadmaps) but no
  // real code, the user sees "milestone complete" but nothing changed in their
  // codebase. Surface this so the caller can warn the user.
  //
  // Bug #4385 fix: use `git diff-tree --root` instead of `git diff HEAD~1 HEAD`.
  // `HEAD~1` does not exist on initial commits and is unreliable on shallow clones
  // and merge commits. `diff-tree --root` handles all three cases correctly.
  // The empty-tree hash (4b825dc…) is the universal fallback for refs that don't exist.
  const GIT_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  let codeFilesChanged = false;
  if (!nothingToCommit) {
    try {
      const diffTreeOutput = execFileSync(
        "git",
        ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", "HEAD"],
        { cwd: originalBasePath_, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
      ).trim();
      const mergedFiles = diffTreeOutput ? diffTreeOutput.split("\n").filter(Boolean) : [];
      codeFilesChanged = mergedFiles.some((f) => !f.startsWith(".gsd/"));
    } catch (e) {
      // diff-tree failed (e.g. unborn HEAD in a brand-new repo) — fall back to
      // comparing against the empty tree so initial-commit repos still report changes.
      try {
        const fallbackOutput = execFileSync(
          "git",
          ["diff", "--name-only", GIT_EMPTY_TREE, "HEAD"],
          { cwd: originalBasePath_, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
        ).trim();
        const fallbackFiles = fallbackOutput ? fallbackOutput.split("\n").filter(Boolean) : [];
        codeFilesChanged = fallbackFiles.some((f) => !f.startsWith(".gsd/"));
      } catch {
        // Truly unable to determine — assume code was changed to avoid silent data loss
        logWarning("worktree", `diff-tree and empty-tree fallback both failed (assuming code changed): ${(e as Error).message}`);
        codeFilesChanged = true;
      }
    }
  }

  const finalizeMilestoneCleanup = (): void => {
    // 12. Remove worktree directory first (must happen before branch deletion)
    let worktreeRemoved = true;
    try {
      worktreeRemoved = removeWorktree(originalBasePath_, milestoneId, {
        branch: milestoneBranch,
        deleteBranch: false,
      });
    } catch (err) {
      worktreeRemoved = false;
      // Best-effort -- worktree dir may already be gone
      logWarning("worktree", `worktree removal failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!worktreeRemoved) {
      logWarning(
        "worktree",
        `Skipping milestone branch deletion for ${milestoneBranch}; worktree removal was aborted to preserve uncommitted milestone work.`,
      );
      return;
    }

    // 13. Delete milestone branch (after worktree removal so ref is unlocked)
    try {
      nativeBranchDelete(originalBasePath_, milestoneBranch);
    } catch (err) {
      // Best-effort
      logWarning("worktree", `git branch-delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 14. Clear module state
    setActiveWorkspace(null);
    nudgeGitBranchCache(previousCwd);

    // 15. Anchor cwd at the project root on success-return. Step 12 removed
    // the worktree dir; if cwd was inside it, every subsequent process.cwd()
    // would throw ENOENT and trip auto/run-unit.ts:50's session-failed cancel
    // path (the de73fb43d regression that closes headless gsd auto). Step 3
    // already chdir'd here, but defending the success-return contract makes
    // future maintainers safe against intervening chdir's between step 3 and
    // here.
    try {
      // process.cwd() can throw ENOENT when cwd was removed, so attempt
      // recovery directly.
      process.chdir(originalBasePath_);
    } catch (err) {
      logWarning("worktree", `chdir to project root after merge failed: ${err instanceof Error ? err.message : String(err)}`);
      debugLog("mergeMilestoneToMain", {
        phase: "post-merge-chdir-failed",
        target: originalBasePath_,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  let shouldCleanup = false;
  try {
    // 10/9b. Publication (auto-push / draft PR) — Publication module seam (ADR-034).
    const publication = publishMilestone({
      basePath: originalBasePath_,
      milestoneId,
      milestoneTitle,
      integrationBranch: mainBranch,
      milestoneBranch,
      sliceSummaries: completedSlices.map((slice) => `### ${slice.id}\n${slice.title}`),
      nothingToCommit,
      prefs: {
        autoPush: prefs.auto_push === true,
        autoPr: prefs.auto_pr === true,
        remote: prefs.remote,
        prTargetBranch: prefs.pr_target_branch,
      },
    });
    const { pushed, prCreated } = publication;

    // 11. Guard removed — step 9b (#1792) now handles this with a smarter check:
    //     throws only when the milestone has unanchored code changes, passes
    //     through when the code is genuinely already on the integration branch.

    // 11a. Pre-teardown safety net (#1853): if the worktree still has uncommitted
    // changes (e.g. nativeHasChanges cache returned stale false), abort teardown.
    // Committing here would be too late: the squash merge to the integration
    // branch already happened, so a new milestone-branch commit would not be
    // included and branch deletion could drop the only ref to that work.
    //
    // Guard: only run when worktreeCwd is on the milestone branch (#2929).
    // In parallel mode or branch-mode merges, worktreeCwd may be the project
    // root on the integration branch. Committing dirty state there would
    // capture unrelated files from other milestones.
    if (existsSync(worktreeCwd)) {
      let preTeardownBranch: string | null = null;
      try {
        preTeardownBranch = nativeGetCurrentBranch(worktreeCwd);
      } catch (err) {
        debugLog("mergeMilestoneToMain", { phase: "pre-teardown-branch-detect-failed", error: String(err) });
      }
      const isOnMilestoneBranch = preTeardownBranch === milestoneBranch;

      if (isOnMilestoneBranch) {
        try {
          const dirtyCheck = nativeWorkingTreeStatus(worktreeCwd);
          if (dirtyCheck) {
            process.chdir(previousCwd);
            throw new GSDError(
              GSD_GIT_ERROR,
              `Milestone worktree still has uncommitted changes after squash merge. ` +
                `Aborting teardown to preserve ${milestoneBranch}. Status:\n${dirtyCheck}`,
            );
          }
        } catch (e) {
          if (e instanceof GSDError) throw e;
          debugLog("mergeMilestoneToMain", {
            phase: "pre-teardown-dirty-check-error",
            error: String(e),
          });
        }
      }
    }

    shouldCleanup = true;
    return { commitMessage, pushed, prCreated, codeFilesChanged };
  } finally {
    if (shouldCleanup) {
      finalizeMilestoneCleanup();
    } else {
      logWarning(
        "worktree",
        `Skipping worktree cleanup for ${milestoneBranch}; merge did not reach safe-cleanup point and milestone work is preserved for manual recovery.`,
      );
    }
  }
}
