// Project/App: gsd-pi
// File Purpose: Regression tests for DB-backed closeout consistency before merge.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { mergeMilestoneToMain } from "../auto-worktree.ts";
import { closeDatabase, insertMilestone, openDatabase } from "../gsd-db.ts";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "merge-closeout-gate-")));
  git(["init"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# test\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  git(["branch", "-M", "main"], dir);

  git(["checkout", "-b", "milestone/M001"], dir);
  writeFileSync(join(dir, "feature.ts"), "export const feature = true;\n");
  git(["add", "feature.ts"], dir);
  git(["commit", "-m", "feat: milestone work"], dir);
  git(["checkout", "main"], dir);
  return dir;
}

test("mergeMilestoneToMain blocks when project DB closeout is still open", () => {
  const savedCwd = process.cwd();
  const repo = createRepo();
  try {
    assert.equal(openDatabase(join(repo, ".gsd", "gsd.db")), true);
    insertMilestone({ id: "M001", title: "Milestone One", status: "active" });

    const mainHeadBefore = git(["rev-parse", "main"], repo);
    process.chdir(repo);

    assert.throws(
      () => mergeMilestoneToMain(repo, "M001", "# M001\n- [x] **S01: Done**\n"),
      /closeout-consistency-blocked/,
    );

    assert.equal(git(["rev-parse", "main"], repo), mainHeadBefore);
    assert.equal(git(["branch", "--show-current"], repo), "main");
  } finally {
    closeDatabase();
    process.chdir(savedCwd);
    if (existsSync(repo)) rmSync(repo, { recursive: true, force: true });
  }
});
