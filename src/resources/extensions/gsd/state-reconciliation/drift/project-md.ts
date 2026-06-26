// Project/App: gsd-pi
// File Purpose: ADR-017 unregistered-milestone drift handler. Detects
// milestones whose on-disk directory has meaningful content (ROADMAP/
// CONTEXT/SUMMARY) but no DB row, then fails closed with an explicit recovery
// instruction. Markdown hierarchy import is reserved for operator-controlled
// migration/recovery commands, not automatic runtime reconciliation.

import { existsSync } from "node:fs";

import { getMilestone, isDbAvailable } from "../../gsd-db.js";
import { findMilestoneIds } from "../../milestone-ids.js";
import { resolveMilestoneFile, resolveMilestonePath } from "../../paths.js";
import type { GSDState } from "../../types.js";
import type { DriftContext, DriftHandler, DriftRecord } from "../types.js";

type UnregisteredMilestoneDrift = Extract<
  DriftRecord,
  { kind: "unregistered-milestone" }
>;

function milestoneHasContent(basePath: string, milestoneId: string): boolean {
  const roadmap = resolveMilestoneFile(basePath, milestoneId, "ROADMAP");
  const context = resolveMilestoneFile(basePath, milestoneId, "CONTEXT");
  const summary = resolveMilestoneFile(basePath, milestoneId, "SUMMARY");
  return (
    (roadmap !== null && existsSync(roadmap)) ||
    (context !== null && existsSync(context)) ||
    (summary !== null && existsSync(summary))
  );
}

export function detectUnregisteredMilestoneDrift(
  _state: GSDState,
  ctx: DriftContext,
): UnregisteredMilestoneDrift[] {
  if (!isDbAvailable()) return [];

  const drifts: UnregisteredMilestoneDrift[] = [];
  for (const milestoneId of findMilestoneIds(ctx.basePath)) {
    if (getMilestone(milestoneId)) continue;
    if (!milestoneHasContent(ctx.basePath, milestoneId)) continue;
    drifts.push({ kind: "unregistered-milestone", milestoneId });
  }
  return drifts;
}

/**
 * Repair intentionally fails closed. The project-root DB is authoritative at
 * runtime; markdown-only milestones must be reconciled through an explicit,
 * operator-controlled action so operators opt into changing canonical state.
 *
 * The hint deliberately leads with the *targeted*, non-destructive options. The
 * common cause of this drift is a directory left under an old ID after a
 * `unique_milestone_ids` rename, where the right fix is to rename (move) the
 * directory — not a full DB reimport. `/gsd recover --confirm` is a destructive
 * clear-and-reimport of the entire DB and is offered only as a last resort, so
 * users do not reach for it expecting a targeted repair (see issue #826).
 */
export function repairUnregisteredMilestone(
  record: UnregisteredMilestoneDrift,
  ctx: DriftContext,
): void {
  const dir = resolveMilestonePath(ctx.basePath, record.milestoneId);
  const dirHint = dir ?? `the .gsd directory for ${record.milestoneId}`;
  throw new Error(
    `Milestone ${record.milestoneId} exists only as markdown projection ` +
      "(on-disk ROADMAP/CONTEXT/SUMMARY with no authoritative DB row). " +
      "Runtime reconciliation will not import markdown into the DB. Choose one:\n" +
      `  • Rename: if this directory is the same milestone under an old ID (e.g. a unique_milestone_ids rename), move \`${dirHint}\` to the current ID's directory and re-run.\n` +
      `  • Discard: if this milestone is no longer relevant, delete \`${dirHint}\` and re-run.\n` +
      "  • Last resort: `/gsd recover --confirm` performs a destructive full DB clear-and-reimport — it does NOT do a targeted import and can replace or duplicate existing DB milestones.",
  );
}

export const unregisteredMilestoneHandler: DriftHandler<UnregisteredMilestoneDrift> = {
  kind: "unregistered-milestone",
  detect: detectUnregisteredMilestoneDrift,
  repair: repairUnregisteredMilestone,
};
