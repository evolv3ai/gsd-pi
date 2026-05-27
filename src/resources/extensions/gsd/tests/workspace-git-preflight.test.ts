// Project/App: gsd-pi
// File Purpose: Tests for workspace git conflict probe, heal, and readiness gate.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { probeGitConflictState } from "../git-conflict-state.js";
import { ensureWorkspaceGitReadyForPath } from "../workspace-git-preflight.js";
import { isWorkspaceGitAllowedCommand } from "../workspace-git-guard.js";
import { cleanup, git, makeTempRepo } from "./test-utils.ts";

function seedGsdConflict(base: string): void {
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, ".gsd", "STATE.md"), "root\n");
  git(base, "add", ".gsd/STATE.md");
  git(base, "commit", "-m", "add gsd state");
  git(base, "checkout", "-b", "side");
  writeFileSync(join(base, ".gsd", "STATE.md"), "side\n");
  git(base, "add", ".gsd/STATE.md");
  git(base, "commit", "-m", "side state");
  git(base, "checkout", "main");
  writeFileSync(join(base, ".gsd", "STATE.md"), "main\n");
  git(base, "add", ".gsd/STATE.md");
  git(base, "commit", "-m", "main state");
  try {
    git(base, "merge", "side");
  } catch {
    // Expected: merge conflict.
  }
}

function seedProductConflict(base: string): void {
  writeFileSync(join(base, "app.ts"), "root\n");
  git(base, "add", "app.ts");
  git(base, "commit", "-m", "add app");
  git(base, "checkout", "-b", "side");
  writeFileSync(join(base, "app.ts"), "side\n");
  git(base, "add", "app.ts");
  git(base, "commit", "-m", "side app");
  git(base, "checkout", "main");
  writeFileSync(join(base, "app.ts"), "main\n");
  git(base, "add", "app.ts");
  git(base, "commit", "-m", "main app");
  try {
    git(base, "merge", "side");
  } catch {
    // Expected: merge conflict.
  }
}

test("probeGitConflictState reports clean repo", () => {
  const base = makeTempRepo("gsd-ws-git-clean-");
  try {
    const result = probeGitConflictState(base);
    assert.equal(result.status, "clean");
  } finally {
    cleanup(base);
  }
});

test("ensureWorkspaceGitReadyForPath auto-resolves .gsd/ conflicts", async () => {
  const base = makeTempRepo("gsd-ws-git-heal-");
  try {
    seedGsdConflict(base);
    const dirty = probeGitConflictState(base);
    assert.equal(dirty.status, "dirty");
    if (dirty.status !== "dirty") return;
    assert.ok(dirty.unmerged.length > 0);

    const ready = await ensureWorkspaceGitReadyForPath(base);
    assert.equal(ready.ok, true);
    assert.ok(ready.fixesApplied.some((fix) => fix.includes("auto-resolved")));

    const after = probeGitConflictState(base);
    assert.equal(after.status, "clean");
  } finally {
    cleanup(base);
  }
});

test("ensureWorkspaceGitReadyForPath blocks product file conflicts", async () => {
  const base = makeTempRepo("gsd-ws-git-product-");
  try {
    seedProductConflict(base);
    const ready = await ensureWorkspaceGitReadyForPath(base);
    assert.equal(ready.ok, false);
    if (ready.ok) return;
    assert.equal(ready.severity, "product-conflicts");
    assert.ok(ready.conflictedPaths.includes("app.ts"));
  } finally {
    cleanup(base);
  }
});

test("isWorkspaceGitAllowedCommand allowlists doctor, closeout, and dispatch complete-milestone", () => {
  assert.equal(isWorkspaceGitAllowedCommand("doctor"), true);
  assert.equal(isWorkspaceGitAllowedCommand("doctor fix"), true);
  assert.equal(isWorkspaceGitAllowedCommand("closeout retry"), true);
  assert.equal(isWorkspaceGitAllowedCommand("dispatch complete-milestone M001"), true);
  assert.equal(isWorkspaceGitAllowedCommand("dispatch complete M001"), true);
  assert.equal(isWorkspaceGitAllowedCommand("auto"), false);
  assert.equal(isWorkspaceGitAllowedCommand("status"), false);
  assert.equal(isWorkspaceGitAllowedCommand("dispatch next"), false);
});
