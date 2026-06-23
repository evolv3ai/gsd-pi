import { readFile, writeFile } from "node:fs/promises";
import { GsdRunner, type Spawner } from "../gsd/headless-runner.js";
import { realSpawner } from "../gsd/real-spawner.js";
import { mapQuerySnapshot, type BridgeStatus } from "../gsd/status-mapper.js";
import { runExport, type ExportResult } from "./export.js";
import { friendlyError } from "./error-message.js";

export interface BuildResult {
  specPath: string;
  manifestPath: string;
  milestoneId: string | null;
  status: BridgeStatus;
}

export interface BuildOptions {
  auto?: boolean;
  binary?: string;
  cwd?: string;
  spawn?: Spawner;
}

export async function runBuild(htmlPath: string, opts: BuildOptions = {}): Promise<BuildResult> {
  const cwd = opts.cwd ?? process.cwd();
  let exportResult: ExportResult;
  try {
    exportResult = await runExport(htmlPath, { mode: opts.auto ? "auto" : "step", projectRoot: cwd });
  } catch (err) {
    throw new Error(friendlyError(err));
  }

  const runner = new GsdRunner({ binary: opts.binary, cwd, spawn: opts.spawn ?? realSpawner });
  try {
    await runner.newMilestone(exportResult.specPath, { auto: opts.auto === true });
  } catch (err) {
    throw new Error(friendlyError(err, opts.binary ?? "gsd"));
  }

  let queryResult;
  try {
    queryResult = await runner.query();
  } catch (err) {
    throw new Error(friendlyError(err, opts.binary ?? "gsd"));
  }

  const status = mapQuerySnapshot(queryResult.json);

  // A1: In auto mode, newMilestone blocks until the run completes, so
  // activeMilestone is null afterwards. Fall back to lastCompletedMilestone.
  const milestoneId = status.activeMilestone?.id ?? status.lastCompletedMilestone?.id ?? null;

  if (milestoneId) {
    const manifestText = await readFile(exportResult.manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    manifest.gsd.milestoneId = milestoneId;
    await writeFile(exportResult.manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }

  return {
    specPath: exportResult.specPath,
    manifestPath: exportResult.manifestPath,
    milestoneId,
    status,
  };
}
