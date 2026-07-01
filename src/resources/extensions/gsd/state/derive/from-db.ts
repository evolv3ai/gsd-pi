// Project/App: gsd-pi
// File Purpose: DB-backed GSD state derivation pipeline stage.

import type { ActiveRef, GSDState, MilestoneRegistryEntry } from '../../types.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { isClosedStatus, isDeferredStatus } from '../../status-guards.js';
import {
  buildMilestoneFileName,
  resolveFile,
  resolveMilestonePath,
} from '../../paths.js';
import {
  getAllMilestones,
  getLatestAssessmentByScope,
  getPendingGateCountForTurn,
  getReplanHistory,
  getRequirementCounts,
  getSlice,
  getSliceTasks,
  getSlicesByMilestoneIds,
} from '../../gsd-db.js';
import type { MilestoneRow } from '../../db-milestone-artifact-rows.js';
import type { SliceRow, TaskRow } from '../../db-task-slice-rows.js';
import {
  classifyMilestoneReadiness,
  readinessNeedsDiscussion,
} from '../../milestone-readiness.js';
import {
  needsAttentionBlockerGuidance as formatNeedsAttentionBlocker,
  needsRemediationBlockerGuidance as formatNeedsRemediationBlocker,
} from '../../guidance.js';
import { detectPendingEscalation } from '../../escalation.js';
import { countUnmappedActiveRequirements, formatCompletePhaseNextAction } from '../../requirements-backlog.js';
import { logWarning } from '../../workflow-logger.js';
import {
  buildDbUnavailableState,
  ensureExistingWorkflowDbOpen,
  getRequestedMilestoneLock,
} from './db-open.js';

const isStatusDone = isClosedStatus;

function stripMilestonePrefix(title: string): string {
  return title.replace(/^M\d+(?:-[a-z0-9]{6})?[^:]*:\s*/, '') || title;
}

function buildCompletenessSet(basePath: string, milestones: MilestoneRow[]) {
  const completeMilestoneIds = new Set<string>();
  const parkedMilestoneIds = new Set<string>();

  // DB-authoritative: a milestone is only "complete" when its DB row says so.
  // SUMMARY-file presence is NOT a completion signal here — an orphan SUMMARY
  // (crashed complete-milestone turn, partial merge, manual edit) must not
  // flip derived state to complete and cascade into a false auto-merge (#4179).
  for (const m of milestones) {
    if (m.status === 'parked') {
      parkedMilestoneIds.add(m.id);
      continue;
    }
    if (isStatusDone(m.status)) {
      completeMilestoneIds.add(m.id);
      continue;
    }
  }
  return { completeMilestoneIds, parkedMilestoneIds };
}

function milestoneArtifactExistsInResolvedDir(
  milestoneDir: string | null,
  milestoneId: string,
  suffix: string,
): boolean {
  if (!milestoneDir) return false;
  const flatPath = join(milestoneDir, buildMilestoneFileName(milestoneId, suffix));
  return existsSync(flatPath) || resolveFile(milestoneDir, milestoneId, suffix) !== null;
}

