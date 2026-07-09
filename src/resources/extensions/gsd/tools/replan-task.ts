import { clearParseCache } from "../files.js";
import {
  getSlice,
  getTask,
  insertReplanHistory,
  transaction,
  upsertTaskPlanning,
} from "../gsd-db.js";
import { invalidateStateCache } from "../state.js";
import { isClosedStatus } from "../status-guards.js";
import { isNonEmptyString, validateStringArray } from "../validation.js";
import { renderPlanFromDb, renderTaskPlanFromDb } from "../markdown-renderer.js";
import { resolveMilestonePath, resolveSlicePath } from "../paths.js";
import { flushWorkflowProjections } from "../projection-flush.js";
import { writeManifest } from "../workflow-manifest.js";
import { appendEvent } from "../workflow-events.js";
import { logWarning } from "../workflow-logger.js";

export interface ReplanTaskParams {
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
  reworkBriefRef?: string;
  fullPlanMd?: string;
  actorName?: string;
  triggerReason?: string;
}

export interface ReplanTaskResult {
  milestoneId: string;
  sliceId: string;
  taskId: string;
  taskPlanPath: string;
}

function validateParams(params: ReplanTaskParams): ReplanTaskParams {
  if (!isNonEmptyString(params?.milestoneId)) throw new Error("milestoneId is required");
  if (!isNonEmptyString(params?.sliceId)) throw new Error("sliceId is required");
  if (!isNonEmptyString(params?.taskId)) throw new Error("taskId is required");
  if (!isNonEmptyString(params?.title)) throw new Error("title is required");
  if (!isNonEmptyString(params?.description)) throw new Error("description is required");
  if (!isNonEmptyString(params?.estimate)) throw new Error("estimate is required");
  if (!isNonEmptyString(params?.verify)) throw new Error("verify is required");
  return {
    ...params,
    files: validateStringArray(params.files, "files"),
    inputs: validateStringArray(params.inputs, "inputs"),
    expectedOutput: validateStringArray(params.expectedOutput, "expectedOutput"),
  };
}

function replanSummary(params: ReplanTaskParams): string {
  const ref = params.reworkBriefRef?.trim();
  return ref
    ? `Task ${params.taskId} replanned from rework brief ${ref}`
    : `Task ${params.taskId} replanned`;
}

export async function handleReplanTask(
  rawParams: ReplanTaskParams,
  basePath: string,
): Promise<ReplanTaskResult | { error: string }> {
  let params: ReplanTaskParams;
  try {
    params = validateParams(rawParams);
  } catch (err) {
    return { error: `validation failed: ${(err as Error).message}` };
  }

  let guardError: string | null = null;
  try {
    transaction(() => {
      const parentSlice = getSlice(params.milestoneId, params.sliceId);
      if (!parentSlice) {
        guardError = `missing parent slice: ${params.milestoneId}/${params.sliceId}`;
        return;
      }
      if (isClosedStatus(parentSlice.status)) {
        guardError = `cannot replan a task in a closed slice: ${params.sliceId} (status: ${parentSlice.status})`;
        return;
      }

      const task = getTask(params.milestoneId, params.sliceId, params.taskId);
      if (!task) {
        guardError = `task not found: ${params.milestoneId}/${params.sliceId}/${params.taskId}`;
        return;
      }
      if (isClosedStatus(task.status)) {
        guardError = `cannot replan completed task ${params.taskId} — use gsd_task_reopen first`;
        return;
      }

      upsertTaskPlanning(params.milestoneId, params.sliceId, params.taskId, {
        title: params.title,
        description: params.description,
        estimate: params.estimate,
        files: params.files,
        verify: params.verify,
        inputs: params.inputs,
        expectedOutput: params.expectedOutput,
        fullPlanMd: params.fullPlanMd,
      });
      insertReplanHistory({
        milestoneId: params.milestoneId,
        sliceId: params.sliceId,
        taskId: params.taskId,
        summary: replanSummary(params),
        previousArtifactPath: params.reworkBriefRef ?? null,
      });
    });
  } catch (err) {
    return { error: `db write failed: ${(err as Error).message}` };
  }

  if (guardError) return { error: guardError };

  try {
    const milestonePath = resolveMilestonePath(basePath, params.milestoneId);
    const slicePath = resolveSlicePath(basePath, params.milestoneId, params.sliceId);
    const isLegacySliceLayout = Boolean(milestonePath && slicePath && slicePath !== milestonePath);
    const renderResult = isLegacySliceLayout
      ? await renderTaskPlanFromDb(basePath, params.milestoneId, params.sliceId, params.taskId)
      : await renderPlanFromDb(basePath, params.milestoneId, params.sliceId);
    const taskPlanPath = "taskPlanPath" in renderResult ? renderResult.taskPlanPath : renderResult.planPath;

    invalidateStateCache();
    clearParseCache();

    try {
      await flushWorkflowProjections(basePath, { milestoneId: params.milestoneId });
      writeManifest(basePath);
      appendEvent(basePath, {
        cmd: "replan-task",
        params: { milestoneId: params.milestoneId, sliceId: params.sliceId, taskId: params.taskId },
        ts: new Date().toISOString(),
        actor: "agent",
        actor_name: params.actorName,
        trigger_reason: params.triggerReason,
      });
    } catch (hookErr) {
      logWarning("tool", `replan-task post-mutation hook warning: ${(hookErr as Error).message}`);
    }

    return {
      milestoneId: params.milestoneId,
      sliceId: params.sliceId,
      taskId: params.taskId,
      taskPlanPath,
    };
  } catch (err) {
    return { error: `render failed: ${(err as Error).message}` };
  }
}
