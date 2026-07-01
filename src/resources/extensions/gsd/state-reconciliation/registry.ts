// Project/App: gsd-pi
// File Purpose: ADR-017 drift handler registry and explicit repair phases.

import { completionTimestampHandler } from "./drift/completion.js";
import {
  artifactDbStatusDivergenceHandler,
  completedMilestoneReopenedHandler,
  diskSliceIdDivergenceHandler,
} from "./drift/artifact-db.js";
import { mergeStateHandler } from "./drift/merge-state.js";
import { externalMarkdownEditHandler } from "./drift/external-markdown-edit.js";
import { externalPlanningEditHandler } from "./drift/external-planning-edit.js";
import { unregisteredMilestoneHandler } from "./drift/project-md.js";
import { roadmapDivergenceHandler } from "./drift/roadmap.js";
import { sketchFlagHandler } from "./drift/sketch-flag.js";
import { staleRenderHandler } from "./drift/stale-render.js";
import { staleWorkerHandler } from "./drift/stale-worker.js";
import type { DriftHandler } from "./types.js";

export interface ReconciliationRepairPhase {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlers: ReadonlyArray<DriftHandler<any>>;
}

/**
 * Repairs run phase-by-phase; detection uses the flattened registry (all handlers).
 * external-markdown-edit MUST complete before re-project handlers (stale-render,
 * roadmap-divergence) so cross-tool edits are imported before DB re-projection.
 */
export const RECONCILIATION_REPAIR_PHASES: ReadonlyArray<ReconciliationRepairPhase> = [
  {
    name: "import-external-edits",
    handlers: [externalMarkdownEditHandler, externalPlanningEditHandler],
  },
  {
    name: "normalize-db",
    handlers: [
      sketchFlagHandler,
      mergeStateHandler,
      staleWorkerHandler,
      unregisteredMilestoneHandler,
      diskSliceIdDivergenceHandler,
      completedMilestoneReopenedHandler,
      artifactDbStatusDivergenceHandler,
    ],
  },
  {
    name: "re-project",
    handlers: [staleRenderHandler, roadmapDivergenceHandler, completionTimestampHandler],
  },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DRIFT_REGISTRY: ReadonlyArray<DriftHandler<any>> =
  RECONCILIATION_REPAIR_PHASES.flatMap((phase) => phase.handlers);

export function handlerPhaseIndex(kind: string): number {
  return RECONCILIATION_REPAIR_PHASES.findIndex((phase) =>
    phase.handlers.some((handler) => handler.kind === kind),
  );
}
