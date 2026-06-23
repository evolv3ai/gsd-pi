import { readFile, writeFile } from "node:fs/promises";
import { GsdRunner, realSpawner, type Spawner } from "../gsd/headless-runner.ts";
import { mapQuerySnapshot, type BridgeStatus } from "../gsd/status-mapper.ts";
import { runExport, type ExportResult } from "./export.ts";

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
  const exportResult: ExportResult = await runExport(htmlPath, { mode: opts.auto ? "auto" : "step", projectRoot: cwd });

  const runner = new GsdRunner({ binary: opts.binary, cwd, spawn: opts.spawn ?? realSpawner });
  await runner.newMilestone(exportResult.specPath, { auto: opts.auto === true });
  const queryResult = await runner.query();
  const status = mapQuerySnapshot(queryResult.json);
  const milestoneId = status.activeMilestone?.id ?? null;

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
