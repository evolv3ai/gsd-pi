import test from "node:test";
import assert from "node:assert/strict";

import {
  formatMultipleWorktreesPrompt,
  formatStatus,
  type WorktreeStatusLike,
} from "../worktree-cli-format.ts";

const changedStatus: WorktreeStatusLike = {
  name: "alpha",
  path: "/repo/.gsd-worktrees/alpha",
  branch: "worktree/alpha",
  filesChanged: 2,
  linesAdded: 7,
  linesRemoved: 3,
  uncommitted: false,
  commits: 1,
};

test("formatStatus renders changed, dirty, and clean worktree summaries", () => {
  const changed = formatStatus(changedStatus);
  assert.match(changed, /alpha/);
  assert.match(changed, /unmerged/);
  assert.match(changed, /branch\s+worktree\/alpha/);
  assert.match(changed, /path\s+\/repo\/\.gsd-worktrees\/alpha/);
  assert.match(changed, /diff\s+2 files, \+7 -3, 1 commit/);

  const dirty = formatStatus({ ...changedStatus, filesChanged: 0, uncommitted: true, commits: 0 });
  assert.match(dirty, /uncommitted/);
  assert.doesNotMatch(dirty, /diff\s+/);

  const clean = formatStatus({ ...changedStatus, filesChanged: 0, uncommitted: false, commits: 0 });
  assert.match(clean, /clean/);
  assert.doesNotMatch(clean, /diff\s+/);
});

test("formatStatus pluralizes files and commits", () => {
  const singular = formatStatus({ ...changedStatus, filesChanged: 1, commits: 1 });
  const plural = formatStatus({ ...changedStatus, filesChanged: 2, commits: 2 });

  assert.match(singular, /diff\s+1 file, \+7 -3, 1 commit/);
  assert.match(plural, /diff\s+2 files, \+7 -3, 2 commits/);
});

test("formatMultipleWorktreesPrompt preserves actionable -w guidance", () => {
  const output = formatMultipleWorktreesPrompt([changedStatus]);

  assert.match(output, /1 worktree has unmerged changes/);
  assert.match(output, /alpha/);
  assert.match(output, /Specify which one: gsd -w <name>/);
  assert.equal(output.endsWith("\n"), true);
});
