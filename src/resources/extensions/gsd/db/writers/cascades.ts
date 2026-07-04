// Project/App: gsd-pi
// File Purpose: Domain Write Operations (Hierarchy Status Cascades) for the
// single-writer layer. Each operation owns its own transaction() and mutates
// the related rows of one logical hierarchy change in a single commit, so the
// atomicity rule lives in one place instead of being hand-rolled (or missed)
// in callers. Operations own DB-row atomicity only — markdown re-projection,
// validation, and messaging stay in callers / db-writer.ts.
import { getDbOrNull, transaction } from "../engine.js";
import { GSDError, GSD_STALE_STATE } from "../../errors.js";
import { isClosedStatus } from "../../status-guards.js";
import { getMilestone, getSlice, getSliceTasks, getMilestoneSlices } from "../queries.js";
// completeSliceCascade reuses the complex hierarchy write primitives (ON CONFLICT
// upserts with null sentinels) rather than re-inlining their SQL. This is a
// back-edge to gsd-db.ts, which re-exports this module — safe because the
// imported bindings are hoisted function declarations only called at runtime.
// It dissolves when these primitives move to db/writers/hierarchy.ts.
import { insertMilestone, insertSlice, updateSliceStatus, updateMilestoneStatus } from "../../gsd-db.js";

function requireDb(): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
}

// ─── Reopen cascades ───────────────────────────────────────────────────────
// A reopen blocked by a structural precondition returns a discriminated reason
// (carrying the offending entity's status where the caller's message needs it).
// Structural guards run inside the transaction for TOCTOU safety; the caller
// owns user-facing message formatting and projection.

export type ReopenSliceOutcome =
  | { ok: true; tasksReset: number }
  | { ok: false; reason: "milestone-not-found" }
  | { ok: false; reason: "milestone-closed"; status: string }
  | { ok: false; reason: "slice-not-found" }
  | { ok: false; reason: "slice-not-complete"; status: string };

/**
 * Reopen a completed slice: slice → "in_progress", all its tasks → "pending",
 * completion timestamps cleared, in one commit. Folds the hand-rolled
 * transaction-plus-cascade previously in tools/reopen-slice.ts. Guards run
 * inside the transaction (TOCTOU-safe).
 *
 * A closed slice is always reopenable. An open slice is only reopenable when it
 * carries a completed-task state desync (#1205): a UAT→planning fallback can
 * leave the slice "pending" while *all* its tasks stay "complete", which
 * deadlocks every recovery path (plan-slice/replan-slice/complete-task all
 * reject the still-closed tasks, and slice_reopen historically rejected the
 * still-open slice). Resetting those tasks to pending gives the planner the
 * clean slate it needs. An open slice that still has any unfinished
 * (pending/in-progress) task is a normal in-flight slice, not the desync, and
 * stays rejected as "slice-not-complete" so a full reset can't wipe its
 * legitimate progress.
 */
