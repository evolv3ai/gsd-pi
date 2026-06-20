// Project/App: gsd-pi
// File Purpose: Typed snapshots for model-facing, registered, scoped, and presented tool surfaces.

export type ToolSurfaceSnapshotSource =
  | "runtime-scope"
  | "dispatch-scope"
  | "provider-adjustment"
  | "presentation-plan";

export interface ToolSurfaceSnapshot {
  source: ToolSurfaceSnapshotSource;
  unitType?: string;
  phase?: string;
  modelFacingToolNames: string[];
  registeredToolNames: string[];
  scopedToolNames: string[];
  presentedToolNames: string[];
  capturedAt: number;
}

export interface ToolSurfaceSnapshotInput {
  source: ToolSurfaceSnapshotSource;
  unitType?: string;
  phase?: string;
  modelFacingToolNames?: readonly string[];
  registeredToolNames?: readonly string[];
  scopedToolNames?: readonly string[];
  presentedToolNames?: readonly string[];
  capturedAt?: number;
}

function dedupeToolNames(toolNames: readonly string[] | undefined): string[] {
  return [...new Set(toolNames ?? [])];
}

export function createToolSurfaceSnapshot(input: ToolSurfaceSnapshotInput): ToolSurfaceSnapshot {
  return {
    source: input.source,
    unitType: input.unitType,
    phase: input.phase,
    modelFacingToolNames: dedupeToolNames(input.modelFacingToolNames),
    registeredToolNames: dedupeToolNames(input.registeredToolNames),
    scopedToolNames: dedupeToolNames(input.scopedToolNames),
    presentedToolNames: dedupeToolNames(input.presentedToolNames),
    capturedAt: input.capturedAt ?? Date.now(),
  };
}
