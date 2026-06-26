// Project/App: gsd-pi
// File Purpose: Tests the one-time migration from nested to flat-phase layout.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { migrateToFlatPhase, needsFlatPhaseMigration } from "../flat-phase-migration.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask, getAllMilestones, getMilestoneSlices, getSliceTasks } from "../gsd-db.ts";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-mig-${randomUUID()}`));
  // Create legacy nested structure
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  insertSlice({
    milestoneId: "M001", id: "S01", title: "Set up tooling", status: "pending",
    risk: "low", depends: [], demo: "build runs", sequence: 1,
  });
  insertTask({
    milestoneId: "M001", sliceId: "S01", id: "T01", title: "Init repo",
    status: "pending", sequence: 1,
  });
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

test("migrateToFlatPhase moves content from milestones/ to phases/", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);

  assert.ok(existsSync(join(base, ".gsd", "phases")), "phases/ should exist");
  assert.ok(!existsSync(join(base, ".gsd", "milestones")), "milestones/ should be removed");
});

test("migrateToFlatPhase creates a backup", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);
  assert.ok(existsSync(join(base, ".gsd-backups")), "backup should exist");
  const backups = readdirSync(join(base, ".gsd-backups")).filter(d => d.startsWith("migrate-"));
  assert.ok(backups.length >= 1, "at least one migrate-* backup dir should exist");
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

test("migrateToFlatPhase is idempotent (second run is a no-op)", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);
  // Second run should not throw and should not create a second backup
  await migrateToFlatPhase(base);
  const backups = readdirSync(join(base, ".gsd-backups")).filter(d => d.startsWith("migrate-"));
  assert.equal(backups.length, 1, "should only have one backup");
});
