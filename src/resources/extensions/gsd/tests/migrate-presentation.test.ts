import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildMigrationPreviewSummary,
  buildReviewPrompt,
  formatMigrationPreviewStats,
} from "../migrate/presentation.ts";
import { gsdRoot } from "../paths.ts";
import type { MigrationPreview } from "../migrate/writer.ts";

function previewFixture(overrides: Partial<MigrationPreview> = {}): MigrationPreview {
  return {
    decisions: { total: 2 },
    migrationInputs: {
      milestonePhaseDirs: 3,
      decisions: 2,
      seeds: 1,
    },
    milestoneCount: 1,
    totalSlices: 2,
    totalTasks: 5,
    doneSlices: 1,
    doneTasks: 3,
    sliceCompletionPct: 50,
    taskCompletionPct: 60,
    requirements: {
      active: 1,
      validated: 2,
      deferred: 1,
      outOfScope: 1,
      total: 5,
    },
    ...overrides,
  };
}

test("buildMigrationPreviewSummary includes counts, legacy inputs, and existing-target warning", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-migrate-presentation-"));
  try {
    mkdirSync(join(base, ".gsd"), { recursive: true });

    assert.deepEqual(buildMigrationPreviewSummary(previewFixture(), base), [
      "Decisions: 2",
      "Milestones: 1",
      "Slices: 2 (1 done — 50%)",
      "Tasks: 5 (3 done — 60%)",
      "Requirements: 5 (2 validated, 1 active, 1 deferred, 1 out of scope)",
      "Legacy inputs: 3 milestone phase dir(s), 2 decision file(s), 1 seed file(s)",
      "",
      `⚠ A .gsd directory already exists at ${gsdRoot(base)}.`,
      "It will be backed up, deleted, and rewritten fresh before DB import.",
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("formatMigrationPreviewStats uses bullet formatting for review prompts", () => {
  assert.equal(
    formatMigrationPreviewStats(previewFixture({ requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, total: 0 } })),
    [
      "- Decisions: 2",
      "- Milestones: 1",
      "- Slices: 2 (1 done — 50%)",
      "- Tasks: 5 (3 done — 60%)",
      "- Legacy inputs: 3 milestone phase dir(s), 2 decision file(s), 1 seed file(s)",
    ].join("\n"),
  );
});

test("buildReviewPrompt interpolates source, target, and preview stats", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-migrate-prompt-"));
  try {
    const promptsDir = join(base, "prompts");
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      join(promptsDir, "review-migration.md"),
      "Source={{sourcePath}}\nTarget={{gsdPath}}\nStats:\n{{previewStats}}\n",
    );

    const prompt = buildReviewPrompt({
      sourcePath: "/legacy/.planning",
      gsdPath: "/project/.gsd",
      preview: previewFixture(),
      templatePath: join(promptsDir, "review-migration.md"),
    });

    assert.match(prompt, /Source=\/legacy\/\.planning/);
    assert.match(prompt, /Target=\/project\/\.gsd/);
    assert.match(prompt, /- Requirements: 5 \(2 validated, 1 active, 1 deferred, 1 out of scope\)/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
