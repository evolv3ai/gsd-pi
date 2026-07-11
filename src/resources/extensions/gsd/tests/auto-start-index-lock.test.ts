import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { hasGitIndexLockForTest, reconcileFlatPhaseBootstrapLayout } from "../auto-start.ts";

test("bootstrapAutoSession detects .git/index.lock without deleting it", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-index-lock-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const lockPath = join(base, ".git", "index.lock");
  mkdirSync(join(base, ".git"), { recursive: true });
  writeFileSync(lockPath, "locked\n", "utf-8");

  assert.equal(hasGitIndexLockForTest(base), true);
  assert.equal(existsSync(lockPath), true);
});

test("bootstrapAutoSession reports no index lock when the lock file is absent", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-index-lock-missing-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, ".git"), { recursive: true });

  assert.equal(hasGitIndexLockForTest(base), false);
});

test("bootstrapAutoSession removes empty legacy milestones dir in flat-phase projects", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-flat-bootstrap-clean-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(join(base, ".gsd", "phases"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });

  assert.equal(reconcileFlatPhaseBootstrapLayout(base), true);
  assert.equal(existsSync(join(base, ".gsd", "phases")), true);
  assert.equal(existsSync(join(base, ".gsd", "milestones")), false);
});

test("bootstrapAutoSession creates phases instead of milestones for empty GSD state", (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-flat-bootstrap-init-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  assert.equal(reconcileFlatPhaseBootstrapLayout(base), true);
  assert.equal(existsSync(join(base, ".gsd", "phases")), true);
  assert.equal(existsSync(join(base, ".gsd", "milestones")), false);
});
