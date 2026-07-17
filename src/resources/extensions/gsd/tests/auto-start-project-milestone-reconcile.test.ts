import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { _getAdapter, closeDatabase, getAllMilestones, getMilestone, insertMilestone, isDbAvailable, openDatabase } from "../gsd-db.ts";
import { reconcileMergedMilestonesFromJournal, reconcileProjectMilestonesFromDisk } from "../auto-start.ts";
import { emitWorktreeMerged } from "../worktree-telemetry.ts";

test.afterEach(() => {
  if (isDbAvailable()) closeDatabase();
});

test("bootstrap reconciliation treats a successful worktree merge as milestone closed", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-merged-reconcile-"));
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Merged Milestone", status: "active" });

    emitWorktreeMerged(base, "M001", { reason: "milestone-complete", conflict: false });

    const closed = reconcileMergedMilestonesFromJournal(base);
    const row = getMilestone("M001");

    assert.equal(closed, 1);
    assert.equal(row?.status, "complete");
    assert.ok(row?.completed_at);
  } finally {
    if (isDbAvailable()) closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("bootstrap does not promote PROJECT.md milestones into canonical authority", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-project-reconcile-"));
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    writeFileSync(
      join(base, ".gsd", "PROJECT.md"),
      `# Project

## Milestone Sequence
- [x] M001: Existing Milestone - Already complete
- [ ] M002: New Milestone - Should be queued
- [ ] M003: Another New Milestone - Should be queued
`,
      "utf-8",
    );

    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Existing Milestone", status: "complete" });
    const before = getAllMilestones();
    const changesBefore = Number(
      _getAdapter()!.prepare("SELECT total_changes() AS count").get()?.["count"],
    );

    const inserted = reconcileProjectMilestonesFromDisk(base);
    const rows = getAllMilestones();

    assert.equal(inserted, 0);
    assert.deepEqual(rows, before);
    assert.equal(
      Number(_getAdapter()!.prepare("SELECT total_changes() AS count").get()?.["count"]),
      changesBefore,
    );
  } finally {
    if (isDbAvailable()) closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("#1236: bootstrap merged-milestone reconciliation degrades to a warning instead of aborting when the DB is degraded", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-merged-reconcile-degraded-"));
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Merged Milestone", status: "active" });

    emitWorktreeMerged(base, "M001", { reason: "milestone-complete", conflict: false });

    // Simulate a degraded DB: the connection stays "available" (isDbAvailable()
    // remains true because the handle is non-null), but the milestones table is
    // gone, so the reconciler's DB access throws partway through bootstrap.
    _getAdapter()!.exec("DROP TABLE milestones");
    assert.equal(isDbAvailable(), true);

    // Regression (#1236): this reconciler was previously unguarded, so a
    // degraded-DB failure threw and aborted the rest of `/gsd auto` bootstrap.
    // It must now catch, warn, and return 0, matching its sibling
    // reconcileProjectMilestonesFromDisk. Reaching the assertion proves it did
    // not throw.
    const closed = reconcileMergedMilestonesFromJournal(base);
    assert.equal(closed, 0);
  } finally {
    if (isDbAvailable()) closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
