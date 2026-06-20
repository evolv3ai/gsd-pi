// Project/App: gsd-pi
// File Purpose: Status Transition Core (ADR-030) — the single row-level
// chokepoint every generic status write funnels through. Owns the milestone
// closed→open guard and is the one place future row-level status policy lands.
// The update*Status faces in gsd-db.ts delegate here.
//
// Behavior this pass is intentionally identical to the prior per-face writes.
// Two ADR-030 responsibilities are deferred for safety and documented inline:
//   - Write-normalization via toStatus(): workflow-reconcile replays journal
//     events that write raw "done"/"in-progress" and tests assert those exact
//     stored values, so converging on write is a separate, behavior-sensitive
//     change (migrate replay/import to canonical first).
//   - Generalizing the closed→open guard to task/slice: four legitimate reopen
//     callers (undo, tools/reopen-task, auto-post-unit, tools/plan-slice) move
//     entities to open statuses through the generic faces. Generalizing safely
//     needs sanctioned reopenTaskStatus/reopenSliceStatus faces first, mirroring
//     the existing milestone updateMilestoneStatus/reopenMilestoneStatus split.
import { getDbOrNull } from "../engine.js";
import { GSDError, GSD_STALE_STATE } from "../../errors.js";
import { isClosedStatus } from "../../status-guards.js";

/** A single row-level status write, discriminated by entity (the faces' arity). */
export type StatusTransition =
  | { entity: "task"; milestoneId: string; sliceId: string; taskId: string; status: string; completedAt?: string | null }
  | { entity: "slice"; milestoneId: string; sliceId: string; status: string; completedAt?: string | null }
  | { entity: "milestone"; milestoneId: string; status: string; completedAt?: string | null };

function requireDb() {
  const db = getDbOrNull();
  if (!db) throw new GSDError(GSD_STALE_STATE, "gsd-db: No database open");
  return db;
}

/**
 * Apply a row-level status transition. The single chokepoint for generic status
 * writes — the update*Status faces delegate here so the guard and (future)
 * normalization/journal/cache policy live in one place rather than per face.
 *
 * Milestone closed→open guard: generic updates may close, park/unpark, or
 * advance a milestone, but may not reopen a closed one; callers must use
 * reopenMilestoneStatus() (gsd_milestone_reopen). Tasks and slices are not yet
 * guarded — see the file header.
 */
export function applyStatusTransition(t: StatusTransition): void {
  const db = requireDb();
  const completedAt = t.completedAt ?? null;

  switch (t.entity) {
    case "task":
      db.prepare(
        `UPDATE tasks SET status = :status, completed_at = :completed_at
         WHERE milestone_id = :milestone_id AND slice_id = :slice_id AND id = :id`,
      ).run({
        ":status": t.status,
        ":completed_at": completedAt,
        ":milestone_id": t.milestoneId,
        ":slice_id": t.sliceId,
        ":id": t.taskId,
      });
      return;

    case "slice":
      db.prepare(
        `UPDATE slices SET status = :status, completed_at = :completed_at
         WHERE milestone_id = :milestone_id AND id = :id`,
      ).run({
        ":status": t.status,
        ":completed_at": completedAt,
        ":milestone_id": t.milestoneId,
        ":id": t.sliceId,
      });
      return;

    case "milestone": {
      const row = db.prepare("SELECT status FROM milestones WHERE id = :id").get({ ":id": t.milestoneId });
      const currentStatus = typeof row?.["status"] === "string" ? (row["status"] as string) : null;
      if (currentStatus && isClosedStatus(currentStatus) && !isClosedStatus(t.status)) {
        throw new Error(
          `Cannot update closed milestone ${t.milestoneId} from ${currentStatus} to ${t.status}; use gsd_milestone_reopen for an explicit reopen.`,
        );
      }
      db.prepare(
        `UPDATE milestones SET status = :status, completed_at = :completed_at WHERE id = :id`,
      ).run({ ":status": t.status, ":completed_at": completedAt, ":id": t.milestoneId });
      return;
    }
  }
}
