import { readFile, writeFile } from "node:fs/promises";
import { GsdRunner, type Spawner } from "../gsd/headless-runner.js";
import { realSpawner } from "../gsd/real-spawner.js";
import { mapQuerySnapshot, type BridgeStatus } from "../gsd/status-mapper.js";
import { applyPreferencesOverlay } from "../gsd/preferences-overlay.js";
import { buildEvalRow, appendEvalRow } from "../gsd/eval-log.js";
import { runExport, type ExportResult } from "./export.js";
import { friendlyError } from "./error-message.js";

export interface PrefsSummary {
  applied: boolean;
  models: string[];
  commands: string[];
  warning: string | null;
}

export interface BuildResult {
  specPath: string;
  manifestPath: string;
  milestoneId: string | null;
  status: BridgeStatus;
  prefs: PrefsSummary;
}

export interface BuildOptions {
  auto?: boolean;
  binary?: string;
  cwd?: string;
  spawn?: Spawner;
  applyPrefs?: boolean;
  now?: () => string;
}

export async function runBuild(htmlPath: string, opts: BuildOptions = {}): Promise<BuildResult> {
  const cwd = opts.cwd ?? process.cwd();
  let exportResult: ExportResult;
  try {
    exportResult = await runExport(htmlPath, { mode: opts.auto ? "auto" : "step", projectRoot: cwd });
  } catch (err) {
    throw new Error(friendlyError(err));
  }

  // Routing must land before the milestone is created so an --auto run
  // executes under the plan's model policy.
  let prefs: PrefsSummary = { applied: false, models: [], commands: [], warning: null };
  const hasDirectives =
    Object.keys(exportResult.modelPolicy).length > 0 || exportResult.validationCommands.length > 0;
  if (opts.applyPrefs !== false && hasDirectives) {
    try {
      const overlay = await applyPreferencesOverlay(cwd, {
        modelPolicy: exportResult.modelPolicy,
        verificationCommands: exportResult.validationCommands,
        sourceHtmlPath: htmlPath,
      });
      prefs = {
        applied: overlay.changed,
        models: overlay.appliedModels,
        commands: overlay.appliedCommands,
        warning: null,
      };
    } catch (err) {
      prefs = {
        applied: false,
        models: [],
        commands: [],
        warning: err instanceof Error ? err.message : String(err),
      };
    }
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

  try {
    await appendEvalRow(
      cwd,
      buildEvalRow({
        loggedAt: (opts.now ?? (() => new Date().toISOString()))(),
        htmlPath,
        specPath: exportResult.specPath,
        milestoneId,
        mode: opts.auto ? "auto" : "step",
        status,
        appliedModels: prefs.models,
      }),
    );
  } catch {
    // Eval logging is best-effort; never fail a build over it.
  }

  return {
    specPath: exportResult.specPath,
    manifestPath: exportResult.manifestPath,
    milestoneId,
    status,
    prefs,
  };
}
