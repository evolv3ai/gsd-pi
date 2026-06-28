// Project/App: gsd-pi
// File Purpose: Workflow DB open helpers for state derivation.

import type { GSDState } from '../../types.js';
import { getAllMilestones, isDbAvailable, setMilestoneQueueOrder } from '../../gsd-db.js';
import { openExistingWorkflowDatabase } from '../../db-workspace.js';
import { loadQueueOrder, sortByQueueOrder } from '../../queue-order.js';

export function syncQueueOrderProjectionToDb(basePath: string): void {
  const queueOrder = loadQueueOrder(basePath);
  if (!queueOrder) return;

  const currentIds = getAllMilestones().map((m) => m.id);
  const desiredIds = sortByQueueOrder(currentIds, queueOrder);
  if (currentIds.length === desiredIds.length && currentIds.every((id, i) => id === desiredIds[i])) return;

  setMilestoneQueueOrder(desiredIds);
}

export function ensureExistingWorkflowDbOpen(basePath: string): boolean {
  const opened = isDbAvailable() || openExistingWorkflowDatabase(basePath).ok;
  if (opened) syncQueueOrderProjectionToDb(basePath);
  return opened;
}

export function buildDbUnavailableState(): GSDState {
  return {
    activeMilestone: null,
    activeSlice: null,
    activeTask: null,
    phase: "pre-planning",
    recentDecisions: [],
    blockers: ["DB unavailable — runtime markdown state derivation is disabled"],
    nextAction:
      "Open or create the canonical GSD database before deriving workflow state. If this project only has markdown state, run /gsd migrate explicitly.",
    registry: [],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 0 } },
  };
}

export function getRequestedMilestoneLock(): string | undefined {
  const lock = process.env.GSD_MILESTONE_LOCK?.trim();
  return lock || undefined;
}
