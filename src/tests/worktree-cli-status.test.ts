import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getWorktreeStatus,
  hasWorktreeChanges,
  findWorktreesWithChanges,
  type WorktreeStatusDependencies,
} from "../worktree-cli-status.ts";

function makeDeps(overrides: Partial<WorktreeStatusDependencies> = {}): WorktreeStatusDependencies {
  return {
    diffWorktreeAll: () => ({ added: ["new.ts"], modified: ["changed.ts"], removed: ["old.ts"] }),
    diffWorktreeNumstat: () => [
      { added: 5, removed: 1 },
      { added: 8, removed: 3 },
    ],
    nativeHasChanges: () => true,
    nativeDetectMainBranch: () => "main",
    nativeCommitCountBetween: () => 2,
    onDebugFailure: () => {},
    ...overrides,
  };
}

test("getWorktreeStatus aggregates diff, dirty, and commit status", () => {
  const wtPath = mkdtempSync(join(tmpdir(), "gsd-worktree-cli-status-"));
  try {
    const status = getWorktreeStatus(makeDeps(), "/repo", "alpha", wtPath, "worktree/alpha");

    assert.deepEqual(status, {
      name: "alpha",
      path: wtPath,
      branch: "worktree/alpha",
      exists: true,
      filesChanged: 3,
      linesAdded: 13,
      linesRemoved: 4,
      uncommitted: true,
      commits: 2,
    });
  } finally {
    rmSync(wtPath, { recursive: true, force: true });
  }
});

test("getWorktreeStatus falls back loudly through debug callbacks when native checks fail", () => {
  const failures: string[] = [];
  const status = getWorktreeStatus(
    makeDeps({
      nativeHasChanges: () => {
        throw new Error("dirty unavailable");
      },
      nativeDetectMainBranch: () => {
        throw new Error("main unavailable");
      },
      onDebugFailure: (scope, error) => {
        failures.push(`${scope}: ${error instanceof Error ? error.message : String(error)}`);
      },
    }),
    "/repo",
    "alpha",
    "/path/that/does/not/exist",
    "worktree/alpha",
  );

  assert.equal(status.exists, false);
  assert.equal(status.uncommitted, false);
  assert.equal(status.commits, 0);
  assert.deepEqual(failures, ["native commit count: main unavailable"]);
});

test("hasWorktreeChanges checks changed files rather than uncommitted dirty state", () => {
  assert.equal(hasWorktreeChanges(makeDeps(), "/repo", "alpha", "worktree/alpha"), true);
  assert.equal(
    hasWorktreeChanges(
      makeDeps({ diffWorktreeAll: () => ({ added: [], modified: [], removed: [] }) }),
      "/repo",
      "alpha",
      "worktree/alpha",
    ),
    false,
  );
});

test("findWorktreesWithChanges skips scan failures and reports debug scope", () => {
  const failures: string[] = [];
  const worktrees = [
    { name: "alpha", path: "/repo/a", branch: "worktree/alpha" },
    { name: "beta", path: "/repo/b", branch: "worktree/beta" },
    { name: "gamma", path: "/repo/g", branch: "worktree/gamma" },
  ];
  const deps = makeDeps({
    diffWorktreeAll: (_basePath, name) => {
      if (name === "beta") throw new Error("diff failed");
      if (name === "gamma") return { added: [], modified: [], removed: [] };
      return { added: ["new.ts"], modified: [], removed: [] };
    },
    onDebugFailure: (scope, error) => {
      failures.push(`${scope}: ${error instanceof Error ? error.message : String(error)}`);
    },
  });

  assert.deepEqual(findWorktreesWithChanges(deps, "/repo", worktrees, "test scan"), [worktrees[0]]);
  assert.deepEqual(failures, ["test scan for beta: diff failed"]);
});
