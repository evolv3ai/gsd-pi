// gsd-pi — Regression tests for milestone branch/head reconciliation before merge.

import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { GSDError } from "../errors.js";
import { reconcileMilestoneBranchHead } from "../auto-worktree-merge-branch-head.js";

const cleanupPaths: string[] = [];
const initialCwd = process.cwd();

afterEach(() => {
  process.chdir(initialCwd);
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function commitFile(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(join(cwd, file), content);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function createRepoWithMilestoneWorktree(): { repo: string; worktree: string; branch: string } {
  const repo = mkdtempSync(join(tmpdir(), "gsd-branch-head-"));
  cleanupPaths.push(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.invalid"]);
  git(repo, ["config", "user.name", "Test"]);
  commitFile(repo, "README.md", "base\n", "initial");

  const branch = "milestone/M001";
  git(repo, ["branch", branch]);
  const worktree = join(repo, ".gsd-worktrees", "M001");
  git(repo, ["worktree", "add", worktree, branch]);
  git(worktree, ["config", "user.email", "test@example.invalid"]);
  git(worktree, ["config", "user.name", "Test"]);
  return { repo, worktree, branch };
}

describe("reconcileMilestoneBranchHead", () => {
  test("fast-forwards stale milestone branch ref to detached worktree HEAD", () => {
    const { repo, worktree, branch } = createRepoWithMilestoneWorktree();
    git(worktree, ["checkout", "--detach"]);
    const detachedHead = commitFile(worktree, "feature.txt", "worktree-only\n", "worktree detached commit");

    const result = reconcileMilestoneBranchHead({
      projectRoot: repo,
      worktreeCwd: worktree,
      milestoneBranch: branch,
      previousCwd: worktree,
    });

    assert.deepEqual(result, {
      checked: true,
      updated: true,
      reason: "fast-forwarded",
    });
    assert.equal(git(repo, ["rev-parse", branch]), detachedHead);
  });

  test("throws and restores cwd when worktree HEAD diverges from milestone branch", () => {
    const { repo, worktree, branch } = createRepoWithMilestoneWorktree();
    const baseHead = git(repo, ["rev-parse", branch]);
    git(worktree, ["checkout", "--detach", baseHead]);
    const detachedHead = commitFile(worktree, "worktree.txt", "detached\n", "detached side");

    git(repo, ["checkout", branch]);
    const branchHead = commitFile(repo, "branch.txt", "branch\n", "branch side");
    git(repo, ["checkout", "main"]);
    process.chdir(repo);

    assert.throws(
      () => reconcileMilestoneBranchHead({
        projectRoot: repo,
        worktreeCwd: worktree,
        milestoneBranch: branch,
        previousCwd: worktree,
      }),
      (err: unknown) => err instanceof GSDError && /diverged/.test(err.message),
    );

    assert.equal(git(repo, ["rev-parse", branch]), branchHead, "diverged branch ref must not be moved");
    assert.equal(git(worktree, ["rev-parse", "HEAD"]), detachedHead, "detached worktree commit remains for manual recovery");
    assert.equal(realpathSync(process.cwd()), realpathSync(worktree), "divergence restores cwd to previous worktree");
  });

  test("skips reconciliation when cwd is already the project root", () => {
    const { repo, branch } = createRepoWithMilestoneWorktree();

    const result = reconcileMilestoneBranchHead({
      projectRoot: repo,
      worktreeCwd: repo,
      milestoneBranch: branch,
      previousCwd: repo,
    });

    assert.deepEqual(result, {
      checked: false,
      updated: false,
      reason: "not-worktree",
    });
  });
});
