// gsd-pi — Regression tests for milestone merge integration-branch preparation.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  _resetMergeIntegrationBranchDepsForTests,
  _setMergeIntegrationBranchDepsForTests,
  prepareIntegrationBranchForMilestoneMerge,
} from "../auto-worktree-merge-integration-branch.js";
import { GSDError } from "../errors.js";

describe("prepareIntegrationBranchForMilestoneMerge", () => {
  beforeEach(() => {
    _resetMergeIntegrationBranchDepsForTests();
  });

  afterEach(() => {
    _resetMergeIntegrationBranchDepsForTests();
  });

  test("falls back to detected main, clears transient state, and checks out the integration branch", () => {
    const calls: string[] = [];
    _setMergeIntegrationBranchDepsForTests({
      resolveMilestoneIntegrationBranch: () => ({ reason: "missing metadata" } as never),
      nativeDetectMainBranch: () => "develop",
      nativeGetCurrentBranch: () => "feature/current",
      nativeCheckoutBranch: (_basePath, branch) => {
        calls.push(`checkout:${branch}`);
      },
      clearProjectRootStateFiles: (_basePath, milestoneId) => {
        calls.push(`clear:${milestoneId}`);
      },
    });

    const result = prepareIntegrationBranchForMilestoneMerge({
      milestoneBranch: "milestone/M002",
      milestoneId: "M002",
      prefs: {},
      previousCwd: "/repo/.gsd-worktrees/M002",
      projectRoot: "/repo",
    });

    assert.equal(result.mainBranch, "develop");
    assert.deepEqual(calls, ["clear:M002", "checkout:develop"]);
  });

  test("refuses self-merge and restores cwd", () => {
    const chdirCalls: string[] = [];
    _setMergeIntegrationBranchDepsForTests({
      resolveMilestoneIntegrationBranch: () => ({
        effectiveBranch: "refs/heads/milestone/M002",
        reason: "corrupt metadata",
      } as never),
      chdir: (path) => {
        chdirCalls.push(path);
      },
    });

    assert.throws(
      () => prepareIntegrationBranchForMilestoneMerge({
        milestoneBranch: "milestone/M002",
        milestoneId: "M002",
        prefs: {},
        previousCwd: "/repo/.gsd-worktrees/M002",
        projectRoot: "/repo",
      }),
      (err: unknown) => err instanceof GSDError
        && /same ref as milestone branch/.test(err.message)
        && /corrupt metadata/.test(err.message),
    );
    assert.deepEqual(chdirCalls, ["/repo/.gsd-worktrees/M002"]);
  });

  test("refuses detached project-root HEAD and restores cwd", () => {
    const chdirCalls: string[] = [];
    _setMergeIntegrationBranchDepsForTests({
      resolveMilestoneIntegrationBranch: () => ({ effectiveBranch: "main", reason: "configured" } as never),
      nativeGetCurrentBranch: () => "",
      chdir: (path) => {
        chdirCalls.push(path);
      },
    });

    assert.throws(
      () => prepareIntegrationBranchForMilestoneMerge({
        milestoneBranch: "milestone/M002",
        milestoneId: "M002",
        prefs: {},
        previousCwd: "/repo/.gsd-worktrees/M002",
        projectRoot: "/repo",
      }),
      (err: unknown) => err instanceof GSDError
        && /detached HEAD state/.test(err.message),
    );
    assert.deepEqual(chdirCalls, ["/repo/.gsd-worktrees/M002"]);
  });

  test("does not checkout when the project root is already on the integration branch", () => {
    const calls: string[] = [];
    _setMergeIntegrationBranchDepsForTests({
      resolveMilestoneIntegrationBranch: () => ({ effectiveBranch: "main", reason: "configured" } as never),
      nativeGetCurrentBranch: () => "main",
      nativeCheckoutBranch: () => {
        calls.push("checkout");
      },
      clearProjectRootStateFiles: () => {
        calls.push("clear");
      },
    });

    const result = prepareIntegrationBranchForMilestoneMerge({
      milestoneBranch: "milestone/M002",
      milestoneId: "M002",
      prefs: {},
      previousCwd: "/repo/.gsd-worktrees/M002",
      projectRoot: "/repo",
    });

    assert.equal(result.mainBranch, "main");
    assert.deepEqual(calls, ["clear"]);
  });
});
