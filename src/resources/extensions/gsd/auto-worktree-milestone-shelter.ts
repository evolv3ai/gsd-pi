// gsd-pi — Milestone directory shelter for auto-worktree merge closeout.
//
// Owns the #2505 queued-milestone directory protection step that runs before
// merge stash handling. This keeps queued CONTEXT files out of the stash and
// restores them after merge closeout without hiding restore failures.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";

import {
  canonicalPhaseDirName,
  gsdRoot,
  milestonesDir,
  resolveMilestonePath,
} from "./paths.js";
import { logError, logWarning } from "./workflow-logger.js";

export interface MilestoneDirectoryShelter {
  restore(): void;
}

/**
 * Optional override for the shelter restore copy step (milestone merge #2505).
 * Production leaves this null so restore uses the real cpSync; tests inject a
 * throwing function to deterministically exercise the best-effort failure path
 * and the shelter-retention guarantee.
 * @internal
 */
let restoreEntryFn: ((src: string, dest: string) => void) | null = null;

/** @internal */
export function _setRestoreEntryFnForTests(
  fn: ((src: string, dest: string) => void) | null,
): () => void {
  restoreEntryFn = fn;
  return () => { restoreEntryFn = null; };
}

export function createMilestoneDirectoryShelter(
  originalBasePath: string,
  milestoneId: string,
  milestoneTitle: string | undefined,
): MilestoneDirectoryShelter {
  const planningDir = milestonesDir(originalBasePath);
  const shelterDir = join(gsdRoot(originalBasePath), ".milestone-shelter");
  const shelteredDirs: string[] = [];
  const mergeDirNames = milestoneDirectoryNames(originalBasePath, milestoneId, milestoneTitle);
  let restored = false;

  try {
    if (existsSync(planningDir)) {
      const entries = readdirSync(planningDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (mergeDirNames.has(entry.name)) continue;
        shelterMilestoneDirectory(planningDir, shelterDir, entry.name, shelteredDirs);
      }
    }
  } catch (err) {
    // Non-fatal — proceed with merge; untracked files may block it.
    logWarning("worktree", `milestone shelter operation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    restore(): void {
      if (restored) return;
      restored = true;
      restoreShelteredDirectories(planningDir, shelterDir, shelteredDirs);
    },
  };
}

function milestoneDirectoryNames(
  originalBasePath: string,
  milestoneId: string,
  milestoneTitle: string | undefined,
): Set<string> {
  const mergeDirNames = new Set<string>([milestoneId]);
  const resolvedMergeDir = resolveMilestonePath(originalBasePath, milestoneId);
  if (resolvedMergeDir) {
    mergeDirNames.add(basename(resolvedMergeDir));
  } else {
    mergeDirNames.add(canonicalPhaseDirName(milestoneId, milestoneTitle));
  }
  return mergeDirNames;
}

function shelterMilestoneDirectory(
  planningDir: string,
  shelterDir: string,
  dirName: string,
  shelteredDirs: string[],
): void {
  const srcDir = join(planningDir, dirName);
  const dstDir = join(shelterDir, dirName);
  try {
    mkdirSync(shelterDir, { recursive: true });
    cpSync(srcDir, dstDir, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
    shelteredDirs.push(dirName);
  } catch (err) {
    // Non-fatal — if shelter fails, the merge may still succeed.
    logWarning("worktree", `milestone shelter failed (${dirName}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

function restoreShelteredDirectories(
  planningDir: string,
  shelterDir: string,
  shelteredDirs: string[],
): void {
  if (shelteredDirs.length === 0) return;

  let restoreFailed = false;
  for (const dirName of shelteredDirs) {
    const src = join(shelterDir, dirName);
    if (!existsSync(src)) {
      logWarning(
        "worktree",
        `shelter source missing for ${dirName}; skipping restore (shelter already cleaned or entry never staged)`,
      );
      continue;
    }
    try {
      mkdirSync(planningDir, { recursive: true });
      const dest = join(planningDir, dirName);
      if (restoreEntryFn) {
        restoreEntryFn(src, dest);
      } else {
        cpSync(src, dest, { recursive: true, force: true });
      }
    } catch (err) {
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
    try {
      rmSync(shelterDir, { recursive: true, force: true });
    } catch (err) {
      logWarning("worktree", `shelter cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
