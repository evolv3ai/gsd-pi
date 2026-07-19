import { readFile, writeFile } from "node:fs/promises";
import { GsdRunner, type Spawner } from "../gsd/headless-runner.js";
import { realSpawner } from "../gsd/real-spawner.js";
import { mapQuerySnapshot, type BridgeStatus } from "../gsd/status-mapper.js";
import { applyPreferencesOverlay } from "../gsd/preferences-overlay.js";
import { buildEvalRow, appendEvalRow } from "../gsd/eval-log.js";
import { checkPresetsGate, type PresetsGateResult } from "../preflight/enforce.js";
import { PRESETS_RELATIVE_PATH } from "../preflight/presets-file.js";
import { runExport, type ExportResult } from "./export.js";
import { runSync, type SyncOutcomeKind } from "./sync.js";
import { friendlyError } from "./error-message.js";

export interface PrefsSummary {
  applied: boolean;
  /** Bucket keys applied this build (e.g. "planning"). */
  buckets: string[];
  /** bucket → model id for exactly those buckets. */
  models: Record<string, string>;
  commands: string[];
  warning: string | null;
}

/** Build-return sync (M4 loop touchpoint a): first-paint with zero user
 *  action. null = no milestone was stamped, sync not attempted. A sync bug
 *  must never turn a successful build report into an error. */
export type PostSyncOutcome =
  | { ran: true; kind: SyncOutcomeKind; message: string }
  | { ran: false; error: string }
  | null;

export interface BuildResult {
  specPath: string;
  manifestPath: string;
  milestoneId: string | null;
  autoChain: AutoChainOutcome;
  status: BridgeStatus;
  prefs: PrefsSummary;
  presets: PresetsGateResult["presets"];
  postSync: PostSyncOutcome;
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
  force?: boolean;
  globalPrefsPath?: string;
  /** Kill `gsd headless {new-milestone,auto}` if no stdout arrives for this
   *  long. Default 10 minutes. Set to 0 to disable. Guards against upstream
   *  #1294 (smart-entry menu route hangs headless indefinitely). */
  headlessIdleMs?: number;
}

export type AutoChainOutcome = "not-applicable" | "chained" | "relaunched" | "not-started" | "stopped-at-pause";

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

/** Every phase marker a failure/refusal eval row can carry. A typo at a call
 *  site is now a compile error instead of a silently-new marker. */
type FailureMarker =
  | "failed:export"
  | "failed:new-milestone"
  | "failed:query"
  | "failed:auto-relaunch"
  | "failed:headless-idle"
  | "preflight-refused:drift"
  | "preflight-refused:absent"
  | "preflight-refused:unsigned-projection";

/** Best-effort failure eval row — never masks the original error. */
async function logFailureRow(
  cwd: string,
  input: {
    loggedAt: string;
    htmlPath: string;
    specPath: string;
    mode: "auto" | "step";
    marker: FailureMarker;
    appliedBuckets: string[];
    appliedModels: Record<string, string>;
    presets?: "ok" | "forced" | "absent" | "drift";
    presetsHash?: string | null;
    /** Max cost observed across bridge-side queries before the failure (M4) —
     *  same cumulative semantics as the success row. Omitted on pre-query
     *  paths (gate/export), where no spend was observable. */
    observedCost?: number;
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
        status: { ...mapQuerySnapshot(null), phase: input.marker, cost: input.observedCost ?? 0 },
        appliedBuckets: input.appliedBuckets,
        appliedModels: input.appliedModels,
        presets: input.presets,
        presetsHash: input.presetsHash,
      }),
    );
  } catch {
    // Eval logging is best-effort; never fail a build over it.
  }
}

