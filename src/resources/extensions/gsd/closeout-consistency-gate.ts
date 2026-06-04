// Project/App: gsd-pi
// File Purpose: Shared DB-backed guard for milestone closeout finalization.

import {
  getDbPath,
  getLatestAssessmentByScope,
  getMilestone,
  getMilestoneSlices,
  getPendingGates,
  getSliceTasks,
  isDbAvailable,
  refreshOpenDatabaseFromDisk,
} from "./gsd-db.js";
import { isClosedStatus } from "./status-guards.js";

export const CLOSEOUT_CONSISTENCY_BLOCKED_REASON = "closeout-consistency-blocked";

export type CloseoutConsistencyFailureReason =
  | "db-unavailable"
  | "db-refresh-failed"
  | "milestone-missing"
  | "milestone-open"
  | "validation-not-pass"
  | "slice-missing"
  | "slice-open"
  | "task-open"
  | "quality-gate-pending";

export type CloseoutConsistencyResult =
  | { ok: true }
  | {
      ok: false;
      reason: CloseoutConsistencyFailureReason;
      recoveryReason: typeof CLOSEOUT_CONSISTENCY_BLOCKED_REASON;
      message: string;
    };

export interface CloseoutConsistencyOptions {
  refreshFromDisk?: boolean;
}

function blocked(reason: CloseoutConsistencyFailureReason, message: string): CloseoutConsistencyResult {
  return {
    ok: false,
    reason,
    recoveryReason: CLOSEOUT_CONSISTENCY_BLOCKED_REASON,
    message,
  };
}

function isFileBackedDbPath(path: string | null): boolean {
  return Boolean(path && path !== ":memory:");
}

export function checkCloseoutConsistencyGate(
  milestoneId: string,
  options: CloseoutConsistencyOptions = {},
): CloseoutConsistencyResult {
  if (!isDbAvailable()) {
    return blocked(
      "db-unavailable",
      `Closeout consistency blocked for ${milestoneId}: canonical DB is unavailable.`,
    );
  }

  if (options.refreshFromDisk && isFileBackedDbPath(getDbPath()) && !refreshOpenDatabaseFromDisk()) {
    return blocked(
      "db-refresh-failed",
      `Closeout consistency blocked for ${milestoneId}: canonical DB refresh failed.`,
    );
  }

  const milestone = getMilestone(milestoneId);
  if (!milestone) {
    return blocked(
      "milestone-missing",
      `Closeout consistency blocked for ${milestoneId}: milestone is missing from canonical DB.`,
    );
  }
  if (!isClosedStatus(milestone.status)) {
    return blocked(
      "milestone-open",
      `Closeout consistency blocked for ${milestoneId}: canonical DB milestone status is "${milestone.status}".`,
    );
  }

  if (milestone.status !== "skipped") {
    const validation = getLatestAssessmentByScope(milestoneId, "milestone-validation");
    if (validation?.status !== "pass") {
      return blocked(
        "validation-not-pass",
        `Closeout consistency blocked for ${milestoneId}: latest milestone validation is "${validation?.status ?? "absent"}".`,
      );
    }
  }

  const slices = getMilestoneSlices(milestoneId);
  if (slices.length === 0 && milestone.status !== "skipped") {
    return blocked(
      "slice-missing",
      `Closeout consistency blocked for ${milestoneId}: no slices exist in canonical DB.`,
    );
  }

  for (const slice of slices) {
    if (!isClosedStatus(slice.status)) {
      return blocked(
        "slice-open",
        `Closeout consistency blocked for ${milestoneId}: slice ${slice.id} status is "${slice.status}".`,
      );
    }

    for (const task of getSliceTasks(milestoneId, slice.id)) {
      if (!isClosedStatus(task.status)) {
        return blocked(
          "task-open",
          `Closeout consistency blocked for ${milestoneId}: task ${slice.id}/${task.id} status is "${task.status}".`,
        );
      }
    }

    const pendingGate = getPendingGates(milestoneId, slice.id)[0];
    if (pendingGate) {
      return blocked(
        "quality-gate-pending",
        `Closeout consistency blocked for ${milestoneId}: quality gate ${pendingGate.gate_id} is still pending for ${slice.id}.`,
      );
    }
  }

  return { ok: true };
}

export function formatCloseoutConsistencyBlock(result: CloseoutConsistencyResult): string {
  if (result.ok) return "";
  return `${result.message} Recovery reason: ${result.recoveryReason}. Resolve the canonical DB state and run /gsd auto to retry.`;
}
