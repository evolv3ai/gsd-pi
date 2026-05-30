// Project/App: gsd-pi
// File Purpose: Tests milestone closeout settlement helper.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, insertMilestone, closeDatabase } from "../gsd-db.js";
import { isMilestoneCloseoutSettled } from "../milestone-closeout.js";

const tmpDirs: string[] = [];

test.after(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  closeDatabase();
});

test("isMilestoneCloseoutSettled requires DB closed and summary artifact", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-milestone-closeout-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Done", status: "complete" });
  const milestoneDir = join(base, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(join(milestoneDir, "M001-SUMMARY.md"), "# Milestone Summary\n");

  const settled = await isMilestoneCloseoutSettled("M001", base);
  assert.equal(settled, true);
});

test("isMilestoneCloseoutSettled returns false when summary artifact is missing", async () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-milestone-closeout-missing-"));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Open", status: "active" });

  const settled = await isMilestoneCloseoutSettled("M001", base);
  assert.equal(settled, false);
});