// Narrower than manifest.validation.lastStatus's schema ("failed" stays legal
// there for other writers) — this derivation simply has no failed path today.
function deriveLastStatus(
  status: BridgeStatus,
  autoChain: AutoChainOutcome,
): "planned" | "running" | "passed" | "blocked" {
  if (status.blockers.length > 0) return "blocked";
  if (status.activeTask !== null || status.activeSlice !== null) return "running";
  if (autoChain === "chained" || autoChain === "relaunched") return "passed";
  return "planned";
}

const MENU_HANG_RE = /menu could not be shown in this session/;

interface IdleGuard {
  signal: AbortSignal;
  onStdout: (chunk: string) => void;
  wasAborted: () => boolean;
  dispose: () => void;
}

function makeIdleGuard(idleMs: number): IdleGuard {
  const controller = new AbortController();
  if (idleMs === 0) {
    return {
      signal: controller.signal,
      onStdout: () => {},
      wasAborted: () => false,
      dispose: () => {},
    };
  }
  let timer: ReturnType<typeof setTimeout> = setTimeout(() => controller.abort(), idleMs);
  const reset = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), idleMs); };
  return {
    signal: controller.signal,
    onStdout: (chunk) => {
      reset();
      if (MENU_HANG_RE.test(chunk)) controller.abort();
    },
    wasAborted: () => controller.signal.aborted,
    dispose: () => { clearTimeout(timer); },
  };
}

const HEADLESS_IDLE_MESSAGE = "gsd idled headless without progress (known upstream #1294) — killed the child";

