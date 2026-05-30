// Project/App: gsd-pi
// File Purpose: Shared closeout detection and merge actions for /gsd home and smart entry.

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import type { NextAction } from "../shared/next-action-ui.js";
import type { GSDState } from "./types.js";
import { invalidateAllCaches } from "./cache.js";
import { mergeCompletedMilestone } from "./parallel-merge.js";
import { cleanupQuickBranch, detectStrandedQuickBranch, type StrandedQuickBranch } from "./quick.js";
import {
  findUnmergedCompletedMilestones,
  type UnmergedMilestoneBlocker,
} from "./unmerged-milestone-guard.js";
import { appendRequirementsBacklogToSummary } from "./requirements-backlog.js";

export type CloseoutActionId = "finish_quick" | "finish_milestone";

export interface CloseoutContext {
  strandedQuick: StrandedQuickBranch | null;
  unmergedMilestones: UnmergedMilestoneBlocker[];
}

export async function loadCloseoutContext(basePath: string): Promise<CloseoutContext> {
  const unmergedMilestones = await findUnmergedCompletedMilestones(basePath);
  return {
    strandedQuick: detectStrandedQuickBranch(basePath),
    unmergedMilestones,
  };
}

export function getPrimaryCloseoutRecommendation(
  closeout: CloseoutContext,
): CloseoutActionId | null {
  if (closeout.strandedQuick) return "finish_quick";
  if (closeout.unmergedMilestones.length > 0) return "finish_milestone";
  return null;
}

export function buildCloseoutMenuActions(closeout: CloseoutContext): NextAction[] {
  const actions: NextAction[] = [];
  const primary = getPrimaryCloseoutRecommendation(closeout);

  if (closeout.strandedQuick) {
    const quick = closeout.strandedQuick;
    actions.push({
      id: "finish_quick",
      label: "Merge quick task",
      description: `Squash-merge Q${quick.taskNum} from ${quick.quickBranch} into ${quick.originalBranch}.`,
      recommended: primary === "finish_quick",
    });
  }

  if (closeout.unmergedMilestones.length > 0) {
    const blocker = closeout.unmergedMilestones[0];
    actions.push({
      id: "finish_milestone",
      label: "Merge milestone",
      description: `Merge ${blocker.milestoneId} from ${blocker.branch} into ${blocker.integrationBranch}.`,
      recommended: primary === "finish_milestone",
    });
  }

  return actions;
}

export function buildIdleMenuSummary(state: GSDState, closeout: CloseoutContext): string[] {
  if (closeout.strandedQuick) {
    const quick = closeout.strandedQuick;
    return [
      `Quick task Q${quick.taskNum} finished on ${quick.quickBranch} but is not merged to ${quick.originalBranch}.`,
    ];
  }

  if (closeout.unmergedMilestones.length > 0) {
    const blocker = closeout.unmergedMilestones[0];
    return [
      `${blocker.milestoneId} is complete but not merged into ${blocker.integrationBranch}.`,
    ];
  }

  if (state.phase === "complete") {
    const last = state.lastCompletedMilestone;
    return appendRequirementsBacklogToSummary(state, [
      last
        ? `All milestones complete after ${last.id}: ${last.title}.`
        : "All milestones complete.",
    ]);
  }

  return [state.nextAction || "No active milestone."];
}

export async function runMergeQuickTask(
  ctx: ExtensionCommandContext,
  basePath: string,
  strandedQuick?: StrandedQuickBranch | null,
): Promise<boolean> {
  const merged = cleanupQuickBranch(basePath);
  if (merged) {
    ctx.ui.notify(
      `Merged quick task Q${strandedQuick?.taskNum ?? "?"} into ${strandedQuick?.originalBranch ?? "main"}.`,
      "info",
    );
    invalidateAllCaches();
    return true;
  }

  ctx.ui.notify(
    "Could not merge the quick-task branch automatically. Run `git status`, resolve any conflicts, then retry /gsd.",
    "error",
  );
  return false;
}

export async function runMergeMilestone(
  ctx: ExtensionCommandContext,
  basePath: string,
  milestoneId?: string,
): Promise<boolean> {
  const blockers = await findUnmergedCompletedMilestones(basePath);
  const blocker = milestoneId
    ? blockers.find((candidate) => candidate.milestoneId === milestoneId)
    : blockers[0];
  if (!blocker) {
    ctx.ui.notify("No unmerged completed milestone found.", "warning");
    return false;
  }

  ctx.ui.notify(
    `Completing preserved milestone merge for ${blocker.milestoneId} from ${blocker.branch} into ${blocker.integrationBranch}.`,
    "info",
  );
  const result = await mergeCompletedMilestone(basePath, blocker.milestoneId);
  if (result.success) {
    ctx.ui.notify(
      `Milestone ${blocker.milestoneId} merged to ${blocker.integrationBranch}. Run /gsd again when ready.`,
      "info",
    );
    invalidateAllCaches();
    return true;
  }

  ctx.ui.notify(
    `Milestone ${blocker.milestoneId} merge failed: ${result.error ?? "unknown error"}`,
    "error",
  );
  return false;
}

export async function handleCloseoutChoice(
  ctx: ExtensionCommandContext,
  basePath: string,
  choice: string,
  closeout: CloseoutContext,
): Promise<boolean> {
  if (choice === "finish_quick") {
    return runMergeQuickTask(ctx, basePath, closeout.strandedQuick);
  }
  if (choice === "finish_milestone") {
    return runMergeMilestone(ctx, basePath, closeout.unmergedMilestones[0]?.milestoneId);
  }
  return false;
}
