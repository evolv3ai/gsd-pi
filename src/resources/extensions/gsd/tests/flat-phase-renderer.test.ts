// Project/App: gsd-pi
// File Purpose: Verifies the renderer emits flat-phase paths and tasks-as-checkboxes.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { renderPlanFromDb, renderRoadmapFromDb } from "../markdown-renderer.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask } from "../gsd-db.ts";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-fp-${randomUUID()}`));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  insertSlice({
    milestoneId: "M001", id: "S01", title: "Set up tooling", status: "pending",
    risk: "low", depends: [], demo: "build runs", sequence: 1,
  });
  insertTask({
    milestoneId: "M001", sliceId: "S01", id: "T01", title: "Init repo",
    status: "pending", sequence: 1,
    planning: { estimate: "30m" },
  });
  tmpDirs.push(base);
  return base;
}
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

test("renderRoadmapFromDb writes to .gsd/phases/ not .gsd/milestones/", async () => {
  const base = makeTmp();
  await renderRoadmapFromDb(base, "M001");
  const phasesDir = join(base, ".gsd", "phases");
  const milestonesDir = join(base, ".gsd", "milestones");
  assert.ok(existsSync(phasesDir), "expected .gsd/phases/ to exist");
  assert.ok(!existsSync(milestonesDir), "expected .gsd/milestones/ to NOT exist");
});

test("renderPlanFromDb writes NN-MM-PLAN.md inside the phase dir", async () => {
  const base = makeTmp();
  const result = await renderPlanFromDb(base, "M001", "S01");
  assert.match(result.planPath, /phases[/\\]01-[^/\\]+[/\\]01-01-PLAN\.md$/);
  assert.ok(existsSync(result.planPath), "plan file should exist on disk");
});

test("renderPlanFromDb emits <tasks> block with task checkboxes", async () => {
  const base = makeTmp();
  const result = await renderPlanFromDb(base, "M001", "S01");
  const plan = readFileSync(result.planPath, "utf-8");
  assert.match(plan, /<tasks>/);
  assert.match(plan, /<\/tasks>/);
  assert.match(plan, /- \[ \] \*\*T01\*\*: Init repo/);
});

test("renderPlanFromDb does NOT create a tasks/ subdir", async () => {
  const base = makeTmp();
  await renderPlanFromDb(base, "M001", "S01");
  const phasesDir = join(base, ".gsd", "phases");
  const scanForTasksDir = (dir: string): boolean => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name === "tasks") return true;
        if (scanForTasksDir(join(dir, e.name))) return true;
      }
    }
    return false;
  };
  assert.ok(!scanForTasksDir(phasesDir), "no tasks/ subdir should exist under phases/");
});

test("renderPlanFromDb does NOT write per-task plan files", async () => {
  const base = makeTmp();
  const result = await renderPlanFromDb(base, "M001", "S01");
  // taskPlanPaths should be empty — no per-task files written
  assert.equal(result.taskPlanPaths.length, 0);
});
