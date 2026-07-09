// GSD — reopen-milestone tool handler

/**
 * reopen-milestone handler — the core operation behind gsd_milestone_reopen.
 *
 * Resets a closed milestone back to "active", all of its slices to
 * "in_progress", and all tasks to "pending". Cleans up stale filesystem
 * artifacts so the DB-filesystem reconciler does not auto-correct
 * entities back to "complete".
 */

import {
  getMilestoneSlices,
  getSliceTasks,
  reopenMilestoneCascade,
} from "../gsd-db.js";
import { invalidateStateCache } from "../state.js";
import { flushWorkflowProjections } from "../projection-flush.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";
import { debugLog } from "../debug-logger.js";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  buildFlatTaskFileName,
  buildTaskFileName,
  legacyMilestonesDir,
  resolveMilestonePath,
  resolveSlicePath,
  resolveTasksDir,
  clearPathCache,
} from "../paths.js";

export interface ReopenMilestoneParams {
  milestoneId: string;
  reason?: string;
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface ReopenMilestoneResult {
  milestoneId: string;
  slicesReset: number;
  tasksReset: number;
}

export async function handleReopenMilestone(
  params: ReopenMilestoneParams,
  basePath: string,
): Promise<ReopenMilestoneResult | { error: string }> {
  // ── Validate required fields ────────────────────────────────────────────
  if (!params.milestoneId || typeof params.milestoneId !== "string" || params.milestoneId.trim() === "") {
    return { error: "milestoneId is required and must be a non-empty string" };
  }

  // ── Atomic reopen cascade (guards + writes in one transaction) ───────────
  const outcome = reopenMilestoneCascade(params.milestoneId);
  if (!outcome.ok) {
    switch (outcome.reason) {
      case "milestone-not-found":
        return { error: `milestone not found: ${params.milestoneId}` };
      case "milestone-not-closed":
        return { error: `milestone ${params.milestoneId} is not closed (status: ${outcome.status}) — nothing to reopen` };
    }
  }
  const slicesResetCount = outcome.slicesReset;
  const tasksResetCount = outcome.tasksReset;

  // ── Invalidate caches ────────────────────────────────────────────────────
  invalidateStateCache();

  // ── Clean up stale filesystem artifacts (M12 fix) ────────────────────────
  // Without this, the DB-filesystem reconciler sees SUMMARY.md files and
  // auto-corrects entities back to "complete", making reopen a no-op (#3161).
  try {
    const milestoneDir = resolveMilestonePath(basePath, params.milestoneId);
    const legacyBase = legacyMilestonesDir(basePath);
    const isLegacy = !!milestoneDir && (
      milestoneDir.startsWith(legacyBase + "/") || milestoneDir.startsWith(legacyBase + "\\")
    );
    if (milestoneDir) {
      const milestoneSummary = join(milestoneDir, `${params.milestoneId}-SUMMARY.md`);
      if (existsSync(milestoneSummary)) unlinkSync(milestoneSummary);
    }

    const slices = getMilestoneSlices(params.milestoneId);
    for (const slice of slices) {
      const sliceDir = resolveSlicePath(basePath, params.milestoneId, slice.id);
      if (sliceDir) {
        const sliceSummary = join(sliceDir, `${slice.id}-SUMMARY.md`);
        if (existsSync(sliceSummary)) unlinkSync(sliceSummary);
        const sliceUat = join(sliceDir, `${slice.id}-UAT.md`);
        if (existsSync(sliceUat)) unlinkSync(sliceUat);
      }

      const tasksDir = resolveTasksDir(basePath, params.milestoneId, slice.id);
      const tasks = getSliceTasks(params.milestoneId, slice.id);
      for (const task of tasks) {
        const taskSummaries = isLegacy
          ? (tasksDir ? [join(tasksDir, buildTaskFileName(task.id, "SUMMARY"))] : [])
          : milestoneDir
            ? [
              join(milestoneDir, buildFlatTaskFileName(slice.id, task.id, "SUMMARY")),
              join(milestoneDir, buildTaskFileName(task.id, "SUMMARY")),
            ]
            : [];
        for (const taskSummary of taskSummaries) {
          if (existsSync(taskSummary)) unlinkSync(taskSummary);
        }
      }
    }
  } catch (err) { debugLog("reopen-milestone-cleanup-failed", { milestoneId: params.milestoneId, error: String(err) }); }
  clearPathCache();

  // ── Post-mutation hook ───────────────────────────────────────────────────
  try {
    await flushWorkflowProjections(basePath, { milestoneId: params.milestoneId });
    writeManifest(basePath);
    appendEvent(basePath, {
      cmd: "reopen-milestone",
      params: {
        milestoneId: params.milestoneId,
        reason: params.reason ?? null,
        slicesReset: slicesResetCount,
        tasksReset: tasksResetCount,
      },
      ts: new Date().toISOString(),
      actor: "agent",
      actor_name: params.actorName,
      trigger_reason: params.triggerReason,
    });
  } catch (hookErr) {
    logWarning("tool", `reopen-milestone post-mutation hook warning: ${(hookErr as Error).message}`);
  }

  return {
    milestoneId: params.milestoneId,
    slicesReset: slicesResetCount,
    tasksReset: tasksResetCount,
  };
}
