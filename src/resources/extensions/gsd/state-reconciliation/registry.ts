// Project/App: gsd-pi
// File Purpose: ADR-017 drift handler registry. Single source of truth for
// the catalog. Tests can override per-call via ReconciliationDeps.registry.

import { completionTimestampHandler } from "./drift/completion.js";
import {
  artifactDbStatusDivergenceHandler,
  completedMilestoneReopenedHandler,
  diskSliceIdDivergenceHandler,
} from "./drift/artifact-db.js";
import { mergeStateHandler } from "./drift/merge-state.js";
import { externalMarkdownEditHandler } from "./drift/external-markdown-edit.js";
import { unregisteredMilestoneHandler } from "./drift/project-md.js";
import { roadmapDivergenceHandler } from "./drift/roadmap.js";
import { sketchFlagHandler } from "./drift/sketch-flag.js";
import { staleRenderHandler } from "./drift/stale-render.js";
import { staleWorkerHandler } from "./drift/stale-worker.js";
import type { DriftHandler } from "./types.js";

// Each handler is parameterized over its specific DriftRecord variant for
// internal type safety. The registry stores them under DriftHandler<any> so
// handlers with disjoint repair parameter types coexist; the lifecycle matches
// by kind before invoking repair, so this is sound at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DRIFT_REGISTRY: ReadonlyArray<DriftHandler<any>> = [
  // ⚠ ORDER IS SIGNIFICANT for repairs within a single pass.
  // external-markdown-edit MUST run before any handler that re-projects
  // markdown from DB (stale-render, roadmap-divergence). If a DB-projection
  // handler runs first it overwrites the gsd-core file and the subsequent
  // external-markdown-edit repair imports the already-overwritten content —
  // silently discarding the cross-tool edit. With external-markdown-edit first
  // the DB is updated to reflect the gsd-core edit before stale-render
  // re-renders, so the canonical re-projection preserves the edit's intent.
  externalMarkdownEditHandler,
  sketchFlagHandler,
  mergeStateHandler,
  externalMarkdownEditHandler,
  staleRenderHandler,
  staleWorkerHandler,
  unregisteredMilestoneHandler,
  diskSliceIdDivergenceHandler,
  roadmapDivergenceHandler,
  completedMilestoneReopenedHandler,
  artifactDbStatusDivergenceHandler,
  completionTimestampHandler,
];
