import { clearParseCache } from "../files.js";
import { isClosedStatus } from "../status-guards.js";
import { isNonEmptyString, validateStringArray } from "../validation.js";
import { getGateIdsForTurn } from "../gate-registry.js";
import { transaction, getSlice, getTask, insertTask, upsertTaskPlanning, insertGateRow, setSliceSketchFlag } from "../gsd-db.js";
import { invalidateStateCache } from "../state.js";
import { renderTaskPlanFromDb, renderPlanFromDb } from "../markdown-renderer.js";
import { resolveTasksDir } from "../paths.js";
import { flushWorkflowProjections } from "../projection-flush.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";
import { loadEffectiveGSDPreferences } from "../preferences.js";
import { validatePathOnlyPlanningFields, validatePlanningPathScope } from "../planning-path-scope.js";
import type { GateId } from "../types.js";

export interface PlanTaskParams {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  title: string;
  description: string;
  estimate: string;
  files: string[];
  verify: string;
  inputs: string[];
  expectedOutput: string[];
  observabilityImpact?: string;
  fullPlanMd?: string;
  /** Optional caller-provided identity for audit trail */
  actorName?: string;
  /** Optional caller-provided reason this action was triggered */
  triggerReason?: string;
}

export interface PlanTaskResult {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  taskPlanPath: string;
}

function validateParams(params: PlanTaskParams): PlanTaskParams {
  if (!isNonEmptyString(params?.milestoneId)) throw new Error("milestoneId is required");
  if (!isNonEmptyString(params?.sliceId)) throw new Error("sliceId is required");
  if (!isNonEmptyString(params?.taskId)) throw new Error("taskId is required");
  if (!isNonEmptyString(params?.title)) throw new Error("title is required");
  if (!isNonEmptyString(params?.description)) throw new Error("description is required");
  if (!isNonEmptyString(params?.estimate)) throw new Error("estimate is required");
  if (!isNonEmptyString(params?.verify)) throw new Error("verify is required");
  if (params.observabilityImpact !== undefined && !isNonEmptyString(params.observabilityImpact)) {
    throw new Error("observabilityImpact must be a non-empty string when provided");
  }

  return {
    ...params,
    files: validateStringArray(params.files, "files"),
    inputs: validateStringArray(params.inputs, "inputs"),
    expectedOutput: validateStringArray(params.expectedOutput, "expectedOutput"),
  };
}

function resolveTaskGates(basePath: string): GateId[] {
  const loaded = loadEffectiveGSDPreferences(basePath);
  if (loaded?.preferences?.gate_evaluation?.task_gates === false) return [];
  return [...getGateIdsForTurn("execute-task")];
}

export async function handlePlanTask(
  rawParams: PlanTaskParams,
  basePath: string,
): Promise<PlanTaskResult | { error: string }> {
  let params: PlanTaskParams;
  try {
    params = validateParams(rawParams);
  } catch (err) {
    return { error: `validation failed: ${(err as Error).message}` };
  }

  const pathOnlyError = validatePathOnlyPlanningFields([
    { field: "expectedOutput", values: params.expectedOutput },
  ]);
  if (pathOnlyError) {
    return { error: `validation failed: ${pathOnlyError}` };
  }

  const pathScopeError = validatePlanningPathScope(basePath, [
    { field: "files", values: params.files },
    { field: "inputs", values: params.inputs },
    { field: "expectedOutput", values: params.expectedOutput },
  ]);
  if (pathScopeError) {
    return { error: `validation failed: ${pathScopeError}` };
  }

  let taskGates: GateId[];
  try {
    taskGates = resolveTaskGates(basePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `validation failed: ${message}` };
  }

  // ── Guards + DB writes inside a single transaction (prevents TOCTOU) ───
  // Guards must be inside the transaction so the state they check cannot
  // change between the read and the write (#2723).
  let guardError: string | null = null;

  try {
    transaction(() => {
      const parentSlice = getSlice(params.milestoneId, params.sliceId);
      if (!parentSlice) {
        guardError = `missing parent slice: ${params.milestoneId}/${params.sliceId}`;
        return;
      }
      if (isClosedStatus(parentSlice.status)) {
        guardError = `cannot plan task in a closed slice: ${params.sliceId} (status: ${parentSlice.status})`;
        return;
      }

      const existingTask = getTask(params.milestoneId, params.sliceId, params.taskId);
      if (existingTask && isClosedStatus(existingTask.status)) {
        guardError = `cannot re-plan task ${params.taskId}: it is already complete — use gsd_task_reopen first`;
        return;
      }

      if (!existingTask) {
        insertTask({
          id: params.taskId,
          sliceId: params.sliceId,
          milestoneId: params.milestoneId,
          title: params.title,
          status: "pending",
        });
      }
      upsertTaskPlanning(params.milestoneId, params.sliceId, params.taskId, {
        title: params.title,
        description: params.description,
        estimate: params.estimate,
        files: params.files,
        verify: params.verify,
        inputs: params.inputs,
        expectedOutput: params.expectedOutput,
        observabilityImpact: params.observabilityImpact ?? "",
        fullPlanMd: params.fullPlanMd,
      });
      for (const gid of taskGates) {
        insertGateRow({ milestoneId: params.milestoneId, sliceId: params.sliceId, gateId: gid, scope: "task", taskId: params.taskId });
      }
    });
  } catch (err) {
    return { error: `db write failed: ${(err as Error).message}` };
  }

  if (guardError) {
    return { error: guardError };
  }

  try {
    const renderResult = await renderTaskPlanFromDb(basePath, params.milestoneId, params.sliceId, params.taskId);

    // Flat-phase: tasks live as checkboxes in the slice plan's <tasks> block,
    // not as standalone TID-PLAN.md files. Re-render the slice plan so the
    // new/updated task appears in the plan file that gsd-core reads.
    // Guard: resolveTasksDir is null in flat-phase (no tasks/ subdir exists).
    let slicePlanSynced = false;
    try {
      const tDir = resolveTasksDir(basePath, params.milestoneId, params.sliceId);
      if (!tDir) {
        await renderPlanFromDb(basePath, params.milestoneId, params.sliceId);
        slicePlanSynced = true;
      }
    } catch (syncErr) {
      logWarning("tool", `plan-task: slice-plan sync failed: ${(syncErr as Error).message}`);
    }

    if (slicePlanSynced) {
      setSliceSketchFlag(params.milestoneId, params.sliceId, false);
    }

    invalidateStateCache();
    clearParseCache();

    // ── Post-mutation hook: projections, manifest, event log ─────────────
    try {
      await flushWorkflowProjections(basePath, { milestoneId: params.milestoneId });
      writeManifest(basePath);
      appendEvent(basePath, {
        cmd: "plan-task",
        params: { milestoneId: params.milestoneId, sliceId: params.sliceId, taskId: params.taskId },
        ts: new Date().toISOString(),
        actor: "agent",
        actor_name: params.actorName,
        trigger_reason: params.triggerReason,
      });
    } catch (hookErr) {
      logWarning("tool", `plan-task post-mutation hook warning: ${(hookErr as Error).message}`);
    }

    return {
      milestoneId: params.milestoneId,
      sliceId: params.sliceId,
      taskId: params.taskId,
      taskPlanPath: renderResult.taskPlanPath,
    };
  } catch (err) {
    return { error: `render failed: ${(err as Error).message}` };
  }
}
