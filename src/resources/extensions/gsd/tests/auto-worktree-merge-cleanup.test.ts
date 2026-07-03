// gsd-pi — Regression tests for milestone merge cleanup ordering.

import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  _resetMilestoneCleanupDepsForTests,
  _setMilestoneCleanupDepsForTests,
  cleanupMergedMilestoneWorktree,
} from "../auto-worktree-merge-cleanup.js";
import {
  getActiveWorkspace,
  setActiveWorkspace,
} from "../auto-worktree-session-registry.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function createRepoWithMilestoneWorktree(): { repo: string; worktree: string; branch: string } {
  const repo = mkdtempSync(join(tmpdir(), "gsd-merge-cleanup-"));
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);

  const branch = "milestone/M001";
  git(repo, ["branch", branch]);
  const worktree = join(repo, ".gsd-worktrees", "M001");
  git(repo, ["worktree", "add", worktree, branch]);
  return { repo, worktree, branch };
}

describe("cleanupMergedMilestoneWorktree", () => {
  let cleanupPaths: string[] = [];

  beforeEach(() => {
    cleanupPaths = [];
    _resetMilestoneCleanupDepsForTests();
    setActiveWorkspace(null);
  });

  afterEach(() => {
    _resetMilestoneCleanupDepsForTests();
    setActiveWorkspace(null);
    for (const path of cleanupPaths) {
      rmSync(path, { recursive: true, force: true });
    }
  });

  test("removes the milestone worktree before deleting the milestone branch", () => {
    const { repo, worktree, branch } = createRepoWithMilestoneWorktree();
    cleanupPaths.push(repo);
    process.chdir(worktree);
    setActiveWorkspace({ projectRoot: repo, worktreeName: "M001", path: worktree } as never);

    const result = cleanupMergedMilestoneWorktree({
      projectRoot: repo,
      milestoneId: "M001",
      milestoneBranch: branch,
      previousCwd: worktree,
    });

    assert.equal(result.worktreeRemoved, true);
    assert.equal(result.branchDeleteAttempted, true);
    assert.equal(existsSync(worktree), false, "worktree directory should be removed");
    assert.equal(git(repo, ["branch", "--list", branch]), "", "milestone branch should be deleted after removal");
    assert.equal(getActiveWorkspace(), null, "successful cleanup clears active workspace");
    assert.equal(realpathSync(process.cwd()), realpathSync(repo), "cleanup anchors cwd at project root after removing current worktree");
  });

  test("preserves the milestone branch and active workspace when worktree removal aborts", () => {
    const calls: string[] = [];
    _setMilestoneCleanupDepsForTests({
      clearProjectRootStateFiles: () => calls.push("clear-state"),
      removeWorktree: () => {
        calls.push("remove-worktree");
        return false;
      },
      nativeBranchDelete: () => calls.push("delete-branch"),
      setActiveWorkspace: () => calls.push("clear-active-workspace"),
      nudgeGitBranchCache: () => calls.push("nudge-cache"),
      chdir: () => calls.push("chdir-root"),
    });

    const result = cleanupMergedMilestoneWorktree({
      projectRoot: "/repo",
      milestoneId: "M001",
      milestoneBranch: "milestone/M001",
      previousCwd: "/repo/.gsd-worktrees/M001",
      clearProjectRootState: true,
    });

    assert.deepEqual(result, {
      worktreeRemoved: false,
      branchDeleteAttempted: false,
      activeWorkspaceCleared: false,
    });
    assert.deepEqual(
      calls,
      ["clear-state", "remove-worktree", "nudge-cache", "chdir-root"],
      "cleanup must not delete the branch or clear session state when worktree removal aborts",
    );
  });
});
