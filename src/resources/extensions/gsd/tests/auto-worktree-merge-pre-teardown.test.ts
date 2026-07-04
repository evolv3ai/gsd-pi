// gsd-pi — Regression tests for milestone merge pre-teardown safety.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  _resetPreTeardownSafetyDepsForTests,
  _setPreTeardownSafetyDepsForTests,
  assertMilestoneWorktreeCleanBeforeTeardown,
} from "../auto-worktree-merge-pre-teardown.js";
import { GSDError } from "../errors.js";

describe("assertMilestoneWorktreeCleanBeforeTeardown", () => {
  const cwdBefore = process.cwd();

  beforeEach(() => {
    _resetPreTeardownSafetyDepsForTests();
    process.chdir(cwdBefore);
  });

  afterEach(() => {
    _resetPreTeardownSafetyDepsForTests();
    process.chdir(cwdBefore);
  });

  test("throws and restores cwd when the milestone worktree is still dirty", () => {
    const chdirCalls: string[] = [];
    _setPreTeardownSafetyDepsForTests({
      existsSync: () => true,
      nativeGetCurrentBranch: () => "milestone/M002",
      nativeWorkingTreeStatus: () => " M src/index.ts\n?? notes.txt",
      chdir: (path) => {
        chdirCalls.push(path);
      },
    });

    assert.throws(
      () => assertMilestoneWorktreeCleanBeforeTeardown({
        milestoneBranch: "milestone/M002",
        previousCwd: "/tmp/milestone-worktree",
        worktreeCwd: "/tmp/milestone-worktree",
      }),
      (err: unknown) => err instanceof GSDError
        && /still has uncommitted changes/.test(err.message)
        && /M src\/index\.ts/.test(err.message),
    );
    assert.deepEqual(chdirCalls, ["/tmp/milestone-worktree"]);
  });

  test("skips dirty work when the cwd is not the milestone branch", () => {
    let dirtyChecks = 0;
    _setPreTeardownSafetyDepsForTests({
      existsSync: () => true,
      nativeGetCurrentBranch: () => "main",
      nativeWorkingTreeStatus: () => {
        dirtyChecks += 1;
        return " M unrelated.ts";
      },
    });

    assert.doesNotThrow(() => assertMilestoneWorktreeCleanBeforeTeardown({
      milestoneBranch: "milestone/M002",
      previousCwd: "/tmp/main-worktree",
      worktreeCwd: "/tmp/main-worktree",
    }));
    assert.equal(dirtyChecks, 0, "dirty state on another branch must not block cleanup");
  });

  test("fails open when dirty status cannot be read", () => {
    _setPreTeardownSafetyDepsForTests({
      existsSync: () => true,
      nativeGetCurrentBranch: () => "milestone/M002",
      nativeWorkingTreeStatus: () => {
        throw new Error("status unavailable");
      },
    });

    assert.doesNotThrow(() => assertMilestoneWorktreeCleanBeforeTeardown({
      milestoneBranch: "milestone/M002",
      previousCwd: "/tmp/milestone-worktree",
      worktreeCwd: "/tmp/milestone-worktree",
    }));
  });
});
