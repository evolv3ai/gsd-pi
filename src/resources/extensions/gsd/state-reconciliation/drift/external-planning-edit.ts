// Project/App: gsd-pi
// File Purpose: ADR-017 drift handler for external (gsd-core) edits to .planning/.
// Parallel to external-markdown-edit.ts. Detects sha drift between the compat
// marker's planning.projections/passthrough and current .planning/ files.
//
// Modeled files (projections): re-imported via parsePlanningDirectory → DB.
// Passthrough files (un-modeled docs): sha refreshed, content untouched.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  computeProjectionSha,
  readCompatMarker,
  writeCompatMarker,
} from "../../compat/compat-marker.js";
import {
  isPlanningPassthroughRelPath,
  walkPlanningRelPaths,
} from "../../compat/planning-compat.js";
import { logWarning } from "../../workflow-logger.js";
import type { GSDState } from "../../types.js";
import type { DriftContext, DriftHandler, DriftRecord } from "../types.js";

type ExternalPlanningEditDrift = Extract<
  DriftRecord,
  { kind: "external-planning-edit" }
>;

function detectOne(
  ctx: DriftContext,
  entries: Record<string, { sha: string; entities: string[] }>,
  passthrough: boolean,
): ExternalPlanningEditDrift[] {
  const records: ExternalPlanningEditDrift[] = [];
  for (const [projectionPath, entry] of Object.entries(entries)) {
    const abs = join(ctx.basePath, ".planning", projectionPath);
    if (!existsSync(abs)) continue; // missing-file drift is covered by other handlers
    const actual = computeProjectionSha(readFileSync(abs, "utf-8"));
    if (actual === entry.sha) continue;
    records.push({
      kind: "external-planning-edit",
      projectionPath,
      expectedSha: entry.sha,
      actualSha: actual,
      entities: entry.entities,
      passthrough,
    });
  }
  return records;
}

function detectUnseededPlanningFiles(
  ctx: DriftContext,
  projections: Record<string, { sha: string; entities: string[] }>,
  passthrough: Record<string, { sha: string; entities: string[] }>,
): ExternalPlanningEditDrift[] {
  const planningDir = join(ctx.basePath, ".planning");
  if (!existsSync(planningDir)) return [];

  const records: ExternalPlanningEditDrift[] = [];
  for (const relPath of walkPlanningRelPaths(planningDir)) {
    const isPassthrough = isPlanningPassthroughRelPath(relPath);
    const map = isPassthrough ? passthrough : projections;
    if (map[relPath]) continue;
    const abs = join(planningDir, relPath);
    const actual = computeProjectionSha(readFileSync(abs, "utf-8"));
    records.push({
      kind: "external-planning-edit",
      projectionPath: relPath,
      expectedSha: "",
      actualSha: actual,
      entities: [],
      passthrough: isPassthrough,
    });
  }
  return records;
}

async function detectExternalPlanningEdit(
  _state: GSDState,
  ctx: DriftContext,
): Promise<ExternalPlanningEditDrift[]> {
  const marker = readCompatMarker(ctx.basePath);
  if (!marker.planning?.active) {
    // Not yet activated. Activation (layout parse + DB import) is owned by
    // capturePlanningCompatIfNeeded, called from reconcileBeforeDispatch when
    // !dryRun. detect() must never write the marker — it is called in both
    // dry-run and non-dry-run contexts. In dry-run, preview unseeded files
    // without persisting activation.
    if (!ctx.dryRun) return [];

    const planningDir = join(ctx.basePath, ".planning");
    if (!existsSync(planningDir)) return [];
    try {
      const { parsePlanningDirectory } = await import("../../migrate/parser.js");
      const { detectPlanningLayout } = await import("../../migrate/layout-detect.js");
      const parsed = await parsePlanningDirectory(planningDir);
      const layout = detectPlanningLayout(parsed);
      if (!layout) return [];
      return detectUnseededPlanningFiles(ctx, {}, {});
    } catch (e) {
      logWarning(
        "reconcile",
        `planning layout auto-detection failed: ${(e as Error).message}`,
      );
    }
    return [];
  }
  return [
    ...detectOne(ctx, marker.planning.projections, false),
    ...detectOne(ctx, marker.planning.passthrough, true),
    ...detectUnseededPlanningFiles(
      ctx,
      marker.planning.projections,
      marker.planning.passthrough,
    ),
  ];
}

async function repairExternalPlanningEdit(
  record: ExternalPlanningEditDrift,
  ctx: DriftContext,
): Promise<void> {
  // Passthrough: never re-import (no DB model). Just refresh the sha.
  if (record.passthrough) {
    const marker = readCompatMarker(ctx.basePath);
    marker.planning!.passthrough[record.projectionPath] = {
      sha: record.actualSha,
      entities: record.entities,
    };
    marker.lastProjectedAt = new Date().toISOString();
    writeCompatMarker(ctx.basePath, marker);
    return;
  }

  // Modeled: re-import via the migrate read path. Dynamic imports break the
  // module-init cycle (this handler ← registry ← state.ts ← guided-flow.ts
  // ← md-importer.ts). parsePlanningDirectory reads .planning/, transformToGSD
  // produces the .gsd/ model, writeGSDDirectory materializes it, then
  // migrateHierarchyToDb upserts into the DB.
  try {
    const { parsePlanningDirectory } = await import("../../migrate/parser.js");
    const { transformToGSD } = await import("../../migrate/transformer.js");
    const { writeGSDDirectory } = await import("../../migrate/writer.js");
    const { migrateHierarchyToDb } = await import("../../md-importer.js");
    const { invalidateStateCache } = await import("../../state.js");

    const parsed = await parsePlanningDirectory(join(ctx.basePath, ".planning"));
    const gsdProject = transformToGSD(parsed);
    await writeGSDDirectory(gsdProject, ctx.basePath);
    migrateHierarchyToDb(ctx.basePath);
    invalidateStateCache();
  } catch (err) {
    logWarning(
      "reconcile",
      `external-planning-edit repair failed for ${record.projectionPath}: ${(err as Error).message}`,
    );
    throw err;
  }

  const marker = readCompatMarker(ctx.basePath);
  marker.planning!.projections[record.projectionPath] = {
    sha: record.actualSha,
    entities: record.entities,
  };
  marker.lastProjectedAt = new Date().toISOString();
  writeCompatMarker(ctx.basePath, marker);
}

export const externalPlanningEditHandler: DriftHandler<ExternalPlanningEditDrift> = {
  kind: "external-planning-edit",
  detect: detectExternalPlanningEdit,
  repair: repairExternalPlanningEdit,
};