async function buildRegistryAndFindActive(
  basePath: string,
  milestones: MilestoneRow[],
  completeMilestoneIds: Set<string>,
  parkedMilestoneIds: Set<string>
) {
  const registry: MilestoneRegistryEntry[] = [];
  let activeMilestone: ActiveRef | null = null;
  let activeMilestoneSlices: SliceRow[] = [];
  let activeMilestoneFound = false;
  let activeMilestoneHasDraft = false;
  let firstDeferredQueuedShell: { id: string; title: string; deps: string[]; hasDraftContext: boolean } | null = null;

  const activeMilestoneIds = milestones
    .filter((m) => !parkedMilestoneIds.has(m.id))
    .map((m) => m.id);
  const slicesByMilestone = getSlicesByMilestoneIds(activeMilestoneIds);

  for (const m of milestones) {
    if (parkedMilestoneIds.has(m.id)) {
      registry.push({ id: m.id, title: stripMilestonePrefix(m.title) || m.id, status: 'parked' });
      continue;
    }

    const slices = slicesByMilestone.get(m.id) ?? [];

    // DB-authoritative completeness (#4179): only trust completeMilestoneIds,
    // which is itself derived from DB status. SUMMARY-file presence alone must
    // not imply completion.
    if (completeMilestoneIds.has(m.id)) {
      const title = stripMilestonePrefix(m.title) || m.id;
      registry.push({ id: m.id, title, status: 'complete' });
      continue;
    }

    const allSlicesDone = slices.length > 0 && slices.every(s => isStatusDone(s.status));

    const title = stripMilestonePrefix(m.title) || m.id;
    const milestoneDir = resolveMilestonePath(basePath, m.id);
    const hasContext = milestoneArtifactExistsInResolvedDir(milestoneDir, m.id, "CONTEXT");
    const hasDraftContext = !hasContext && milestoneArtifactExistsInResolvedDir(milestoneDir, m.id, "CONTEXT-DRAFT");
    const readiness = classifyMilestoneReadiness({
      status: m.status,
      hasContext,
      hasDraftContext,
      sliceCount: slices.length,
    });

    if (!activeMilestoneFound) {
      const deps = m.depends_on;
      const depsUnmet = deps.some(dep => !completeMilestoneIds.has(dep));

      if (depsUnmet) {
        registry.push({ id: m.id, title, status: 'pending', dependsOn: deps });
        continue;
      }

      if (readiness.kind === 'queued-shell') {
        if (!firstDeferredQueuedShell) {
          firstDeferredQueuedShell = { id: m.id, title, deps, hasDraftContext: readiness.hasDraftContext };
        }
        registry.push({ id: m.id, title, status: 'pending', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
        continue;
      }

      if (allSlicesDone) {
        activeMilestone = { id: m.id, title };
        activeMilestoneSlices = slices;
        activeMilestoneFound = true;
        registry.push({ id: m.id, title, status: 'active', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
        continue;
      }

      if (readinessNeedsDiscussion(readiness)) activeMilestoneHasDraft = true;

      activeMilestone = { id: m.id, title };
      activeMilestoneSlices = slices;
      activeMilestoneFound = true;
      registry.push({ id: m.id, title, status: 'active', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
    } else {
      const deps = m.depends_on;
      registry.push({ id: m.id, title, status: 'pending', ...(deps.length > 0 ? { dependsOn: deps } : {}) });
    }
  }

  if (!activeMilestoneFound && firstDeferredQueuedShell) {
    const shell = firstDeferredQueuedShell;
    activeMilestone = { id: shell.id, title: shell.title };
    activeMilestoneSlices = [];
    activeMilestoneFound = true;
    if (shell.hasDraftContext) activeMilestoneHasDraft = true;
    const entry = registry.find(e => e.id === shell.id);
    if (entry) entry.status = 'active';
  }

  return { registry, activeMilestone, activeMilestoneSlices, activeMilestoneHasDraft };
}

function handleNoActiveMilestone(
  registry: MilestoneRegistryEntry[],
  requirements: any,
  milestoneProgress: { done: number, total: number }
): GSDState {
  const pendingEntries = registry.filter(e => e.status === 'pending');
  const parkedEntries = registry.filter(e => e.status === 'parked');

  if (pendingEntries.length > 0) {
    const blockerDetails = pendingEntries
      .filter(e => e.dependsOn && e.dependsOn.length > 0)
      .map(e => `${e.id} is waiting on unmet deps: ${e.dependsOn!.join(', ')}`);
    return {
      activeMilestone: null, activeSlice: null, activeTask: null,
      phase: 'blocked',
      recentDecisions: [], blockers: blockerDetails.length > 0
        ? blockerDetails
        : ['All remaining milestones are dep-blocked but no deps listed — check CONTEXT.md files'],
      nextAction: 'Resolve milestone dependencies before proceeding.',
      registry, requirements,
      progress: { milestones: milestoneProgress },
    };
  }

  if (parkedEntries.length > 0) {
    const parkedIds = parkedEntries.map(e => e.id).join(', ');
    return {
      activeMilestone: null, activeSlice: null, activeTask: null,
      phase: 'pre-planning',
      recentDecisions: [], blockers: [],
      nextAction: `All remaining milestones are parked (${parkedIds}). Run /gsd unpark <id> or create a new milestone.`,
      registry, requirements,
      progress: { milestones: milestoneProgress },
    };
  }

  if (registry.length === 0) {
    return {
      activeMilestone: null, activeSlice: null, activeTask: null,
      phase: 'pre-planning',
      recentDecisions: [], blockers: [],
      nextAction: 'No milestones found. Run /gsd to create one.',
      registry: [], requirements,
      progress: { milestones: { done: 0, total: 0 } },
    };
  }

  const lastEntry = registry[registry.length - 1];
  const unmappedActive = countUnmappedActiveRequirements();
  const completionNote = formatCompletePhaseNextAction(unmappedActive);
  return {
    activeMilestone: null,
    lastCompletedMilestone: lastEntry ? { id: lastEntry.id, title: lastEntry.title } : null,
    activeSlice: null, activeTask: null,
    phase: 'complete',
    recentDecisions: [], blockers: [],
    nextAction: completionNote,
    registry, requirements,
    progress: { milestones: milestoneProgress },
  };
}

async function handleAllSlicesDone(
  basePath: string,
  activeMilestone: ActiveRef,
  registry: MilestoneRegistryEntry[],
  requirements: any,
  milestoneProgress: { done: number, total: number },
  sliceProgress: { done: number, total: number }
): Promise<GSDState> {
  const validation = getLatestAssessmentByScope(activeMilestone.id, "milestone-validation");
  const verdict = typeof validation?.status === "string" ? validation.status : undefined;
  const validationTerminal = verdict != null && verdict !== "";

  if (!validationTerminal) {
    return {
      activeMilestone, activeSlice: null, activeTask: null,
      phase: 'validating-milestone',
      recentDecisions: [], blockers: [],
      nextAction: `Validate milestone ${activeMilestone.id} before completion.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress },
    };
  }

  // All roadmap slices are done (enforced by caller) and verdict is
  // needs-remediation — remediation cannot progress without new slices.
  // Return blocked instead of re-dispatching validate-milestone (#4506).
  if (verdict === 'needs-attention') {
    return {
      activeMilestone, activeSlice: null, activeTask: null,
      phase: 'blocked',
      recentDecisions: [],
      blockers: [formatNeedsAttentionBlocker(activeMilestone.id)],
      nextAction: `Resolve ${activeMilestone.id} validation attention before proceeding.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress },
    };
  }

  if (verdict === 'needs-remediation') {
    return {
      activeMilestone, activeSlice: null, activeTask: null,
      phase: 'blocked',
      recentDecisions: [],
      blockers: [formatNeedsRemediationBlocker(activeMilestone.id)],
      nextAction: `Resolve ${activeMilestone.id} remediation before proceeding.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress },
    };
  }

  return {
    activeMilestone, activeSlice: null, activeTask: null,
    phase: 'completing-milestone',
    recentDecisions: [], blockers: [],
    nextAction: `All slices complete in ${activeMilestone.id}. Write milestone summary.`,
    registry, requirements,
    progress: { milestones: milestoneProgress, slices: sliceProgress },
  };
}

function resolveSliceDependencies(activeMilestoneSlices: SliceRow[]): { activeSlice: ActiveRef | null, activeSliceRow: SliceRow | null } {
  const doneSliceIds = new Set(
    activeMilestoneSlices.filter(s => isStatusDone(s.status)).map(s => s.id)
  );

  const sliceLock = process.env.GSD_PARALLEL_WORKER ? process.env.GSD_SLICE_LOCK : undefined;
  if (sliceLock) {
    const lockedSlice = activeMilestoneSlices.find(s => s.id === sliceLock);
    if (lockedSlice) {
      return { activeSlice: { id: lockedSlice.id, title: lockedSlice.title }, activeSliceRow: lockedSlice };
    } else {
      logWarning("state", `GSD_SLICE_LOCK=${sliceLock} not found in active slices — worker has no assigned work`);
      return { activeSlice: null, activeSliceRow: null };
    }
  }

  for (const s of activeMilestoneSlices) {
    if (isStatusDone(s.status)) continue;
    if (isDeferredStatus(s.status)) continue;
    if (s.depends.every(dep => doneSliceIds.has(dep))) {
      return { activeSlice: { id: s.id, title: s.title }, activeSliceRow: s };
    }
  }

  return { activeSlice: null, activeSliceRow: null };
}

async function detectBlockers(basePath: string, milestoneId: string, sliceId: string, tasks: TaskRow[]): Promise<string | null> {
  const completedTasks = tasks.filter(t => isStatusDone(t.status));
  for (const ct of completedTasks) {
    if (ct.blocker_discovered) {
      return ct.id;
    }
  }
  return null;
}

function checkReplanTrigger(basePath: string, milestoneId: string, sliceId: string): boolean {
  const sliceRow = getSlice(milestoneId, sliceId);
  return !!sliceRow?.replan_triggered_at;
}

export async function deriveStateFromDb(
  basePath: string,
  artifactReadRoot: string = basePath,
): Promise<GSDState> {
  if (!ensureExistingWorkflowDbOpen(basePath)) {
    return buildDbUnavailableState();
  }

  const requirements = getRequirementCounts();

  const allMilestones = getAllMilestones();

  const milestoneLock = getRequestedMilestoneLock();
  const milestones = milestoneLock
    ? allMilestones.filter(m => m.id === milestoneLock)
    : allMilestones;

  if (milestones.length === 0) {
    return {
      activeMilestone: null, activeSlice: null, activeTask: null,
      phase: 'pre-planning', recentDecisions: [], blockers: [],
      nextAction: 'No milestones found. Run /gsd to create one.',
      registry: [], requirements,
      progress: { milestones: { done: 0, total: 0 } },
    };
  }

  const { completeMilestoneIds, parkedMilestoneIds } = buildCompletenessSet(basePath, milestones);
  
  const registryContext = await buildRegistryAndFindActive(basePath, milestones, completeMilestoneIds, parkedMilestoneIds);
  const { registry, activeMilestone, activeMilestoneSlices, activeMilestoneHasDraft } = registryContext;
  
  const milestoneProgress = {
    done: registry.filter(e => e.status === 'complete').length,
    total: registry.length,
  };

  if (!activeMilestone) {
    return handleNoActiveMilestone(registry, requirements, milestoneProgress);
  }

  if (activeMilestoneSlices.length === 0) {
    const phase = activeMilestoneHasDraft ? 'needs-discussion' as const : 'pre-planning' as const;
    const nextAction = activeMilestoneHasDraft
      ? `Discuss draft context for milestone ${activeMilestone.id}.`
      : `Plan milestone ${activeMilestone.id}.`;
    return {
      activeMilestone, activeSlice: null, activeTask: null,
      phase, recentDecisions: [], blockers: [],
      nextAction, registry, requirements,
      progress: { milestones: milestoneProgress },
    };
  }

  const allSlicesDone = activeMilestoneSlices.every(s => isStatusDone(s.status));
  const sliceProgress = {
    done: activeMilestoneSlices.filter(s => isStatusDone(s.status)).length,
    total: activeMilestoneSlices.length,
  };

  if (allSlicesDone) {
    return handleAllSlicesDone(basePath, activeMilestone, registry, requirements, milestoneProgress, sliceProgress);
  }

  const activeSliceContext = resolveSliceDependencies(activeMilestoneSlices);
  if (!activeSliceContext.activeSlice) {
    // If locked slice wasn't found, it returns null but logs warning, we need to return 'blocked'
    const sliceLock = process.env.GSD_PARALLEL_WORKER ? process.env.GSD_SLICE_LOCK : undefined;
    if (sliceLock) {
      return {
        activeMilestone, activeSlice: null, activeTask: null,
        phase: 'blocked', recentDecisions: [], blockers: [`GSD_SLICE_LOCK=${sliceLock} not found in active milestone slices`],
        nextAction: 'Slice lock references a non-existent slice — check orchestrator dispatch.',
        registry, requirements,
        progress: { milestones: milestoneProgress, slices: sliceProgress },
      };
    }
    return {
      activeMilestone, activeSlice: null, activeTask: null,
      phase: 'blocked', recentDecisions: [], blockers: ['No slice eligible — check dependency ordering'],
      nextAction: 'Resolve dependency blockers or plan next slice.',
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress },
    };
  }
  const { activeSlice } = activeSliceContext;
  const activeSliceRow = activeSliceContext.activeSliceRow;

  // ADR-011: DB slice metadata is authoritative for sketch refinement.
  // Stale sketch flags (PLAN on disk but is_sketch=1) are repaired by
  // sketchFlagHandler via reconcileBeforeDispatch — not during derivation.
  // PLAN.md and preference flags are projections/configuration and are
  // deliberately not used to infer whether the slice itself is a sketch.
  if (activeSliceRow?.is_sketch === 1) {
    return {
      activeMilestone, activeSlice, activeTask: null,
      phase: 'refining', recentDecisions: [], blockers: [],
      nextAction: `Refine sketch slice ${activeSlice.id} (${activeSlice.title}) using prior slice context.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress },
    };
  }

  const tasks = getSliceTasks(activeMilestone.id, activeSlice.id);
  
  const taskProgress = {
    done: tasks.filter(t => isStatusDone(t.status)).length,
    total: tasks.length,
  };

  const activeTaskRow = tasks.find(t => !isStatusDone(t.status));

  if (!activeTaskRow && tasks.length > 0) {
    return {
      activeMilestone, activeSlice, activeTask: null,
      phase: 'summarizing', recentDecisions: [], blockers: [],
      nextAction: `All tasks done in ${activeSlice.id}. Write slice summary and complete slice.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
    };
  }

  if (!activeTaskRow) {
    return {
      activeMilestone, activeSlice, activeTask: null,
      phase: 'planning', recentDecisions: [], blockers: [],
      nextAction: `Slice ${activeSlice.id} has no DB tasks. Plan slice tasks before execution.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
    };
  }

  const activeTask: ActiveRef = { id: activeTaskRow.id, title: activeTaskRow.title };

  // ── Quality gate evaluation check ──────────────────────────────────
  // Pause before execution only when gates owned by the `gate-evaluate`
  // turn (Q3/Q4) are still pending. Q8 is also `scope:"slice"` but is
  // owned by `complete-slice`, so it must NOT block the evaluating-gates
  // phase — otherwise auto-loop stalls forever waiting for a gate that
  // this turn never evaluates. See gate-registry.ts for the ownership map.
  // Slices with zero gate rows (pre-feature or simple) skip straight through.
  const pendingGateCount = getPendingGateCountForTurn(
    activeMilestone.id,
    activeSlice.id,
    "gate-evaluate",
  );
  if (pendingGateCount > 0) {
    return {
      activeMilestone, activeSlice, activeTask: null,
      phase: 'evaluating-gates', recentDecisions: [], blockers: [],
      nextAction: `Evaluate ${pendingGateCount} quality gate(s) for ${activeSlice.id} before execution.`,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
    };
  }

  const blockerTaskId = await detectBlockers(basePath, activeMilestone.id, activeSlice.id, tasks);
  if (blockerTaskId) {
    const replanHistory = getReplanHistory(activeMilestone.id, activeSlice.id);
    if (replanHistory.length === 0) {
      return {
        activeMilestone, activeSlice, activeTask,
        phase: 'replanning-slice', recentDecisions: [],
        blockers: [`Task ${blockerTaskId} discovered a blocker requiring slice replan`],
        nextAction: `Task ${blockerTaskId} reported blocker_discovered. Replan slice ${activeSlice.id} before continuing.`,
        activeWorkspace: undefined,
        registry, requirements,
        progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
      };
    }
  }

  // ADR-011 Phase 2: pause-on-escalation takes precedence over dispatching the
  // next task. `awaiting_review` tasks (continueWithDefault=true) still pause
  // here so silence is never treated as consent.
  //
  // We do NOT gate this on `phases.mid_execution_escalation` — creation of
  // new escalations is gated at the write site (tools/complete-task.ts:315),
  // but any escalation_pending row already persisted in the DB must be
  // honored even if the user later toggles the flag off. Otherwise those
  // rows would silently orphan, the loop would advance past the paused task,
  // and the user's prior resolution never lands.
  const escalatingTaskId = detectPendingEscalation(tasks, basePath);
  if (escalatingTaskId) {
    return {
      activeMilestone, activeSlice, activeTask,
      phase: 'escalating-task', recentDecisions: [],
      blockers: [`Task ${escalatingTaskId} requires a user decision before the loop can proceed`],
      nextAction: `Run /gsd escalate show ${escalatingTaskId} to review, then /gsd escalate resolve ${escalatingTaskId} <choice> to proceed.`,
      activeWorkspace: undefined,
      registry, requirements,
      progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
    };
  }

  if (!blockerTaskId) {
    const isTriggered = checkReplanTrigger(basePath, activeMilestone.id, activeSlice.id);
    if (isTriggered) {
      const replanHistory = getReplanHistory(activeMilestone.id, activeSlice.id);
      if (replanHistory.length === 0) {
        return {
          activeMilestone, activeSlice, activeTask,
          phase: 'replanning-slice', recentDecisions: [],
          blockers: ['Triage replan trigger detected — slice replan required'],
          nextAction: `Triage replan triggered for slice ${activeSlice.id}. Replan before continuing.`,
          activeWorkspace: undefined,
          registry, requirements,
          progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
        };
      }
    }
  }

  return {
    activeMilestone, activeSlice, activeTask,
    phase: 'executing', recentDecisions: [], blockers: [],
    nextAction: `Execute ${activeTask.id}: ${activeTask.title} in slice ${activeSlice.id}.`,
    registry, requirements,
    progress: { milestones: milestoneProgress, slices: sliceProgress, tasks: taskProgress },
  };
}
