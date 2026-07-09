// Project/App: gsd-pi
// File Purpose: ADR-017 drift handler for external (gsd-core) markdown edits.
//
// gsd-pi's DB is canonical, but .gsd/*.md is the inter-tool contract. When
// gsd-core edits a projection file, this handler detects the sha drift vs the
// recorded baseline in .gsd/.compat.json and re-imports from markdown with
// status authority scoped to the affected milestone ids. The next
// renderAllFromDb pass re-projects; the write-time invalidation hook then
// refreshes the marker entry, closing the loop.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  computeProjectionSha,
  readCompatMarker,
  writeCompatMarker,
} from "../../compat/compat-marker.js";
import { logWarning } from "../../workflow-logger.js";
import type { GSDState } from "../../types.js";
import type { DriftContext, DriftHandler, DriftRecord } from "../types.js";

type ExternalMarkdownEditDrift = Extract<
  DriftRecord,
  { kind: "external-markdown-edit" }
>;

/**
 * Detect sha drift between the marker baseline and current file contents.
 *
 * - Missing marker → no records (the broader /gsd recover flow handles a
 *   cold-start; this handler only fires when we have a baseline to compare).
 * - Missing file on disk → no record (other handlers cover missing artifacts).
 * - Sha match → no record (gsd-pi's own write or no change).
 * - Sha mismatch → one record per drifted file, scoped to its recorded entities.
 */
function detectExternalMarkdownEdit(
  _state: GSDState,
  ctx: DriftContext,
): ExternalMarkdownEditDrift[] {
  const marker = readCompatMarker(ctx.basePath);
  const entries = Object.entries(marker.projections);
  if (entries.length === 0) return [];

  const records: ExternalMarkdownEditDrift[] = [];
  for (const [projectionPath, entry] of entries) {
    const abs = join(ctx.basePath, ".gsd", projectionPath);
    if (!existsSync(abs)) continue;
    const actual = computeProjectionSha(readFileSync(abs, "utf-8"));
    if (actual === entry.sha) continue;
    records.push({
      kind: "external-markdown-edit",
      projectionPath,
      expectedSha: entry.sha,
      actualSha: actual,
      entities: entry.entities,
    });
  }
  return records;
}

/**
 * Idempotent repair: re-import the hierarchy from markdown while allowing
 * markdown status authority only for milestones named by the drifted file's
 * marker entities, then update the marker entry so the next detect pass sees
 * the file as expected. migrateHierarchyToDb is itself idempotent (upsert), so
 * re-running this repair after a successful one is a no-op.
 */
async function repairExternalMarkdownEdit(
  record: ExternalMarkdownEditDrift,
  ctx: DriftContext,
): Promise<void> {
  try {
    // Dynamic imports break a module-init cycle: this handler ← registry ←
    // state.ts ← guided-flow.ts ← md-importer.ts ← (this handler's old static
    // import). Deferring to repair time keeps module load cycle-free.
    const { migrateHierarchyToDb, milestoneIdsFromEntities } = await import("../../md-importer.js");
    const { invalidateStateCache } = await import("../../state.js");
    // #027: migrateHierarchyToDb walks the whole tree (a cheap upsert), so
    // without scoping every projection rides along with markdown *status*
    // authority. That lets an unrelated file that is stale from gsd-pi's own
    // miss silently revert a reopened slice/milestone. Scope status authority to
    // exactly the milestone(s) this drifted file projects.
    //
    // Step 1: the marker's `entities` are DB ids (`M001`, `M001/S01`,
    // `M001/S01/T01`), so the milestone id is always the first `/`-segment —
    // layout-independent (legacy `milestones/<MID>/…` and flat `phases/NN-slug/…`
    // both resolve the same way), no projectionPath parsing needed. An empty set
    // (no resolvable entities) preserves DB status everywhere: fail toward
    // protecting the DB, not toward markdown authority.
    const statusAuthoritativeMilestones = milestoneIdsFromEntities(record.entities);
    if (statusAuthoritativeMilestones.size === 0) {
      logWarning(
        "reconcile",
        `external-markdown-edit: no milestone scope resolved for ${record.projectionPath}; preserving DB status for all milestones`,
      );
    }
    migrateHierarchyToDb(ctx.basePath, { statusAuthoritativeMilestones });
    invalidateStateCache();
  } catch (err) {
    logWarning(
      "reconcile",
      `external-markdown-edit repair failed for ${record.projectionPath}: ${(err as Error).message}`,
    );
    throw err;
  }

  // Refresh the marker so a second pass (cap=2 reconcile) doesn't re-fire.
  const marker = readCompatMarker(ctx.basePath);
  marker.projections[record.projectionPath] = {
    sha: record.actualSha,
    entities: record.entities,
  };
  marker.lastProjectedAt = new Date().toISOString();
  writeCompatMarker(ctx.basePath, marker);
}

export const externalMarkdownEditHandler: DriftHandler<ExternalMarkdownEditDrift> = {
  kind: "external-markdown-edit",
  detect: detectExternalMarkdownEdit,
  repair: repairExternalMarkdownEdit,
};
