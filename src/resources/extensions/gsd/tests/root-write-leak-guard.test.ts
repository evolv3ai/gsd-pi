// Project/App: gsd-pi
// File Purpose: Regression tests for project-root dirty snapshot fingerprints.

import test from "node:test";
import assert from "node:assert/strict";
import { closeSync, ftruncateSync, openSync, statSync } from "node:fs";
import { join } from "node:path";

import { captureRootDirtySnapshot, detectRootWriteLeak } from "../root-write-leak-guard.ts";
import { cleanup, createFile, makeTempRepo } from "./test-utils.ts";

test("captureRootDirtySnapshot ignores unignored GSD root runtime directories", () => {
  const base = makeTempRepo("gsd-root-dirty-runtime-");
  try {
    createFile(base, ".gsd/STATE.md", "state\n");
    createFile(base, ".gsd-backups/snap-001", "backup\n");
    createFile(base, ".gsd-worktrees/M001/file.txt", "worktree\n");
    createFile(base, "src/foo.ts", "export {};\n");

    const snapshot = captureRootDirtySnapshot(base);

    assert.equal(snapshot.has(".gsd/STATE.md"), false);
    assert.equal(snapshot.has(".gsd-backups/snap-001"), false);
    assert.equal(snapshot.has(".gsd-worktrees/M001/file.txt"), false);
    assert.equal(snapshot.has("src/foo.ts"), true);
  } finally {
    cleanup(base);
  }
});

test("captureRootDirtySnapshot does not read dirty files larger than Node's Buffer limit", () => {
  const base = makeTempRepo("gsd-root-dirty-large-");
  try {
    const relPath = "large.bin";
    const absPath = join(base, relPath);

    const fd = openSync(absPath, "w");
    try {
      ftruncateSync(fd, 2_200 * 1024 * 1024);
    } finally {
      closeSync(fd);
    }

    const size = statSync(absPath).size;
    assert.ok(size > 2 * 1024 * 1024 * 1024, "fixture must exceed Node's readFileSync Buffer limit");

    const snapshot = captureRootDirtySnapshot(base);
    const entry = snapshot.get(relPath);

    assert.equal(entry?.status, "??");
    assert.match(entry?.fingerprint ?? "", /^large:\d+:/);
  } finally {
    cleanup(base);
  }
});

test("detectRootWriteLeak reports changed baseline untracked root files", () => {
  const base = makeTempRepo("gsd-root-dirty-baseline-");
  try {
    const relPath = "notes/todo.md";
    createFile(base, relPath, "before\n");
    const before = captureRootDirtySnapshot(base);

    createFile(base, relPath, "after\n");
    const leak = detectRootWriteLeak({
      rootPath: base,
      worktreePath: join(base, ".gsd", "worktrees", "M001"),
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      before,
    });

    assert.ok(leak, "changed baseline untracked file should be reported as a leak");
    assert.deepEqual(
      leak.files.map((file) => file.path),
      [relPath],
    );
  } finally {
    cleanup(base);
  }
});
