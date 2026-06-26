// Project/App: gsd-pi
// File Purpose: ADR-017 drift-driven State Reconciliation Module entry point.
// reconcileBeforeDispatch runs before every Dispatch decision and worker spawn.

import {
  deriveState as defaultDeriveState,
  invalidateStateCache as defaultInvalidate,
} from "../state.js";
import { clearParseCache as defaultClearParseCache } from "../files.js";
import { clearPathCache } from "../paths.js";
import { logWarning } from "../workflow-logger.js";
import type { GSDState } from "../types.js";

import {
  ReconciliationFailedError,
  type ReconciliationFailureDetail,
} from "./errors.js";
import { DRIFT_REGISTRY } from "./registry.js";
import type {
  DriftContext,
  DriftHandler,
  DriftRecord,
  ReconciliationDeps,
  ReconciliationResult,
} from "./types.js";

export type {
  DriftContext,
  DriftHandler,
  DriftRecord,
  ReconciliationDeps,
  ReconciliationResult,
} from "./types.js";
export { ReconciliationFailedError } from "./errors.js";
export type { ReconciliationFailureDetail } from "./errors.js";
export { DRIFT_REGISTRY } from "./registry.js";

const MAX_PASSES = 2;

const defaultDeps: ReconciliationDeps = {
  invalidateStateCache: defaultInvalidate,
  deriveState: defaultDeriveState,
  clearParseCache: defaultClearParseCache,
};

/**
 * Drift-driven pre-dispatch reconciliation per ADR-017.
 *
 * Lifecycle: derive → detect drift → apply repairs → re-derive. Capped at
 * MAX_PASSES (=2) cycles. The loop runs only when the prior pass fully
 * succeeded but re-derive surfaces NEW drift (cascading repairs — e.g.
 * fixing milestone registration uncovers a downstream completion-timestamp
 * drift).
 *
 * Returns ok=true with `repaired` and terminal `blockers` populated.
 * Throws ReconciliationFailedError when:
 *   - any repair function throws within a pass, or
 *   - drift persists after the cap.
 */
