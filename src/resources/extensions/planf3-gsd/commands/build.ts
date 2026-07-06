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
  autoChain: AutoChainOutcome;
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
  settle?: SettleOptions;
  allowUnsafeStep?: boolean;
}

export type AutoChainOutcome = "not-applicable" | "chained" | "relaunched" | "not-started";

export interface SettleOptions {
  /** Max query attempts after new-milestone (default 5). */
  attempts?: number;
  /** Delay between attempts in ms (default 2000). */
  delayMs?: number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export const STEP_MODE_HEADLESS_ERROR = [
  "Refusing headless step mode: `gsd headless new-milestone` (without --auto) parks on the",
  "depth-verification gate, which cannot be answered in a headless session, and leaves a",
  "stub milestone behind.",
  "Options:",
  "  • run with --auto (recommended — the gate is auto-verified in auto mode),",
  "  • create the milestone interactively inside pi, then drive it with /gsd next,",
  "  • or pass --step-unsafe to accept today's deadlock-prone behavior anyway.",
].join("\n");

/** Best-effort failure eval row — never masks the original error. */
async function logFailureRow(
  cwd: string,
  input: {
    loggedAt: string;
    htmlPath: string;
    specPath: string;
    mode: "auto" | "step";
    marker: string;
    appliedModels: string[];
  },
): Promise<void> {
  try {
    await appendEvalRow(
      cwd,
      buildEvalRow({
        loggedAt: input.loggedAt,
        htmlPath: input.htmlPath,
        specPath: input.specPath,
        milestoneId: null,
        mode: input.mode,
        status: { ...mapQuerySnapshot(null), phase: input.marker },
        appliedModels: input.appliedModels,
      }),
    );
  } catch {
    // Eval logging is best-effort; never fail a build over it.
  }
}

function deriveLastStatus(
  status: BridgeStatus,
  autoChain: AutoChainOutcome,
): "planned" | "running" | "passed" | "failed" | "blocked" {
  if (status.blockers.length > 0) return "blocked";
  if (status.activeTask !== null || status.activeSlice !== null) return "running";
  if (autoChain === "chained" || autoChain === "relaunched") return "passed";
  return "planned";
}

export async function runBuild(htmlPath: string, opts: BuildOptions = {}): Promise<BuildResult> {
  if (opts.auto !== true && opts.allowUnsafeStep !== true) {
    throw new Error(STEP_MODE_HEADLESS_ERROR);
  }
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? (() => new Date().toISOString());
  const mode: "auto" | "step" = opts.auto ? "auto" : "step";
  let exportResult: ExportResult;
  try {
    exportResult = await runExport(htmlPath, { mode, projectRoot: cwd });
  } catch (err) {
    await logFailureRow(cwd, { loggedAt: now(), htmlPath, specPath: "", mode, marker: "failed:export", appliedModels: [] });
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

  const runner = new GsdRunner({
    binary: opts.binary,
    cwd,
    spawn: opts.spawn ?? realSpawner,
    // Belt-and-braces for potentially hours-long auto builds; NOT a fix for
    // any observed ceiling (a 16+ min --print build completed cleanly, and
    // auto/new-milestone are multi-turn upstream, exempt from idle timeout).
    timeoutSeconds: opts.auto === true ? 0 : undefined,
  });

  // Baseline snapshot so "did this build complete a milestone?" is
  // answerable after an auto run (lastCompletedMilestone drift).
  let baseline: BridgeStatus | null = null;
  try {
    baseline = mapQuerySnapshot((await runner.query()).json);
  } catch {
    baseline = null; // best-effort; a failed baseline never blocks the build
  }

  let nmExitCode = -1;
  try {
    nmExitCode = (await runner.newMilestone(exportResult.specPath, { auto: opts.auto === true })).exitCode;
  } catch (err) {
    await logFailureRow(cwd, {
      loggedAt: now(), htmlPath, specPath: exportResult.specPath, mode,
      marker: "failed:new-milestone", appliedModels: prefs.models,
    });
    throw new Error(friendlyError(err, opts.binary ?? "gsd"));
  }

  const attempts = Math.max(1, opts.settle?.attempts ?? 5);
  const delayMs = opts.settle?.delayMs ?? 2000;
  const sleep = opts.settle?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const lastCompletedChanged = (s: BridgeStatus): boolean =>
    s.lastCompletedMilestone !== null &&
    s.lastCompletedMilestone.id !== (baseline?.lastCompletedMilestone?.id ?? null);

  // Settle loop (replaces the old A1 single-snapshot assumption). Re-keying
  // defense: this run's REAL A1 failure was a stub milestone (depth-gate
  // deadlock left stub M001, its id was written back, the real milestone
  // landed as M002). So in auto mode only COMPLETION (lastCompletedMilestone
  // drift vs baseline) or VISIBLE EXECUTION (activeTask) end the wait — a
  // merely-queued activeMilestone is never latched early. Step mode has no
  // execution to wait for; an observable id is all it can settle on (that id
  // may still be re-keyed later — inherent to --step-unsafe, see README).
  let status: BridgeStatus;
  try {
    status = mapQuerySnapshot((await runner.query()).json);
    for (let attempt = 1; attempt < attempts; attempt++) {
      if (opts.auto) {
        if (lastCompletedChanged(status) || status.activeTask !== null) break;
      } else if (status.activeMilestone !== null) {
        break;
      }
      await sleep(delayMs);
      status = mapQuerySnapshot((await runner.query()).json);
    }
  } catch (err) {
    await logFailureRow(cwd, {
      loggedAt: now(), htmlPath, specPath: exportResult.specPath, mode,
      marker: "failed:query", appliedModels: prefs.models,
    });
    throw new Error(friendlyError(err, opts.binary ?? "gsd"));
  }

  let milestoneId = status.activeMilestone?.id ?? status.lastCompletedMilestone?.id ?? null;

  // A queued-but-never-executing milestone at loop exhaustion is recorded
  // honestly below (lastStatus "planned") rather than trusted as final.
  const zeroExecutionDispatches = (s: BridgeStatus): boolean =>
    s.activeTask === null && s.activeSlice === null && (s.progress === null || s.progress.tasks.done === 0);

  // Auto-chain workaround: `new-milestone --auto` can return after planning
  // without execution ever starting (upstream chain is suppressed when the
  // depth gate is pending or the readiness notification never fires).
  // Relaunch `auto` at most ONCE, and only on the deterministic signature:
  //   (a) new-milestone exited 0 ("Status: complete"),
  //   (b) a milestone id is known,
  //   (c) zero execution dispatches are visible,
  //   (d) no blockers — PAUSES ARE SACRED. Both pauses in the live Editorial
  //       HN run (safety evidence-xref, needs-attention verdict) required
  //       human judgment; blind relaunch past the first one is what adopted
  //       stranded work into an unattributed "chore: init gsd" commit.
  //       Do not widen this predicate.
  let autoChain: AutoChainOutcome = "not-applicable";
  if (opts.auto) {
    if (lastCompletedChanged(status) || status.activeTask !== null) {
      autoChain = "chained";
    } else if (
      nmExitCode === 0 &&
      milestoneId !== null &&
      zeroExecutionDispatches(status) &&
      status.blockers.length === 0
    ) {
      try {
        await runner.auto();
        status = mapQuerySnapshot((await runner.query()).json);
        milestoneId = status.activeMilestone?.id ?? status.lastCompletedMilestone?.id ?? milestoneId;
      } catch (err) {
        await logFailureRow(cwd, {
          loggedAt: now(), htmlPath, specPath: exportResult.specPath, mode,
          marker: "failed:auto-relaunch", appliedModels: prefs.models,
        });
        throw new Error(friendlyError(err, opts.binary ?? "gsd"));
      }
      autoChain = lastCompletedChanged(status) || status.activeTask !== null ? "relaunched" : "not-started";
    } else {
      autoChain = "not-started";
    }
  }

  const evalPhase =
    autoChain === "relaunched" ? "auto-relaunched"
    : autoChain === "not-started" ? "auto-not-started"
    : status.phase;

  if (milestoneId !== null || status.sessionId !== null) {
    const manifestText = await readFile(exportResult.manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    if (milestoneId !== null) manifest.gsd.milestoneId = milestoneId;
    if (status.sessionId !== null) manifest.gsd.headlessSessionId = status.sessionId;
    manifest.validation.lastSyncedAt = now();
    manifest.validation.lastStatus = deriveLastStatus(status, autoChain);
    await writeFile(exportResult.manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }

  try {
    await appendEvalRow(
      cwd,
      buildEvalRow({
        loggedAt: now(),
        htmlPath,
        specPath: exportResult.specPath,
        milestoneId,
        mode,
        status: { ...status, phase: evalPhase },
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
    autoChain,
    status,
    prefs,
  };
}