export function reopenSliceCascade(milestoneId: string, sliceId: string): ReopenSliceOutcome {
  requireDb();
  let outcome: ReopenSliceOutcome = { ok: true, tasksReset: 0 };
  transaction(() => {
    const milestone = getMilestone(milestoneId);
    if (!milestone) { outcome = { ok: false, reason: "milestone-not-found" }; return; }
    if (isClosedStatus(milestone.status)) { outcome = { ok: false, reason: "milestone-closed", status: milestone.status }; return; }
    const slice = getSlice(milestoneId, sliceId);
    if (!slice) { outcome = { ok: false, reason: "slice-not-found" }; return; }

    const tasks = getSliceTasks(milestoneId, sliceId);
    // A closed slice is always reopenable. An open slice is only the #1205
    // desync when EVERY task is already closed (a UAT→planning fallback left the
    // slice open with all tasks still "complete"). Requiring *all* tasks closed
    // (not merely one) means a normal in-flight slice — which keeps at least one
    // pending/in-progress task — is rejected, so a full reset can't wipe its
    // legitimate progress.
    const allTasksClosed = tasks.length > 0 && tasks.every((t) => isClosedStatus(t.status));
    if (!isClosedStatus(slice.status) && !allTasksClosed) {
      outcome = { ok: false, reason: "slice-not-complete", status: slice.status };
      return;
    }

    getDbOrNull()!.prepare(
      `UPDATE slices SET status = 'in_progress', completed_at = NULL WHERE milestone_id = :mid AND id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    getDbOrNull()!.prepare(
      `UPDATE tasks SET status = 'pending', completed_at = NULL WHERE milestone_id = :mid AND slice_id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    outcome = { ok: true, tasksReset: tasks.length };
  });
  return outcome;
}

export type ReopenMilestoneOutcome =
  | { ok: true; slicesReset: number; tasksReset: number }
  | { ok: false; reason: "milestone-not-found" }
  | { ok: false; reason: "milestone-not-closed"; status: string };

/**
 * Reopen a closed milestone: milestone → "active", every slice → "in_progress",
 * every task → "pending", completion timestamps cleared, in one commit. Folds
 * the hand-rolled transaction-plus-cascade previously in tools/reopen-milestone.ts.
 */
export function reopenMilestoneCascade(milestoneId: string): ReopenMilestoneOutcome {
  requireDb();
  let outcome: ReopenMilestoneOutcome = { ok: true, slicesReset: 0, tasksReset: 0 };
  transaction(() => {
    const milestone = getMilestone(milestoneId);
    if (!milestone) { outcome = { ok: false, reason: "milestone-not-found" }; return; }
    if (!isClosedStatus(milestone.status)) { outcome = { ok: false, reason: "milestone-not-closed", status: milestone.status }; return; }

    const slices = getMilestoneSlices(milestoneId);

    getDbOrNull()!.prepare(
      `UPDATE milestones SET status = 'active', completed_at = NULL WHERE id = :mid`,
    ).run({ ":mid": milestoneId });
    getDbOrNull()!.prepare(
      `UPDATE slices SET status = 'in_progress', completed_at = NULL WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    const tasksResult = getDbOrNull()!.prepare(
      `UPDATE tasks SET status = 'pending', completed_at = NULL WHERE milestone_id = :mid`,
    ).run({ ":mid": milestoneId });
    const tasksReset = (tasksResult as { changes?: number }).changes ?? 0;
    outcome = { ok: true, slicesReset: slices.length, tasksReset };
  });
  return outcome;
}

export type CompleteSliceOutcome =
  | { ok: true; duplicate: boolean; existingSummaryMd: string }
  | { ok: false; reason: "milestone-closed"; status: string }
  | { ok: false; reason: "no-tasks" }
  | { ok: false; reason: "incomplete-tasks"; incomplete: Array<{ id: string; status: string }> };

/**
 * Complete a slice: verify preconditions, auto-create the milestone/slice rows
 * if absent, mark the slice "complete", and activate a still-"planned"
 * milestone once all its slices are closed — all in one transaction. Folds the
 * hand-rolled cascade previously in tools/complete-slice.ts.
 *
 * Returns a discriminated outcome. The `duplicate: true` success case means the
 * slice was already closed (no writes performed); the caller handles the stale/
 * idempotent path. `existingSummaryMd` carries the slice's prior summary so the
 * caller can backfill omitted requirement fields. Markdown rendering, file
 * writes, and summary persistence stay in the caller.
 */
export function completeSliceCascade(
  milestoneId: string,
  sliceId: string,
  opts: { sliceTitle?: string; completedAt: string },
): CompleteSliceOutcome {
  requireDb();
  let outcome: CompleteSliceOutcome = { ok: true, duplicate: false, existingSummaryMd: "" };
  transaction(() => {
    // Preconditions inside the txn for atomicity. A missing milestone/slice is
    // fine — they are auto-created below; only a closed one blocks.
    const milestone = getMilestone(milestoneId);
    if (milestone && isClosedStatus(milestone.status)) {
      outcome = { ok: false, reason: "milestone-closed", status: milestone.status };
      return;
    }

    const slice = getSlice(milestoneId, sliceId);
    const existingSummaryMd = slice?.full_summary_md?.trim() ?? "";
    if (slice && isClosedStatus(slice.status)) {
      outcome = { ok: true, duplicate: true, existingSummaryMd };
      return;
    }

    const tasks = getSliceTasks(milestoneId, sliceId);
    if (tasks.length === 0) {
      outcome = { ok: false, reason: "no-tasks" };
      return;
    }
    const incomplete = tasks
      .filter((t) => !isClosedStatus(t.status))
      .map((t) => ({ id: t.id, status: t.status }));
    if (incomplete.length > 0) {
      outcome = { ok: false, reason: "incomplete-tasks", incomplete };
      return;
    }

    // All guards passed — perform writes. Preserve existing planning metadata:
    // completion must not overwrite title/risk/depends/demo/sequence.
    insertMilestone({ id: milestoneId, title: milestoneId });
    if (!slice) {
      insertSlice({ id: sliceId, milestoneId, title: opts.sliceTitle || sliceId });
    }
    updateSliceStatus(milestoneId, sliceId, "complete", opts.completedAt);

    const updatedSlices = getMilestoneSlices(milestoneId);
    if (
      milestone?.status === "planned" &&
      updatedSlices.length > 0 &&
      updatedSlices.every((s) => isClosedStatus(s.status))
    ) {
      updateMilestoneStatus(milestoneId, "active");
    }
    outcome = { ok: true, duplicate: false, existingSummaryMd };
  });
  return outcome;
}

export type SkipSliceOutcome =
  | { ok: true; tasksSkipped: number; wasAlreadySkipped: boolean }
  | { ok: false; reason: "slice-not-found" }
  | { ok: false; reason: "slice-already-complete" };

/**
 * Skip a slice: slice → "skipped" (unless already skipped) and every non-closed
 * task → "skipped", in one commit. Completed/done slices are rejected; closed
 * tasks are never downgraded. Folds the hand-rolled cascade previously in
 * tools/skip-slice.ts. Guards run inside the transaction (TOCTOU-safe).
 */
export function skipSliceCascade(milestoneId: string, sliceId: string): SkipSliceOutcome {
  requireDb();
  let outcome: SkipSliceOutcome = { ok: true, tasksSkipped: 0, wasAlreadySkipped: false };
  transaction(() => {
    const slice = getSlice(milestoneId, sliceId);
    if (!slice) { outcome = { ok: false, reason: "slice-not-found" }; return; }
    if (slice.status === "complete" || slice.status === "done") {
      outcome = { ok: false, reason: "slice-already-complete" };
      return;
    }
    const wasAlreadySkipped = slice.status === "skipped";
    if (!wasAlreadySkipped) {
      getDbOrNull()!.prepare(
        `UPDATE slices SET status = 'skipped', completed_at = NULL WHERE milestone_id = :mid AND id = :sid`,
      ).run({ ":mid": milestoneId, ":sid": sliceId });
    }
    // Cascade: skip every non-closed task so milestone completion doesn't trip
    // the deep-task guard (#4375). Closed tasks are left untouched.
    const tasks = getSliceTasks(milestoneId, sliceId);
    let tasksSkipped = 0;
    for (const task of tasks) {
      if (!isClosedStatus(task.status)) {
        getDbOrNull()!.prepare(
          `UPDATE tasks SET status = 'skipped', completed_at = NULL WHERE milestone_id = :mid AND slice_id = :sid AND id = :tid`,
        ).run({ ":mid": milestoneId, ":sid": sliceId, ":tid": task.id });
        tasksSkipped++;
      }
    }
    outcome = { ok: true, tasksSkipped, wasAlreadySkipped };
  });
  return outcome;
}

/**
 * Reset a slice to "active" and all of its tasks to "pending" in one commit,
 * clearing completion timestamps. Equivalent to the historical per-task
 * updateTaskStatus loop + updateSliceStatus in undo's reset-slice, but atomic:
 * an interruption can no longer leave some tasks reset and others not.
 */
export function resetSliceCascade(milestoneId: string, sliceId: string): void {
  if (!getDbOrNull()!) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  transaction(() => {
    getDbOrNull()!.prepare(
      `UPDATE tasks SET status = 'pending', completed_at = NULL
       WHERE milestone_id = :mid AND slice_id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
    getDbOrNull()!.prepare(
      `UPDATE slices SET status = 'active', completed_at = NULL
       WHERE milestone_id = :mid AND id = :sid`,
    ).run({ ":mid": milestoneId, ":sid": sliceId });
  });
}