export async function reconcileBeforeDispatch(
  basePath: string,
  partialDeps: Partial<ReconciliationDeps> = {},
): Promise<ReconciliationResult> {
  const deps: ReconciliationDeps = { ...defaultDeps, ...partialDeps };
  const registry = deps.registry ?? DRIFT_REGISTRY;
  const clearParseCache = deps.clearParseCache ?? defaultClearParseCache;
  const repaired: DriftRecord[] = [];

  // Capture-on-first-read: infer .planning/ layout, import content into DB, and
  // activate the compat marker. Skipped in dry-run mode to keep the reconcile
  // pass fully read-only — no marker writes.
  if (!deps.dryRun) {
    const { capturePlanningCompatIfNeeded } = await import("../compat/planning-compat.js");
    await capturePlanningCompatIfNeeded(basePath);
  }

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    deps.invalidateStateCache();
    const stateSnapshot = await deps.deriveState(basePath, deps.deriveStateOptions);
    const ctx: DriftContext = { basePath, state: stateSnapshot, dryRun: deps.dryRun };

    const detection = await detectAllDrift(stateSnapshot, ctx, registry);
    const drift = detection.records;
    if (deps.dryRun && drift.length > 0) {
      const wouldRepair: DriftRecord[] = [];
      const blockers: string[] = [...detection.detectBlockers];
      for (const record of drift) {
        const handler = registry.find((h) => h.kind === record.kind);
        const blocker = handler?.blocker ? await handler.blocker(record, ctx) : null;
        if (blocker) {
          blockers.push(blocker);
        } else {
          wouldRepair.push(record);
        }
      }
      return {
        ok: true,
        stateSnapshot,
        repaired: wouldRepair,
        blockers: [
          ...new Set([
            ...(stateSnapshot.blockers ?? []),
            ...blockers,
          ]),
        ],
      };
    }
    if (drift.length === 0) {
      return {
        ok: true,
        stateSnapshot,
        repaired,
        blockers: [
          ...new Set([
            ...(stateSnapshot.blockers ?? []),
            ...detection.detectBlockers,
          ]),
        ],
      };
    }

    const failures: ReconciliationFailureDetail[] = [];
    const blockers: string[] = [...detection.detectBlockers];
    let repairedThisPass = false;
    for (const record of drift) {
      const handler = registry.find((h) => h.kind === record.kind);
      if (!handler) {
        failures.push({
          drift: record,
          cause: new Error(
            `No drift handler registered for kind "${record.kind}"`,
          ),
        });
        continue;
      }
      const blocker = handler.blocker ? await handler.blocker(record, ctx) : null;
      if (blocker) {
        blockers.push(blocker);
        continue;
      }
      try {
        await handler.repair(record, ctx);
        repaired.push(record);
        repairedThisPass = true;
      } catch (cause) {
        failures.push({ drift: record, cause });
      }
    }

    if (repairedThisPass) {
      // A repair may have mutated on-disk structure (e.g. quarantined a slice
      // dir). Clear both the parse cache and the path/dir cache centrally so
      // later passes and any subsequent repair see fresh filesystem state.
      clearParseCache();
      clearPathCache();
    }
    if (blockers.length > 0) {
      let blockerState = stateSnapshot;
      if (repairedThisPass) {
        deps.invalidateStateCache();
        blockerState = await deps.deriveState(basePath, deps.deriveStateOptions);
      }
      return {
        ok: true,
        stateSnapshot: blockerState,
        repaired,
        blockers: [...new Set([...(blockerState.blockers ?? []), ...blockers])],
      };
    }
    if (failures.length > 0) {
      throw new ReconciliationFailedError({ failures, pass });
    }
    // Pass fully succeeded; loop runs again to detect cascading drift.
  }

  // After MAX_PASSES, one more derive+detect to verify nothing persists.
  deps.invalidateStateCache();
  const finalState = await deps.deriveState(basePath, deps.deriveStateOptions);
  const finalCtx: DriftContext = { basePath, state: finalState, dryRun: deps.dryRun };
  const finalDetection = await detectAllDrift(finalState, finalCtx, registry);
  const persistent = finalDetection.records;

  if (persistent.length > 0) {
    const blockers: string[] = [...finalDetection.detectBlockers];
    const unblockedPersistent: DriftRecord[] = [];
    for (const record of persistent) {
      const handler = registry.find((h) => h.kind === record.kind);
      const blocker = handler?.blocker ? await handler.blocker(record, finalCtx) : null;
      if (blocker) {
        blockers.push(blocker);
      } else {
        unblockedPersistent.push(record);
      }
    }
    if (blockers.length > 0 && unblockedPersistent.length === 0) {
      return {
        ok: true,
        stateSnapshot: finalState,
        repaired,
        blockers: [...new Set([...(finalState.blockers ?? []), ...blockers])],
      };
    }
    throw new ReconciliationFailedError({ persistentDrift: persistent });
  }

  return {
    ok: true,
    stateSnapshot: finalState,
    repaired,
    blockers: [
      ...new Set([
        ...(finalState.blockers ?? []),
        ...finalDetection.detectBlockers,
      ]),
    ],
  };
}

interface DetectionOutcome {
  records: DriftRecord[];
  /** One blocker string per handler whose detect() threw. */
  detectBlockers: string[];
}

/**
 * Run every detector. A single detector throwing (e.g. a transient file read
 * error) must NOT abort the whole cycle and hide every later handler's drift —
 * it is collected as a blocker so dispatch is still gated, while the remaining
 * detectors run and their drift gets repaired (graceful degradation, ADR-017).
 */
async function detectAllDrift(
  state: GSDState,
  ctx: DriftContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registry: ReadonlyArray<DriftHandler<any>>,
): Promise<DetectionOutcome> {
  const records: DriftRecord[] = [];
  const detectBlockers: string[] = [];
  for (const handler of registry) {
    try {
      const detected = await handler.detect(state, ctx);
      records.push(...detected);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const blocker = `Drift detection failed for "${handler.kind}": ${message}`;
      logWarning("reconcile", blocker);
      detectBlockers.push(blocker);
    }
  }
  return { records, detectBlockers };
}
