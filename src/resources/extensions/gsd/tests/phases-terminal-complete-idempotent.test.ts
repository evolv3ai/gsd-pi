/**
 * phases-terminal-complete-idempotent.test.ts — Regression test for the
 * milestone-completion double-closeout guard introduced in
 * fix/transport-gate-double-complete.
 *
 * When `runPreDispatch` reaches the terminal `complete` phase, more than one
 * auto session may observe the same completion (one is already running the
 * stop, or the milestone is already closed in the DB). Only the first
 * closeout path should replay merge, desktop / cmux notifications, unit
 * closeout, and stopAuto. Subsequent observers must return
 * `{ action: "break", reason: "milestone-complete" }` immediately, without
 * replaying any of those side effects.
 *
 * This test exercises both fire-paths of the guard:
 *   1. `s.completionStopInProgress` is true (a sibling session is already
 *      stopping for completion in the current process).
 *   2. The milestone's DB status is closed (`complete`), regardless of the
 *      in-memory completionStopInProgress flag.
 */

import { createTestContext } from "./test-helpers.ts";
import { runPreDispatch } from "../auto/phases.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  isDbAvailable,
} from "../gsd-db.ts";

const { assertTrue, report } = createTestContext();

type SideEffect = string;

function makeIterationContext(overrides: {
  completionStopInProgress: boolean;
  sideEffects: SideEffect[];
  notifications: Array<{ message: string; level?: string }>;
}): any {
  const basePath = "/tmp/gsd-test-terminal-complete";
  const recordSideEffect = (label: string) => {
    overrides.sideEffects.push(label);
  };
  return {
    ctx: {
      ui: {
        notify(message: string, level?: string) {
          overrides.notifications.push({ message, level });
        },
      },
    },
    pi: {},
    s: {
      basePath,
      originalBasePath: basePath,
      canonicalProjectRoot: basePath,
      resourceVersionOnStart: "test",
      currentMilestoneId: "M001",
      currentUnit: null,
      milestoneMergedInPhases: false,
      completionStopInProgress: overrides.completionStopInProgress,
    },
    prefs: undefined,
    iteration: 1,
    flowId: "test-flow",
    nextSeq: () => 1,
    deps: {
      checkResourcesStale() {
        return null;
      },
      invalidateAllCaches() {},
      async preDispatchHealthGate() {
        return { proceed: true, fixesApplied: [] };
      },
      async deriveState() {
        return {
          phase: "complete",
          activeMilestone: { id: "M001", title: "Milestone one" },
          activeSlice: null,
          activeTask: null,
          registry: [{ id: "M001", status: "complete" }],
          nextAction: "complete",
        };
      },
      syncCmuxSidebar() {},
      setActiveMilestoneId() {},
      reconcileMergeState() {
        return "clean";
      },
      preflightCleanRoot() {
        recordSideEffect("preflight");
        return { ok: true, stashPushed: false, stashMarker: null };
      },
      postflightPopStash() {
        recordSideEffect("postflight");
        return { ok: true, needsManualRecovery: false };
      },
      lifecycle: {
        exitMilestone() {
          recordSideEffect("merge");
          return { ok: true };
        },
      },
      sendDesktopNotification() {
        recordSideEffect("desktop-notify");
      },
      logCmuxEvent() {
        recordSideEffect("cmux-event");
      },
      async closeoutUnit() {
        recordSideEffect("closeout-unit");
      },
      buildSnapshotOpts() {
        return {};
      },
      async stopAuto(_ctx: unknown, _pi: unknown, reason?: string) {
        recordSideEffect(`stop:${reason ?? ""}`);
      },
      async pauseAuto() {
        recordSideEffect("pause");
      },
      emitJournalEvent() {
        recordSideEffect("journal-event");
      },
    },
  };
}

console.log("\n=== Terminal complete is idempotent when a sibling session already closed it ===");

// ── Scenario 1: completionStopInProgress is true ─────────────────────────────
{
  const sideEffects: SideEffect[] = [];
  const notifications: Array<{ message: string; level?: string }> = [];
  const ic = makeIterationContext({
    completionStopInProgress: true,
    sideEffects,
    notifications,
  });

  const result = await runPreDispatch(ic, {
    recentUnits: [],
    stuckRecoveryAttempts: 0,
    consecutiveFinalizeTimeouts: 0,
  });

  assertTrue(
    result.action === "break",
    "completionStopInProgress: returns break instead of next",
  );
  if (result.action === "break") {
    assertTrue(
      result.reason === "milestone-complete",
      `completionStopInProgress: reason is milestone-complete (got "${result.reason}")`,
    );
  }
  assertTrue(
    sideEffects.length === 0,
    `completionStopInProgress: no closeout side effects replayed (saw [${sideEffects.join(", ")}])`,
  );
  assertTrue(
    notifications.length === 0,
    `completionStopInProgress: no user notifications emitted (saw ${notifications.length})`,
  );
}

// ── Scenario 2: DB milestone is already closed ──────────────────────────────
{
  if (isDbAvailable()) {
    closeDatabase();
  }
  openDatabase(":memory:");
  insertMilestone({
    id: "M001",
    title: "Milestone one",
    status: "complete",
  });

  try {
    const sideEffects: SideEffect[] = [];
    const notifications: Array<{ message: string; level?: string }> = [];
    const ic = makeIterationContext({
      completionStopInProgress: false,
      sideEffects,
      notifications,
    });

    const result = await runPreDispatch(ic, {
      recentUnits: [],
      stuckRecoveryAttempts: 0,
      consecutiveFinalizeTimeouts: 0,
    });

    assertTrue(
      result.action === "break",
      "db-closed: returns break instead of next",
    );
    if (result.action === "break") {
      assertTrue(
        result.reason === "milestone-complete",
        `db-closed: reason is milestone-complete (got "${result.reason}")`,
      );
    }
    assertTrue(
      sideEffects.length === 0,
      `db-closed: no closeout side effects replayed (saw [${sideEffects.join(", ")}])`,
    );
    assertTrue(
      notifications.length === 0,
      `db-closed: no user notifications emitted (saw ${notifications.length})`,
    );
  } finally {
    closeDatabase();
  }
}

report();
