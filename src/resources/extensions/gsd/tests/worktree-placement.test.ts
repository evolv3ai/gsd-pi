/**
 * Tests for worktreePathFor — the forward seam (project + name → path).
 *
 * Key invariant: a stale canonical directory (no .git marker) must NOT
 * shadow a live legacy worktree (.gsd/worktrees/<name> with .git).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { worktreePathFor, canonicalWorktreesDir, legacyWorktreesDir } from "../worktree-placement.ts";

function makeTmpRoot(): string {
  const root = join(tmpdir(), `gsd-placement-test-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function cleanup(root: string): void {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* */ }
}

function makeCanonicalDir(root: string, name: string): string {
  const p = join(canonicalWorktreesDir(root), name);
  mkdirSync(p, { recursive: true });
  return p;
}

function makeLiveCanonical(root: string, name: string): string {
  const p = makeCanonicalDir(root, name);
  writeFileSync(join(p, ".git"), `gitdir: ${join(root, ".git", "worktrees", name)}\n`);
  return p;
}

function makeLiveLegacy(root: string, name: string): string {
  const p = join(legacyWorktreesDir(root), name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, ".git"), `gitdir: ${join(root, ".git", "worktrees", name)}\n`);
  return p;
}

test("returns canonical path when canonical has .git marker", () => {
  const root = makeTmpRoot();
  try {
    const canonical = makeLiveCanonical(root, "M001");
    assert.equal(worktreePathFor(root, "M001"), canonical);
  } finally {
    cleanup(root);
  }
});

test("returns legacy path when only legacy exists with .git marker", () => {
  const root = makeTmpRoot();
  try {
    const legacy = makeLiveLegacy(root, "M001");
    assert.equal(worktreePathFor(root, "M001"), legacy);
  } finally {
    cleanup(root);
  }
});

test("returns legacy path when canonical dir exists but has no .git (stale canonical)", () => {
  const root = makeTmpRoot();
  try {
    makeCanonicalDir(root, "M001"); // stale: dir exists, no .git
    const legacy = makeLiveLegacy(root, "M001");
    assert.equal(
      worktreePathFor(root, "M001"),
      legacy,
      "stale canonical must not shadow live legacy worktree",
    );
  } finally {
    cleanup(root);
  }
});

test("returns canonical path for new-worktree creation when neither path exists", () => {
  const root = makeTmpRoot();
  try {
    const expected = join(canonicalWorktreesDir(root), "M001");
    assert.equal(worktreePathFor(root, "M001"), expected);
  } finally {
    cleanup(root);
  }
});

test("prefers live canonical over live legacy when both exist", () => {
  const root = makeTmpRoot();
  try {
    const canonical = makeLiveCanonical(root, "M001");
    makeLiveLegacy(root, "M001");
    assert.equal(worktreePathFor(root, "M001"), canonical);
  } finally {
    cleanup(root);
  }
});

test("returns legacy when canonical is stale and legacy has no .git (both stale)", () => {
  const root = makeTmpRoot();
  try {
    makeCanonicalDir(root, "M001"); // stale canonical
    const legacy = join(legacyWorktreesDir(root), "M001");
    mkdirSync(legacy, { recursive: true }); // stale legacy (no .git)
    // Falls through to legacy existsSync since canonical has no .git
    assert.equal(worktreePathFor(root, "M001"), legacy);
  } finally {
    cleanup(root);
  }
});
