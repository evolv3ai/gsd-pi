// GSD auto-mode runtime state
import { AutoSession } from "./auto/session.js";
import type { CurrentUnit } from "./auto/session.js";
import type { SourceObservationStore } from "./source-observations.js";
import {
  isDeterministicPolicyError,
  isQueuedUserMessageSkip,
  isToolInvocationError,
  markToolEnd as markTrackedToolEnd,
  markToolStart as markTrackedToolStart,
} from "./auto-tool-tracking.js";
// Re-exported as a pure pass-through. Must stay UNGATED (no autoSession.active
// argument, unlike markToolStart at the bottom of this file) so it is true in
// foreground where the foreground approval-gate pause consults it.
export { isInteractiveElicitationInFlight } from "./auto-tool-tracking.js";
import {
  createToolSurfaceSnapshot,
  type ToolSurfaceSnapshot,
  type ToolSurfaceSnapshotInput,
} from "./tool-surface-snapshot.js";

export type {
  ToolSurfaceSnapshot,
  ToolSurfaceSnapshotInput,
} from "./tool-surface-snapshot.js";

export const autoSession = new AutoSession();
let currentToolSurfaceSnapshot: ToolSurfaceSnapshot | null = null;

export type AutoRuntimeSnapshot = {
  active: boolean;
  paused: boolean;
  currentUnit: CurrentUnit | null;
  basePath: string;
  orchestrationPhase?: "idle" | "running" | "paused" | "stopped" | "error";
  orchestrationTransitionCount?: number;
  orchestrationLastTransitionAt?: number;
  toolSurface: ToolSurfaceSnapshot | null;
};

export function getAutoRuntimeSnapshot(): AutoRuntimeSnapshot {
  const orchestrationStatus = autoSession.orchestration?.getStatus();
  return {
    active: autoSession.active,
    paused: autoSession.paused,
    currentUnit: autoSession.currentUnit ? { ...autoSession.currentUnit } : null,
    basePath: autoSession.basePath,
    orchestrationPhase: orchestrationStatus?.phase,
    orchestrationTransitionCount: orchestrationStatus?.transitionCount,
    orchestrationLastTransitionAt: orchestrationStatus?.lastTransitionAt,
    toolSurface: autoSession.active || autoSession.paused ? currentToolSurfaceSnapshot : null,
  };
}

export function recordAutoToolSurfaceSnapshot(input: ToolSurfaceSnapshotInput): ToolSurfaceSnapshot {
  currentToolSurfaceSnapshot = createToolSurfaceSnapshot(input);
  return currentToolSurfaceSnapshot;
}

export function clearAutoToolSurfaceSnapshot(): void {
  currentToolSurfaceSnapshot = null;
}

export function isAutoActive(): boolean {
  return autoSession.active;
}

export function isAutoPaused(): boolean {
  return autoSession.paused;
}

export function isAutoCompletionStopInProgress(): boolean {
  return autoSession.completionStopInProgress;
}

export function clearAutoCompletionStopInProgress(): void {
  autoSession.completionStopInProgress = false;
}

export function markToolStart(toolCallId: string, toolName?: string): void {
  markTrackedToolStart(toolCallId, autoSession.active, toolName);
}

export function markToolEnd(toolCallId: string): void {
  markTrackedToolEnd(toolCallId);
}

export function recordToolInvocationError(toolName: string, errorMsg: string): void {
  if (!autoSession.active) return;
  if (isToolInvocationError(errorMsg) || isQueuedUserMessageSkip(errorMsg) || isDeterministicPolicyError(errorMsg)) {
    autoSession.lastToolInvocationError = `${toolName}: ${errorMsg}`;
  }
}

export function clearToolInvocationError(): void {
  if (!autoSession.active) return;
  autoSession.lastToolInvocationError = null;
}

export function getSourceObservationStore(): SourceObservationStore {
  return autoSession.sourceObservations;
}
