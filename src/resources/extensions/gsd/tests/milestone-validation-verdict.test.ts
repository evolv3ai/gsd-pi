import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveMilestoneValidationVerdict } from "../milestone-validation-verdict.ts";
import {
  openDatabase,
  closeDatabase,
  insertAssessment,
  insertMilestone,
} from "../gsd-db.ts";
import { invalidateAllCaches } from "../cache.ts";
import { _clearGsdRootCache } from "../paths.ts";

function setup(base: string): void {
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  process.chdir(base);
  _clearGsdRootCache();
  openDatabase(join(base, ".gsd", "gsd.db"));
  invalidateAllCaches();
}

test("resolveMilestoneValidationVerdict prefers DB pass over stale worktree needs-attention", async () => {
  const base = join(tmpdir(), `validation-verdict-${Date.now()}`);
  mkdirSync(base, { recursive: true });
  const worktree = join(base, ".gsd", "worktrees", "M001");
  mkdirSync(join(worktree, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(worktree, ".git"), "gitdir: ../.git/worktrees/M001\n", "utf-8");
  writeFileSync(
    join(worktree, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
    "---\nverdict: needs-attention\n---\n\n# Validation\nStale worktree copy.\n",
  );

  try {
    setup(base);
    insertMilestone({ id: "M001", title: "Test", status: "active" });
    insertAssessment({
      path: join(worktree, ".gsd", "milestones", "M001", "M001-VALIDATION.md"),
      milestoneId: "M001",
      sliceId: null,
      taskId: null,
      status: "pass",
      scope: "milestone-validation",
      fullContent: "---\nverdict: pass\n---\n\n# Validation\nManual override.\n",
    });

    const verdict = await resolveMilestoneValidationVerdict(base, "M001");
    assert.equal(verdict, "pass");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
