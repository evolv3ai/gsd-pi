// gsd-pi — Auto-worktree merge module.
//
// Owns milestone merge/closeout for auto-worktrees: dirty-state capture, DB
// reconciliation, integration-branch merge, stash/shelter recovery, publication,
// and safe teardown.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteSync } from "./atomic-write.js";
import { CLOSEOUT_CONSISTENCY_BLOCKED_REASON } from "./closeout-consistency-gate.js";
import { debugLog } from "./debug-logger.js";
import {
  closeWorkflowDatabase,
  getWorkflowDatabasePath,
  openWorkflowDatabasePath,
} from "./db-workspace.js";
import { GSDError, GSD_GIT_ERROR } from "./errors.js";
import { autoResolveSafeConflictPaths } from "./git-conflict-resolve.js";
import {
  MergeConflictError,
  resolveMilestoneIntegrationBranch,
  RUNTIME_EXCLUSION_PATHS,
} from "./git-service.js";
import {
  getMilestone,
  getMilestoneSlices,
  getSliceTasks,
  isDbAvailable,
  reconcileWorktreeDb,
} from "./gsd-db.js";
import {
  formatCloseoutProofBlock,
  proveMilestoneCloseout,
} from "./milestone-closeout-proof.js";
import {
  nativeAddAllWithExclusions,
  nativeBranchDelete,
  nativeCheckoutBranch,
  nativeCommit,
  nativeConflictFiles,
  nativeDetectMainBranch,
  nativeDiffNumstat,
  nativeGetCurrentBranch,
  nativeIsAncestor,
  nativeMergeRegular,
  nativeMergeSquash,
  nativeUpdateRef,
  nativeWorkingTreeStatus,
} from "./native-git-bridge.js";
import { resolveGsdPathContract } from "./paths.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { publishMilestone } from "./publication.js";
import {
  autoWorktreeBranch,
} from "./auto-worktree-branch-lifecycle.js";
import {
  _shouldReconcileWorktreeDb,
  clearProjectRootStateFiles,
} from "./auto-worktree-cleanup.js";
import { createMilestoneDirectoryShelter } from "./auto-worktree-milestone-shelter.js";
import {
  getActiveWorkspace,
  setActiveWorkspace,
} from "./auto-worktree-session-registry.js";
import { removeWorktree } from "./worktree-manager.js";
import { nudgeGitBranchCache } from "./worktree.js";
import {
  assertNoUnanchoredCodeChangesAfterEmptyMerge,
  detectMergedCodeFilesChanged,
} from "./auto-worktree-merge-code-changes.js";
import { createPreMergeStash } from "./auto-worktree-merge-stash.js";
import {
  cleanupConflictState,
  removeMergeStateFiles,
} from "./worktree-git-recovery.js";
import { logError, logWarning } from "./workflow-logger.js";

export { _setRestoreEntryFnForTests } from "./auto-worktree-milestone-shelter.js";

function stripGsdDisplayPrefix(value: string | undefined | null, id: string): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  const idLower = id.toLowerCase();
  if (lower.startsWith(`${idLower}:`)) return raw.slice(id.length + 1).trim() || undefined;
  return raw;
}

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

function normalizeLocalBranchRef(branch: string): string {
  return branch.startsWith("refs/heads/")
    ? branch.slice("refs/heads/".length)
    : branch;
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
  // MUST run before the pre-merge stash so queued CONTEXT files are not swept
  // into a stash that may later fail to pop and strand user work.
  const milestoneDirectoryShelter = createMilestoneDirectoryShelter(
    originalBasePath_,
    milestoneId,
    getMilestone(milestoneId)?.title,
  );

  // 7a. Stash pre-existing dirty files so the squash merge is not blocked by
  //     unrelated local changes (#2151). The stash module also owns Windows DB
  //     handle cycling and later stash-pop conflict recovery.
  const preMergeStash = createPreMergeStash(
    originalBasePath_,
    milestoneId,
    process.platform === "win32" && isDbAvailable(),
  );
  preMergeStash.stash();

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
  preMergeStash.reopenDbAfterMerge();

  if (!mergeResult.success) {
    // Dirty working tree — the merge was rejected before it started (e.g.
    // untracked .gsd/ files left by syncStateToProjectRoot).  Preserve the
    // milestone branch so commits are not lost.
    if (mergeResult.conflicts.includes("__dirty_working_tree__")) {
      // Defensively clean merge state — the native path may leave MERGE_HEAD
      // even when the merge is rejected (#2912).
      removeMergeStateFiles(originalBasePath_, "dirty-tree rejection");

      // Pop stash before throwing so local work is not lost.
      preMergeStash.restoreForMergeFailure();
      milestoneDirectoryShelter.restore();
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
        preMergeStash.restoreForMergeFailure();
        milestoneDirectoryShelter.restore();
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
  preMergeStash.restoreAfterCommit();

  // 9a-iii. Restore sheltered queued milestone directories (#2505).
  milestoneDirectoryShelter.restore();

  // 9b. Safety check (#1792): if nothing was committed, verify the milestone
  // work is already on the integration branch before allowing teardown.
  try {
    assertNoUnanchoredCodeChangesAfterEmptyMerge(
      originalBasePath_,
      mainBranch,
      milestoneBranch,
      effectiveStrategy,
      nothingToCommit,
    );
  } catch (err) {
    process.chdir(previousCwd);
    throw err;
  }

  // 9c. Detect whether any non-.gsd/ code files were actually merged (#1906).
  const codeFilesChanged = detectMergedCodeFilesChanged(originalBasePath_, nothingToCommit);

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
