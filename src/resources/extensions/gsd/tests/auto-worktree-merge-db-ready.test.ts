// gsd-pi — Regression tests for milestone merge DB readiness.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  _resetMergeDbReadyDepsForTests,
  _setMergeDbReadyDepsForTests,
  assertMilestoneDbReadyForMerge,
} from "../auto-worktree-merge-db-ready.js";
import { GSDError } from "../errors.js";

describe("assertMilestoneDbReadyForMerge", () => {
  beforeEach(() => {
    _resetMergeDbReadyDepsForTests();
  });

  afterEach(() => {
    _resetMergeDbReadyDepsForTests();
  });

  test("does nothing when the workflow DB is unavailable", () => {
    let resolvedPaths = 0;
    _setMergeDbReadyDepsForTests({
      isDbAvailable: () => false,
      resolveGsdPathContract: () => {
        resolvedPaths += 1;
        throw new Error("should not resolve paths");
      },
    });

    assert.doesNotThrow(() => assertMilestoneDbReadyForMerge({
      milestoneId: "M002",
      projectRoot: "/repo",
      worktreeCwd: "/repo/.gsd-worktrees/M002",
    }));
    assert.equal(resolvedPaths, 0);
  });

  test("switches the active DB to the project DB before reconciling the worktree DB", () => {
    const calls: string[] = [];
    _setMergeDbReadyDepsForTests({
      isDbAvailable: () => true,
      resolveGsdPathContract: () => ({
        projectDb: "/repo/.gsd/gsd.db",
        worktreeGsd: "/repo/.gsd-worktrees/M002/.gsd",
      } as never),
      getWorkflowDatabasePath: () => "/repo/.gsd-worktrees/M002/.gsd/gsd.db",
      shouldReconcileWorktreeDb: (candidate, main) => {
        calls.push(`should:${candidate}->${main}`);
        return true;
      },
      closeWorkflowDatabase: () => {
        calls.push("close");
      },
      openWorkflowDatabasePath: (path) => {
        calls.push(`open:${path}`);
        return true;
      },
      reconcileWorktreeDb: (main, worktree) => {
        calls.push(`reconcile:${main}<-${worktree}`);
        return { conflicts: [] } as never;
      },
      proveMilestoneCloseout: (milestoneId) => {
        calls.push(`prove:${milestoneId}`);
        return { ok: true };
      },
    });

    assertMilestoneDbReadyForMerge({
      milestoneId: "M002",
      projectRoot: "/repo",
      worktreeCwd: "/repo/.gsd-worktrees/M002",
    });

    assert.deepEqual(calls, [
      "should:/repo/.gsd-worktrees/M002/.gsd/gsd.db->/repo/.gsd/gsd.db",
      "close",
      "open:/repo/.gsd/gsd.db",
      "should:/repo/.gsd-worktrees/M002/.gsd/gsd.db->/repo/.gsd/gsd.db",
      "reconcile:/repo/.gsd/gsd.db<-/repo/.gsd-worktrees/M002/.gsd/gsd.db",
      "prove:M002",
    ]);
  });

  test("wraps DB open failures with the closeout consistency recovery reason", () => {
    _setMergeDbReadyDepsForTests({
      isDbAvailable: () => true,
      resolveGsdPathContract: () => ({
        projectDb: "/repo/.gsd/gsd.db",
        worktreeGsd: "/repo/.gsd-worktrees/M002/.gsd",
      } as never),
      getWorkflowDatabasePath: () => "/repo/.gsd-worktrees/M002/.gsd/gsd.db",
      shouldReconcileWorktreeDb: () => true,
      closeWorkflowDatabase: () => undefined,
      openWorkflowDatabasePath: () => false,
      logError: () => undefined,
    });

    assert.throws(
      () => assertMilestoneDbReadyForMerge({
        milestoneId: "M002",
        projectRoot: "/repo",
        worktreeCwd: "/repo/.gsd-worktrees/M002",
      }),
      (err: unknown) => err instanceof GSDError
        && /DB reconciliation failed before milestone M002 merge/.test(err.message)
        && /Recovery reason: closeout-consistency-blocked/.test(err.message),
    );
  });

  test("surfaces closeout proof failures after successful reconciliation", () => {
    _setMergeDbReadyDepsForTests({
      isDbAvailable: () => true,
      resolveGsdPathContract: () => ({
        projectDb: "/repo/.gsd/gsd.db",
        worktreeGsd: "/repo/.gsd-worktrees/M002/.gsd",
      } as never),
      getWorkflowDatabasePath: () => "/repo/.gsd/gsd.db",
      shouldReconcileWorktreeDb: () => false,
      proveMilestoneCloseout: () => ({
        ok: false,
        reason: "consistency-blocked",
        message: "closeout blocked",
        recoveryReason: "closeout-consistency-blocked",
      } as never),
      formatCloseoutProofBlock: () => "formatted closeout proof failure",
    });

    assert.throws(
      () => assertMilestoneDbReadyForMerge({
        milestoneId: "M002",
        projectRoot: "/repo",
        worktreeCwd: "/repo/.gsd-worktrees/M002",
      }),
      (err: unknown) => err instanceof GSDError
        && err.message === "formatted closeout proof failure",
    );
  });
});
