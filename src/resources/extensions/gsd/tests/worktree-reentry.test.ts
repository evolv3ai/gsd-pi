/**
 * worktree-reentry.test.ts — Unit tests for reenterActiveWorktreeIfNeeded.
 *
 * Covers the cold-start (/quit + relaunch) path where cwd lands at the project
 * root instead of the active milestone's worktree. The helper should chdir back
 * into the worktree deterministically, and no-op when it shouldn't act.
 */

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { createAutoWorktree, _resetAutoWorktreeOriginalBaseForTests } from "../auto-worktree.ts";
import { reenterActiveWorktreeIfNeeded } from "../worktree-reentry.ts";

// Safe: all inputs below are hardcoded test strings, not user input.
function git(subArgs: string[], cwd: string): void {
  execFileSync("git", subArgs, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function createTempRepo(
  t: { after: (fn: () => void) => void },
  opts: { isolation?: "worktree" | "none" } = {},
): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wt-reentry-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(["init"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "# test\n");
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  if (opts.isolation === "worktree") {
    writeFileSync(join(dir, ".gsd", "PREFERENCES.md"), "---\ngit:\n  isolation: worktree\n---\n", "utf-8");
  }
  const msDir = join(dir, ".gsd", "milestones", "M001");
  mkdirSync(msDir, { recursive: true });
  writeFileSync(join(msDir, "CONTEXT.md"), "# M001 Context\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  git(["branch", "-M", "main"], dir);
  return dir;
}

describe("reenterActiveWorktreeIfNeeded", () => {
  const savedCwd = process.cwd();

  beforeEach(() => {
    _resetAutoWorktreeOriginalBaseForTests();
    process.chdir(savedCwd);
  });

  test("re-enters the sole live worktree when sitting at the project root", async (t) => {
    const dir = createTempRepo(t, { isolation: "worktree" });
    t.after(() => process.chdir(savedCwd));

    // createAutoWorktree chdir's INTO the worktree; simulate a cold start by
    // returning to the project root with a clean workspace registry.
    createAutoWorktree(dir, "M001");
    process.chdir(dir);
    _resetAutoWorktreeOriginalBaseForTests();

    const entered = await reenterActiveWorktreeIfNeeded(dir);
    assert.ok(entered, "re-entry returned a worktree path");
    assert.strictEqual(realpathSync(process.cwd()), realpathSync(entered!), "cwd moved into the worktree");
    assert.strictEqual(entered, join(dir, ".gsd-worktrees", "M001"));
  });

  test("no-op when already inside a worktree", async (t) => {
    const dir = createTempRepo(t, { isolation: "worktree" });
    t.after(() => process.chdir(savedCwd));

    createAutoWorktree(dir, "M001"); // leaves cwd inside the worktree
    const cwdBefore = process.cwd();

    const entered = await reenterActiveWorktreeIfNeeded(dir);
    assert.strictEqual(entered, null, "no re-entry when already in a worktree");
    assert.strictEqual(process.cwd(), cwdBefore, "cwd unchanged");
  });

  test("no-op when isolation is not worktree", async (t) => {
    const dir = createTempRepo(t, { isolation: "none" });
    t.after(() => process.chdir(savedCwd));
    process.chdir(dir);

    const entered = await reenterActiveWorktreeIfNeeded(dir);
    assert.strictEqual(entered, null, "isolation=none never re-enters");
    assert.strictEqual(realpathSync(process.cwd()), realpathSync(dir), "cwd stays at project root");
  });

  test("no-op when there are no worktrees", async (t) => {
    const dir = createTempRepo(t, { isolation: "worktree" });
    t.after(() => process.chdir(savedCwd));
    process.chdir(dir);

    const entered = await reenterActiveWorktreeIfNeeded(dir);
    assert.strictEqual(entered, null, "nothing to re-enter");
    assert.strictEqual(realpathSync(process.cwd()), realpathSync(dir), "cwd stays at project root");
  });
});
