// gsd-pi — Milestone directory shelter characterization tests.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createMilestoneDirectoryShelter,
  _setRestoreEntryFnForTests,
} from "../auto-worktree-milestone-shelter.ts";

function createWorkspace(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "gsd-shelter-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".gsd", "milestones", "M001"), { recursive: true });
  mkdirSync(join(root, ".gsd", "milestones", "M002"), { recursive: true });
  writeFileSync(join(root, ".gsd", "milestones", "M001", "CONTEXT.md"), "# target\n");
  writeFileSync(join(root, ".gsd", "milestones", "M002", "CONTEXT.md"), "# queued\n");
  return root;
}

test("milestone directory shelter restores queued milestone dirs and cleans the shelter", (t) => {
  const root = createWorkspace(t);

  const shelter = createMilestoneDirectoryShelter(root, "M001", "Target milestone");

  assert.ok(existsSync(join(root, ".gsd", "milestones", "M001", "CONTEXT.md")), "target milestone is not sheltered");
  assert.ok(!existsSync(join(root, ".gsd", "milestones", "M002")), "queued milestone is moved out before stash");
  assert.ok(existsSync(join(root, ".gsd", ".milestone-shelter", "M002", "CONTEXT.md")), "queued milestone is recoverable from shelter");

  shelter.restore();
  shelter.restore();

  assert.equal(readFileSync(join(root, ".gsd", "milestones", "M002", "CONTEXT.md"), "utf8"), "# queued\n");
  assert.ok(!existsSync(join(root, ".gsd", ".milestone-shelter")), "shelter is removed after successful restore");
});

test("milestone directory shelter retains recoverable copy when restore entry fails", (t) => {
  const root = createWorkspace(t);
  const restoreDefault = _setRestoreEntryFnForTests(() => {
    throw new Error("forced restore failure");
  });
  t.after(restoreDefault);

  const shelter = createMilestoneDirectoryShelter(root, "M001", "Target milestone");
  shelter.restore();

  assert.ok(!existsSync(join(root, ".gsd", "milestones", "M002", "CONTEXT.md")), "failed restore does not pretend queued files were restored");
  assert.equal(readFileSync(join(root, ".gsd", ".milestone-shelter", "M002", "CONTEXT.md"), "utf8"), "# queued\n");
});
