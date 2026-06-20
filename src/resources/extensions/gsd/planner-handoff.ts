// Project/App: gsd-pi
// File Purpose: Optional gsd-planner handoff after milestone planning.

import { spawn as spawnChild, type ChildProcess, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { gsdRoot } from "./paths.js";

export const PLANNER_HANDOFF_RULE_NAME = "planning review handoff -> gsd-planner";
export const GSD_PLANNER_COMMAND = "gsd-planner";

export interface GsdPlannerSpawnPlan {
  command: string;
  args: string[];
  cwd: string;
}

export interface GsdPlannerLaunchInput {
  basePath: string;
  milestoneId?: string | null;
  extraArgs?: string[];
}

export type GsdPlannerLaunchResult =
  | { status: "launched"; plan: GsdPlannerSpawnPlan }
  | { status: "failed"; plan: GsdPlannerSpawnPlan; error: Error };

type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface GsdPlannerLaunchDeps {
  spawn?: SpawnLike;
}

function handoffDir(basePath: string): string {
  return join(gsdRoot(basePath), "runtime", "planner-handoffs");
}

function safeMilestoneFileSegment(milestoneId: string): string {
  return milestoneId.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
}

function handoffMarkerPath(basePath: string, milestoneId: string): string {
  return join(handoffDir(basePath), `${safeMilestoneFileSegment(milestoneId)}.json`);
}

export function hasPlannerHandoffBeenOffered(basePath: string, milestoneId: string): boolean {
  return existsSync(handoffMarkerPath(basePath, milestoneId));
}

export function markPlannerHandoffOffered(
  basePath: string,
  milestoneId: string,
  source: "auto" | "command" = "auto",
): void {
  mkdirSync(handoffDir(basePath), { recursive: true });
  writeFileSync(
    handoffMarkerPath(basePath, milestoneId),
    JSON.stringify({
      milestoneId,
      source,
      offeredAt: new Date().toISOString(),
    }, null, 2) + "\n",
    "utf-8",
  );
}

export function buildGsdPlannerSpawnPlan(input: GsdPlannerLaunchInput): GsdPlannerSpawnPlan {
  const args = ["--project", input.basePath];
  const milestoneId = input.milestoneId?.trim();
  if (milestoneId) args.push("--milestone", milestoneId);
  args.push(...(input.extraArgs ?? []));
  return {
    command: GSD_PLANNER_COMMAND,
    args,
    cwd: input.basePath,
  };
}

function quoteArg(arg: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

export function formatGsdPlannerCommand(plan: GsdPlannerSpawnPlan): string {
  return [plan.command, ...plan.args].map(quoteArg).join(" ");
}

export async function launchGsdPlanner(
  input: GsdPlannerLaunchInput,
  deps: GsdPlannerLaunchDeps = {},
): Promise<GsdPlannerLaunchResult> {
  const plan = buildGsdPlannerSpawnPlan(input);
  const spawn = deps.spawn ?? spawnChild;

  let child: ChildProcess;
  try {
    child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (err) {
    return {
      status: "failed",
      plan,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: GsdPlannerLaunchResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.once("error", (err) => {
      settle({
        status: "failed",
        plan,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    });
    child.once("spawn", () => {
      child.unref();
      settle({ status: "launched", plan });
    });
  });
}

export function formatPlannerHandoffPauseReason(milestoneId: string): string {
  return [
    `Milestone ${milestoneId} is planned. Review or customize the plan before implementation if needed.`,
    `Run /gsd planner to launch ${GSD_PLANNER_COMMAND}, or run /gsd auto to continue without planner changes.`,
  ].join(" ");
}

export function formatPlannerLaunchUnavailable(plan: GsdPlannerSpawnPlan, error: Error): string {
  return [
    `Could not launch ${GSD_PLANNER_COMMAND}: ${error.message}`,
    `Install ${GSD_PLANNER_COMMAND} or run it manually: ${formatGsdPlannerCommand(plan)}`,
  ].join("\n");
}
