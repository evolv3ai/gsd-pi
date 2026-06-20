// Project/App: gsd-pi
// File Purpose: Doctor git checks treat validation-pass closeout as terminal without SUMMARY.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGSDDoctor } from "../doctor.ts";
import { openDatabase, insertMilestone, insertSlice, insertAssessment, closeDatabase } from "../gsd-db.js";
import { createWorktree, worktreePath } from "../worktree-manager.ts";

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  }).trim();
}

function makeRepo(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-terminal-"));
  runGit(["init", "-b", "main"], base);
  runGit(["config", "user.name", "Test User"], base);
  runGit(["config", "user.email", "test@example.com"], base);
  writeFileSync(join(base, "package.json"), "{\"scripts\":{}}\n", "utf-8");
  runGit(["add", "."], base);
  runGit(["commit", "-m", "chore: init"], base);
  return base;
}

test.after(() => {
  closeDatabase();
});

test("doctor flags orphaned worktree for DB-complete milestone without SUMMARY", async (t) => {
  const base = makeRepo();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M008", title: "Done", status: "complete" });
  insertSlice({ id: "S01", milestoneId: "M008", title: "Slice", status: "complete" });
  insertAssessment({
    path: "milestones/M008/M008-VALIDATION.md",
    milestoneId: "M008",
    status: "pass",
    scope: "milestone-validation",
    fullContent: "verdict: pass",
  });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    "---\ngit:\n  isolation: worktree\n---\n",
  );
  mkdirSync(join(base, ".gsd", "milestones", "M008"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "milestones", "M008", "M008-ROADMAP.md"),
    "# M008 Roadmap\n\n- [x] **S01: Slice** `risk:low` `depends:[]`\n",
  );

  createWorktree(base, "M008", { branch: "milestone/M008" });
  const wtPath = worktreePath(base, "M008");
  assert.ok(existsSync(wtPath), "worktree should exist for the test");

  const report = await runGSDDoctor(base, { isolationMode: "worktree" });

  assert.ok(
    report.issues.some((issue) => issue.code === "orphaned_auto_worktree" && issue.unitId === "M008"),
    "doctor should treat DB-complete milestone without SUMMARY as terminal for cleanup",
  );
});
