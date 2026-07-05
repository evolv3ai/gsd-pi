import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BridgeStatus } from "./status-mapper.js";

export interface EvalRow {
  loggedAt: string;
  event: "build";
  htmlPath: string;
  specPath: string;
  milestoneId: string | null;
  mode: "auto" | "step";
  phase: string;
  cost: number;
  progress: BridgeStatus["progress"];
  blockerCount: number;
  appliedModels: string[];
  generator: "planf3-gsd-pi";
  generatorVersion: "0.2.0";
}

export function buildEvalRow(input: {
  loggedAt: string;
  htmlPath: string;
  specPath: string;
  milestoneId: string | null;
  mode: "auto" | "step";
  status: BridgeStatus;
  appliedModels: string[];
}): EvalRow {
  return {
    loggedAt: input.loggedAt,
    event: "build",
    htmlPath: input.htmlPath,
    specPath: input.specPath,
    milestoneId: input.milestoneId,
    mode: input.mode,
    phase: input.status.phase,
    cost: input.status.cost,
    progress: input.status.progress,
    blockerCount: input.status.blockers.length,
    appliedModels: input.appliedModels,
    generator: "planf3-gsd-pi",
    generatorVersion: "0.2.0",
  };
}

export async function appendEvalRow(projectRoot: string, row: EvalRow): Promise<void> {
  const dir = join(projectRoot, ".gsd");
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, "planf3-gsd-evals.jsonl"), JSON.stringify(row) + "\n", "utf8");
}
