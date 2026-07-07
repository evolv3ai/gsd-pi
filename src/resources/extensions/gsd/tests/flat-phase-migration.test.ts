// Project/App: gsd-pi
// File Purpose: Tests the one-time migration from nested to flat-phase layout.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  _setFlatPhaseMigrationFsOpsForTest,
  migrateToFlatPhase,
  needsFlatPhaseMigration,
  pruneStaleFlatPhaseBackups,
} from "../flat-phase-migration.ts";
import { openDatabase, closeDatabase, insertArtifact, insertMilestone, insertSlice, insertTask, getAllMilestones, getMilestoneSlices, getSliceTasks, _getAdapter } from "../gsd-db.ts";

const tmpDirs: string[] = [];
function makeTmp(options: { withTask?: boolean } = {}): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-mig-${randomUUID()}`));
  // Create legacy nested structure
  const sliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  mkdirSync(
    options.withTask === false ? join(sliceDir, "tasks") : join(sliceDir, "tasks", "T01"),
    { recursive: true },
  );
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  insertSlice({
    milestoneId: "M001", id: "S01", title: "Set up tooling", status: "pending",
    risk: "low", depends: [], demo: "build runs", sequence: 1,
  });
  if (options.withTask !== false) {
    insertTask({
      milestoneId: "M001", sliceId: "S01", id: "T01", title: "Init repo",
      status: "pending", sequence: 1,
    });
  }
  tmpDirs.push(base);
  return base;
}
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

test("needsFlatPhaseMigration returns true when .gsd/milestones/ exists", () => {
  const base = makeTmp();
  assert.equal(needsFlatPhaseMigration(base), true);
});

test("needsFlatPhaseMigration returns false when no .gsd/milestones/", () => {
  const base = mkdtempSync(join(tmpdir(), `gsd-nomig-${randomUUID()}`));
  mkdirSync(join(base, ".gsd", "phases"), { recursive: true });
  tmpDirs.push(base);
  assert.equal(needsFlatPhaseMigration(base), false);
});

test("needsFlatPhaseMigration ignores legacy anchor runtime scaffolding", () => {
  const base = mkdtempSync(join(tmpdir(), `gsd-anchor-nomig-${randomUUID()}`));
  mkdirSync(join(base, ".gsd", "phases"), { recursive: true });
  mkdirSync(join(base, ".gsd", "milestones", "M001", "anchors"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "milestones", "M001", "anchors", "research-slice.json"),
    "{}",
    "utf-8",
  );
  tmpDirs.push(base);
  assert.equal(needsFlatPhaseMigration(base), false);
});

test("migrateToFlatPhase moves content from milestones/ to phases/", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);

  assert.ok(existsSync(join(base, ".gsd", "phases")), "phases/ should exist");
  assert.ok(!existsSync(join(base, ".gsd", "milestones")), "milestones/ should be removed");
});

test("migrateToFlatPhase ignores and removes stale phase dirs from prior aborted runs", async () => {
  const base = makeTmp();
  const stalePhaseDir = join(base, ".gsd", "phases", "99-stale-aborted-run");
  mkdirSync(stalePhaseDir, { recursive: true });

  await migrateToFlatPhase(base);

  assert.ok(existsSync(join(base, ".gsd", "phases", "01-foundation")), "current DB phase should render");
  assert.equal(existsSync(stalePhaseDir), false, "stale pre-existing phase dir should be removed");
});

test("migrateToFlatPhase falls back to copy-delete when legacy rename is blocked", async (t) => {
  const base = makeTmp();
  const milestonesPath = join(base, ".gsd", "milestones");
  const migratingPath = join(base, ".gsd", "milestones.migrating");
  let blockedRenameAttempts = 0;

  const restoreFsOps = _setFlatPhaseMigrationFsOpsForTest({
    renameSync(src, dst) {
      if (src === milestonesPath && dst === migratingPath) {
        blockedRenameAttempts++;
        throw Object.assign(new Error("simulated busy handle"), { code: "EPERM" });
      }
      return renameSync(src, dst);
    },
  });
  t.after(restoreFsOps);

  await migrateToFlatPhase(base);

  assert.equal(blockedRenameAttempts, 1, "test should exercise the rename fallback path");
  assert.ok(existsSync(join(base, ".gsd", "phases", "01-foundation")), "flat phase should render");
  assert.equal(existsSync(milestonesPath), false, "legacy milestones dir should be removed");
  assert.equal(existsSync(migratingPath), false, "staging dir should be removed after success");
});

test("migrateToFlatPhase creates a backup", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);
  assert.ok(existsSync(join(base, ".gsd-backups")), "backup should exist");
  const backups = readdirSync(join(base, ".gsd-backups")).filter(d => d.startsWith("migrate-"));
  assert.ok(backups.length >= 1, "at least one migrate-* backup dir should exist");
});

test("migrateToFlatPhase backs up existing phases projection before clearing it", async () => {
  const base = makeTmp();
  const reviewPath = join(base, ".gsd", "phases", "01-foundation", "PLAN-REVIEW.md");
  mkdirSync(join(base, ".gsd", "phases", "01-foundation"), { recursive: true });
  writeFileSync(reviewPath, "# Plan Review\n\nHand-authored review.", "utf-8");

  await migrateToFlatPhase(base);

  const backupRoot = join(base, ".gsd-backups");
  const backups = readdirSync(backupRoot).filter(d => d.startsWith("migrate-"));
  assert.equal(backups.length, 1, "one migrate backup should exist");
  const backedUpReview = join(backupRoot, backups[0]!, "__phases", "01-foundation", "PLAN-REVIEW.md");
  assert.equal(
    readFileSync(backedUpReview, "utf-8"),
    "# Plan Review\n\nHand-authored review.",
    "pre-existing phases/ files should have a recovery copy",
  );
});

test("failed migration rolls back without leaking a .gsd-backups/migrate-* dir", async (t) => {
  const base = makeTmp();
  const milestonesPath = join(base, ".gsd", "milestones");
  const phasesPath = join(base, ".gsd", "phases");

  // Fail the pre-render clear of phases/ to drive the rollback path, which by
  // this point has already created the .gsd-backups/migrate-<ts>/ backup.
  const restoreFsOps = _setFlatPhaseMigrationFsOpsForTest({
    rmSync(target, opts) {
      if (target === phasesPath) {
        throw Object.assign(new Error("simulated locked phases/"), { code: "EPERM" });
      }
      return rmSync(target, opts as never);
    },
  });
  t.after(restoreFsOps);

  await assert.rejects(migrateToFlatPhase(base), /simulated locked/);

  assert.ok(existsSync(milestonesPath), "legacy milestones/ should be restored on rollback");
  const backupRoot = join(base, ".gsd-backups");
  const leaked = existsSync(backupRoot)
    ? readdirSync(backupRoot).filter((d) => d.startsWith("migrate-"))
    : [];
  assert.equal(leaked.length, 0, "rollback must delete the migrate-* backup it created");
});

test("migrateToFlatPhase preserves milestone/slice/task counts in DB", async () => {
  const base = makeTmp();
  const msBefore = getAllMilestones().length;
  const slicesBefore = getMilestoneSlices("M001").length;
  const tasksBefore = getSliceTasks("M001", "S01").length;
  await migrateToFlatPhase(base);
  assert.equal(getAllMilestones().length, msBefore);
  assert.equal(getMilestoneSlices("M001").length, slicesBefore);
  assert.equal(getSliceTasks("M001", "S01").length, tasksBefore);
});

test("migrateToFlatPhase prunes legacy milestones artifact rows after flat render", async () => {
  const base = makeTmp();
  insertArtifact({
    path: "milestones/M001/M001-ROADMAP.md",
    artifact_type: "ROADMAP",
    milestone_id: "M001",
    slice_id: null,
    task_id: null,
    full_content: "# M001: Foundation\n",
  });
  insertArtifact({
    path: "milestones/M001/slices/S01/S01-PLAN.md",
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: null,
    full_content: "# Plan\n",
  });
  insertArtifact({
    path: "milestones/M001/slices/S01/tasks/T01-PLAN.md",
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T01",
    full_content: "# Task Plan\n",
  });

  await migrateToFlatPhase(base);

  const rows = _getAdapter()!
    .prepare("SELECT path FROM artifacts ORDER BY path")
    .all() as Array<{ path: string }>;
  assert.equal(
    rows.some((row) => row.path.startsWith("milestones/")),
    false,
    "legacy milestones/ artifact rows should be pruned after successful flat migration",
  );
  assert.ok(
    rows.some((row) => row.path.startsWith("phases/")),
    "flat-phase render should leave replacement projection rows in the artifacts table",
  );
});

test("migrateToFlatPhase prunes stale flat-phase artifact rows that renderAll intentionally skips", async () => {
  const base = makeTmp();
  insertArtifact({
    path: "phases/01-foundation/T01-PLAN.md",
    artifact_type: "PLAN",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: "T01",
    full_content: "# Legacy standalone task plan\n",
  });
  insertArtifact({
    path: "phases/01-foundation/01-01-RESEARCH.md",
    artifact_type: "RESEARCH",
    milestone_id: "M001",
    slice_id: "S01",
    task_id: null,
    full_content: "",
  });

  await migrateToFlatPhase(base);

  const rows = _getAdapter()!
    .prepare("SELECT path FROM artifacts ORDER BY path")
    .all() as Array<{ path: string }>;
  assert.equal(
    rows.some((row) => row.path === "phases/01-foundation/T01-PLAN.md"),
    false,
    "standalone task PLAN rows should be pruned when the flat renderer does not recreate the file",
  );
  assert.equal(
    rows.some((row) => row.path === "phases/01-foundation/01-01-RESEARCH.md"),
    false,
    "empty-content artifact rows should be pruned when the flat renderer skips the file",
  );
});

test("migrateToFlatPhase is idempotent (second run is a no-op)", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);
  // Second run should not throw and should not create a second backup
  await migrateToFlatPhase(base);
  const backups = readdirSync(join(base, ".gsd-backups")).filter(d => d.startsWith("migrate-"));
  assert.equal(backups.length, 1, "should only have one backup");
});

test("re-fired migration reuses the existing backup instead of leaking a new migrate-* dir (#1292)", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);
  const backupRoot = join(base, ".gsd-backups");
  const firstBackups = readdirSync(backupRoot).filter((d) => d.startsWith("migrate-"));
  assert.equal(firstBackups.length, 1, "first migration snapshots exactly one backup");

  // Simulate the re-fire: the legacy .gsd/milestones/ layout reappears (e.g. a
  // marker-key mismatch re-imports the whole tree). The DB rows still exist, so
  // the migration gate proceeds again — it must not snapshot a second backup.
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01"), { recursive: true });
  assert.equal(needsFlatPhaseMigration(base), true, "reappeared legacy layout re-triggers migration");

  await migrateToFlatPhase(base);

  const afterBackups = readdirSync(backupRoot).filter((d) => d.startsWith("migrate-"));
  assert.deepEqual(afterBackups, firstBackups, "re-fire must not leak a second migrate-* backup");
  assert.equal(existsSync(join(base, ".gsd", "milestones")), false, "legacy milestones/ removed again");
});

test("rollback after a re-fired migration preserves the reused migrate-* backup", async (t) => {
  const base = makeTmp();
  await migrateToFlatPhase(base);
  const backupRoot = join(base, ".gsd-backups");
  const firstBackups = readdirSync(backupRoot).filter((d) => d.startsWith("migrate-"));
  assert.equal(firstBackups.length, 1, "first migration snapshots exactly one backup");

  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01"), { recursive: true });
  const milestonesPath = join(base, ".gsd", "milestones");
  const phasesPath = join(base, ".gsd", "phases");

  const restoreFsOps = _setFlatPhaseMigrationFsOpsForTest({
    rmSync(target, opts) {
      if (target === phasesPath) {
        throw Object.assign(new Error("simulated locked phases/"), { code: "EPERM" });
      }
      return rmSync(target, opts as never);
    },
  });
  t.after(restoreFsOps);

  await assert.rejects(migrateToFlatPhase(base), /simulated locked/);

  const afterBackups = readdirSync(backupRoot).filter((d) => d.startsWith("migrate-"));
  assert.deepEqual(afterBackups, firstBackups, "rollback must preserve the reused backup");
  assert.ok(existsSync(milestonesPath), "legacy milestones/ should be restored on rollback");
});

test("migration ignores an empty/partial leftover backup and writes a complete one (#1292)", async () => {
  const base = makeTmp();

  // Simulate a prior first-time backup that crashed mid-cpSync: an empty
  // migrate-<ts>/ leftover with no milestones/ content. It is the newest entry,
  // so mtime-based selection would reuse it as the rollback copy if content were
  // not validated — silently retaining a recovery copy missing the legacy tree.
  const backupRoot = join(base, ".gsd-backups");
  const emptyLeftover = join(backupRoot, "migrate-crashed");
  mkdirSync(emptyLeftover, { recursive: true });

  await migrateToFlatPhase(base);

  assert.ok(existsSync(join(base, ".gsd", "phases", "01-foundation")), "flat phase should render");
  // The empty leftover must not have been reused; a fresh, content-bearing
  // backup that actually captured the legacy milestones/ tree must be created.
  const contentBackups = readdirSync(backupRoot)
    .filter((d) => d.startsWith("migrate-"))
    .filter((d) => existsSync(join(backupRoot, d, "M001")));
  assert.ok(
    contentBackups.length >= 1,
    "a complete backup containing the legacy milestones/ tree must be created, not the empty leftover",
  );
});

test("migrateToFlatPhase preserves slice sidecar artifacts and skips recovery placeholder PLAN", async () => {
  const base = makeTmp({ withTask: false });
  const legacySliceDir = join(base, ".gsd", "milestones", "M001", "slices", "S01");
  writeFileSync(join(legacySliceDir, "S01-CONTEXT.md"), "# Final Slice Context\n\nPrior discussion.", "utf-8");
  writeFileSync(join(legacySliceDir, "S01-RESEARCH.md"), "# Slice Research\n\nPrior research.", "utf-8");
  writeFileSync(join(legacySliceDir, "S01-CONTINUE.md"), "# Continue\n\nCompacted marker.", "utf-8");
  writeFileSync(
    join(legacySliceDir, "S01-PLAN.md"),
    "# BLOCKER - auto-mode recovery failed\n\nUnit `plan-slice` failed to produce this artifact.",
    "utf-8",
  );

  await migrateToFlatPhase(base);

  const phaseDir = join(base, ".gsd", "phases", "01-foundation");
  assert.equal(readFileSync(join(phaseDir, "01-01-CONTEXT.md"), "utf-8"), "# Final Slice Context\n\nPrior discussion.");
  assert.equal(readFileSync(join(phaseDir, "01-01-RESEARCH.md"), "utf-8"), "# Slice Research\n\nPrior research.");
  assert.equal(readFileSync(join(phaseDir, "01-01-CONTINUE.md"), "utf-8"), "# Continue\n\nCompacted marker.");
  assert.equal(
    existsSync(join(phaseDir, "01-01-PLAN.md")),
    false,
    "recovery placeholder PLAN should not be promoted when no DB tasks can render a real plan",
  );
});

test("pruneStaleFlatPhaseBackups removes migrate-* dirs older than retention window", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);

  const backupRoot = join(base, ".gsd-backups");
  assert.ok(existsSync(backupRoot), "backup should exist immediately after migration");

  const staleDir = join(backupRoot, "migrate-stale");
  mkdirSync(staleDir, { recursive: true });
  writeFileSync(join(staleDir, "marker.txt"), "old backup\n", "utf-8");
  const staleDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  utimesSync(staleDir, staleDate, staleDate);

  const removed = pruneStaleFlatPhaseBackups(base);
  assert.equal(removed, 1, "stale migrate-* dir should be pruned");
  assert.equal(existsSync(staleDir), false, "stale backup dir should be gone");
  assert.ok(existsSync(backupRoot), "fresh migration backup should remain");
});

test("pruneStaleFlatPhaseBackups is a no-op while flat-phase migration is still needed", () => {
  const base = makeTmp();
  const backupRoot = join(base, ".gsd-backups", "migrate-stale");
  mkdirSync(backupRoot, { recursive: true });
  writeFileSync(join(backupRoot, "marker.txt"), "old backup\n", "utf-8");
  const staleDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  utimesSync(backupRoot, staleDate, staleDate);

  assert.equal(pruneStaleFlatPhaseBackups(base), 0, "must not prune while migration is pending");
  assert.ok(existsSync(backupRoot), "backup must remain until migration completes");
});