export async function runBuild(htmlPath: string, opts: BuildOptions = {}): Promise<BuildResult> {
  if (opts.auto !== true && opts.allowUnsafeStep !== true) {
    throw new Error(STEP_MODE_HEADLESS_ERROR);
  }
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? (() => new Date().toISOString());
  const mode: "auto" | "step" = opts.auto ? "auto" : "step";

  // Enforced-lite preflight gate (spec §7): recomputed from disk alone, never
  // probes. Refusals still log eval rows — otherwise "failed builds emit no
  // eval row" is recreated one layer up.
  //
  // A missing/moved plan html propagates uncaught out of checkPresetsGate
  // (Task 10 review, finding #2) — it's the same failure domain runExport's
  // ENOENT mapping owns below, not a presets refusal, so it gets the exact
  // same failed:export marker + friendly message rather than a generic
  // "specs/PRESETS.md is unreadable" one.
  let gate: PresetsGateResult;
  try {
    gate = await checkPresetsGate(cwd, htmlPath, {
      force: opts.force === true,
      ...(opts.globalPrefsPath !== undefined ? { globalPrefsPath: opts.globalPrefsPath } : {}),
    });
  } catch (err) {
    await logFailureRow(cwd, { loggedAt: now(), htmlPath, specPath: "", mode, marker: "failed:export", appliedBuckets: [], appliedModels: {} });
    throw new Error(friendlyError(err));
  }
  if (gate.refusal !== null) {
    const marker: FailureMarker =
      gate.presets === "drift" ? "preflight-refused:drift"
      : gate.absenceReason === "unsigned-projection" ? "preflight-refused:unsigned-projection"
      : "preflight-refused:absent";
    await logFailureRow(cwd, {
      loggedAt: now(), htmlPath, specPath: "", mode,
      marker,
      appliedBuckets: [], appliedModels: {},
      presets: gate.presets, presetsHash: gate.presetsHash,
    });
    throw new Error(gate.refusal);
  }

  let exportResult: ExportResult;
  try {
    exportResult = await runExport(htmlPath, { mode, projectRoot: cwd });
  } catch (err) {
    await logFailureRow(cwd, { loggedAt: now(), htmlPath, specPath: "", mode, marker: "failed:export", appliedBuckets: [], appliedModels: {} });
    throw new Error(friendlyError(err));
  }

  // Routing must land before the milestone is created so an --auto run
  // executes under the plan's model policy.
  let prefs: PrefsSummary = { applied: false, buckets: [], models: {}, commands: [], warning: null };
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
        buckets: overlay.appliedBucketKeys,
        models: overlay.appliedModelMap,
        commands: overlay.appliedCommands,
        warning: null,
      };
    } catch (err) {
      prefs = {
        applied: false,
        buckets: [],
        models: {},
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

  // F3: the final query at end-of-build can report cost.total: 0 (observed
  // upstream gsd behavior at a stopped-at-pause state) even though earlier
  // snapshots in this same run saw real spend. Track the max across every
  // bridge-side query we take and use that for the eval row's cost.
  let observedCost = baseline?.cost ?? 0;
  const trackCost = (s: BridgeStatus): void => { if (s.cost > observedCost) observedCost = s.cost; };

  const idleMs = opts.headlessIdleMs ?? 10 * 60 * 1000;

  let nmExitCode = -1;
  {
    const guard = makeIdleGuard(idleMs);
    try {
      nmExitCode = (await runner.newMilestone(exportResult.specPath, {
        auto: opts.auto === true,
        signal: guard.signal,
        onStdout: guard.onStdout,
      })).exitCode;
    } catch (err) {
      const marker: FailureMarker = guard.wasAborted() ? "failed:headless-idle" : "failed:new-milestone";
      await logFailureRow(cwd, {
        loggedAt: now(), htmlPath, specPath: exportResult.specPath, mode,
        marker, appliedBuckets: prefs.buckets, appliedModels: prefs.models,
        observedCost,
      });
      if (guard.wasAborted()) {
        throw new Error(`[planf3-gsd:error] ${HEADLESS_IDLE_MESSAGE} (new-milestone)`);
      }
      throw new Error(friendlyError(err, opts.binary ?? "gsd"));
    } finally {
      guard.dispose();
    }
  }

  const attempts = Math.max(1, opts.settle?.attempts ?? 5);
  const delayMs = opts.settle?.delayMs ?? 2000;
  const sleep = opts.settle?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const lastCompletedChanged = (s: BridgeStatus): boolean =>
    s.lastCompletedMilestone !== null &&
    s.lastCompletedMilestone.id !== (baseline?.lastCompletedMilestone?.id ?? null);

  // Completion drift or a visible dispatch — the only two signals that count
  // as progress for the settle loop and auto-chain decisions.
  const isVisiblyProgressing = (s: BridgeStatus): boolean =>
    lastCompletedChanged(s) || s.activeTask !== null;

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
    trackCost(status);
    for (let attempt = 1; attempt < attempts; attempt++) {
      if (opts.auto) {
        if (isVisiblyProgressing(status)) break;
      } else if (status.activeMilestone !== null) {
        break;
      }
      await sleep(delayMs);
      status = mapQuerySnapshot((await runner.query()).json);
      trackCost(status);
    }
  } catch (err) {
    await logFailureRow(cwd, {
      loggedAt: now(), htmlPath, specPath: exportResult.specPath, mode,
      marker: "failed:query", appliedBuckets: prefs.buckets, appliedModels: prefs.models,
      observedCost,
    });
    throw new Error(friendlyError(err, opts.binary ?? "gsd"));
  }

  let milestoneId = status.activeMilestone?.id ?? status.lastCompletedMilestone?.id ?? null;

  // A queued-but-never-executing milestone at loop exhaustion is recorded
  // honestly below (lastStatus "planned") rather than trusted as final.
  const zeroExecutionDispatches = (s: BridgeStatus): boolean =>
    s.activeTask === null && s.activeSlice === null && (s.progress === null || s.progress.tasks.done === 0);

  // F3 discrimination, shared by the relaunch and no-relaunch branches:
  // task completions or a live pause mean execution DID happen.
  const stoppedAtPause = (s: BridgeStatus): boolean =>
    (s.progress?.tasks.done ?? 0) > 0 || s.blockers.length > 0;

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
    if (isVisiblyProgressing(status)) {
      autoChain = "chained";
    } else if (
      nmExitCode === 0 &&
      milestoneId !== null &&
      zeroExecutionDispatches(status) &&
      status.blockers.length === 0
    ) {
      // Guard-wrapped relaunch — exact body from Task 3 Step 5's runner.auto
      // wrap (idle guard, kills the child on hang, distinguishes failed:auto-
      // relaunch from failed:headless-idle). This branch is otherwise unchanged
      // from v0.3.1.
      const guard = makeIdleGuard(idleMs);
      try {
        await runner.auto({ signal: guard.signal, onStdout: guard.onStdout });
        status = mapQuerySnapshot((await runner.query()).json);
        trackCost(status);
        milestoneId = status.activeMilestone?.id ?? status.lastCompletedMilestone?.id ?? milestoneId;
      } catch (err) {
        const marker: FailureMarker = guard.wasAborted() ? "failed:headless-idle" : "failed:auto-relaunch";
        await logFailureRow(cwd, {
          loggedAt: now(), htmlPath, specPath: exportResult.specPath, mode,
          marker, appliedBuckets: prefs.buckets, appliedModels: prefs.models,
          observedCost,
        });
        if (guard.wasAborted()) {
          throw new Error(`[planf3-gsd:error] ${HEADLESS_IDLE_MESSAGE} (auto-chain)`);
        }
        throw new Error(friendlyError(err, opts.binary ?? "gsd"));
      } finally {
        guard.dispose();
      }
      // Twin-branch parity with the F3 discrimination below: a relaunched run
      // that pauses (blocker) or completes tasks without finishing is
      // execution having happened, not "nothing started".
      autoChain = isVisiblyProgressing(status) ? "relaunched"
        : stoppedAtPause(status) ? "stopped-at-pause"
        : "not-started";
    } else if (stoppedAtPause(status)) {
      // Execution DID happen (task completions or a live pause) but the loop
      // didn't reach the current milestone's completion. F3: this is distinct
      // from "nothing happened" — attribute honestly.
      autoChain = "stopped-at-pause";
    } else {
      autoChain = "not-started";
    }
  }

  const evalPhase =
    autoChain === "relaunched" ? "auto-relaunched"
    : autoChain === "not-started" ? "auto-not-started"
    : autoChain === "stopped-at-pause" ? "auto-stopped-at-pause"
    : status.phase;

  if (milestoneId !== null || status.sessionId !== null) {
    const manifestText = await readFile(exportResult.manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    if (milestoneId !== null) manifest.gsd.milestoneId = milestoneId;
    if (status.sessionId !== null) manifest.gsd.headlessSessionId = status.sessionId;
    manifest.validation.lastSyncedAt = now();
    manifest.validation.lastStatus = deriveLastStatus(status, autoChain);
    manifest.presets = { path: PRESETS_RELATIVE_PATH, approvalHash: gate.presetsHash };
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
        status: { ...status, phase: evalPhase, cost: observedCost },
        appliedBuckets: prefs.buckets,
        appliedModels: prefs.models,
        presets: gate.presets,
        presetsHash: gate.presetsHash,
      }),
    );
  } catch {
    // Eval logging is best-effort; never fail a build over it.
  }

  // Build-return sync (M4): any outcome that stamped a milestone (including
  // --force) gets an immediate in-process sync of the plan's markers. The
  // refusal path never reaches here — nothing was stamped there.
  let postSync: PostSyncOutcome = null;
  if (milestoneId !== null) {
    try {
      const synced = await runSync(htmlPath, false, {
        cwd,
        now,
        ...(opts.binary !== undefined ? { binary: opts.binary } : {}),
        ...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
      });
      postSync = { ran: true, kind: synced.kind, message: synced.message };
    } catch (err) {
      postSync = { ran: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  return {
    specPath: exportResult.specPath,
    manifestPath: exportResult.manifestPath,
    milestoneId,
    autoChain,
    status,
    prefs,
    presets: gate.presets,
    postSync,
  };
}
