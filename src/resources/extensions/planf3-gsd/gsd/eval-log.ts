import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BridgeStatus } from "./status-mapper.js";
import { GENERATOR_VERSION } from "../version.js";

export interface EvalRow {
  loggedAt: string;
  /** "build" = how a build command ended; "status" = completion observed at status time. */
  event: "build" | "status";
  htmlPath: string;
  specPath: string;
  milestoneId: string | null;
  mode: "auto" | "step";
  phase: string;
  cost: number;
  progress: BridgeStatus["progress"];
  blockerCount: number;
  /** Bucket keys the build applied to .gsd/PREFERENCES.md (e.g. "planning"). */
  appliedBuckets: string[];
  /** bucket → model id for exactly those buckets. */
  appliedModels: Record<string, string>;
  /** Enforced-lite outcome for build rows: ok | forced | absent | drift. */
  presets?: "ok" | "forced" | "absent" | "drift";
  /** projectionHash the build ran under (or was refused at). */
  presetsHash?: string | null;
  generator: "planf3-gsd-pi";
  generatorVersion: string;
}

export function buildEvalRow(input: {
  loggedAt: string;
  htmlPath: string;
  specPath: string;
  milestoneId: string | null;
  mode: "auto" | "step";
  status: BridgeStatus;
  appliedBuckets: string[];
  appliedModels: Record<string, string>;
  event?: "build" | "status";
  presets?: EvalRow["presets"];
  presetsHash?: string | null;
}): EvalRow {
  return {
    loggedAt: input.loggedAt,
    event: input.event ?? "build",
    htmlPath: input.htmlPath,
    specPath: input.specPath,
    milestoneId: input.milestoneId,
    mode: input.mode,
    phase: input.status.phase,
    cost: input.status.cost,
    progress: input.status.progress,
    blockerCount: input.status.blockers.length,
    appliedBuckets: input.appliedBuckets,
    appliedModels: input.appliedModels,
    ...(input.presets !== undefined ? { presets: input.presets } : {}),
    ...(input.presetsHash !== undefined ? { presetsHash: input.presetsHash } : {}),
    generator: "planf3-gsd-pi",
    generatorVersion: GENERATOR_VERSION,
  };
}

/** M4 control rows: steer redirects paid work and stop abandons it — both
 *  belong in the eval ledger for cost attribution. Pause/resume do not
 *  (flow control, no spend consequence). cost is 0 structurally
 *  (claude-code), or the observed cost when the runner reports one — the
 *  v0.3.3 convention. */
export interface ControlEvalRow {
  loggedAt: string;
  event: "steer" | "stop";
  htmlPath: string | null;
  specPath: string | null;
  milestoneId: string | null;
  /** steer only: the instruction, verbatim. */
  steerText?: string;
  exitCode: number;
  cost: number;
  generator: "planf3-gsd-pi";
  generatorVersion: string;
}

export function buildControlEvalRow(input: {
  loggedAt: string;
  event: "steer" | "stop";
  htmlPath: string | null;
  specPath: string | null;
  milestoneId: string | null;
  steerText?: string;
  exitCode: number;
  cost?: number;
}): ControlEvalRow {
  return {
    loggedAt: input.loggedAt,
    event: input.event,
    htmlPath: input.htmlPath,
    specPath: input.specPath,
    milestoneId: input.milestoneId,
    ...(input.steerText !== undefined ? { steerText: input.steerText } : {}),
    exitCode: input.exitCode,
    cost: input.cost ?? 0,
    generator: "planf3-gsd-pi",
    generatorVersion: GENERATOR_VERSION,
  };
}

export async function appendEvalRow(projectRoot: string, row: EvalRow | ControlEvalRow): Promise<void> {
  const dir = join(projectRoot, ".gsd");
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "planf3-gsd-evals.jsonl"), JSON.stringify(row) + "\n", "utf8");
}

/** True when a completion ("status") row for this milestone already exists. */
export async function hasStatusRowFor(projectRoot: string, milestoneId: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(join(projectRoot, ".gsd", "planf3-gsd-evals.jsonl"), "utf8");
  } catch {
    return false; // no log yet
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { event?: string; milestoneId?: string | null };
      if (row.event === "status" && row.milestoneId === milestoneId) return true;
    } catch {
      // skip malformed line
    }
  }
  return false;
}
