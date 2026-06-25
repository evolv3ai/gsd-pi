import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveExpectedArtifactPath } from "../auto-artifact-paths.ts";
import { clearPathCache, _clearGsdRootCache, isLegacyMilestonesLayout, milestonesDir } from "../paths.ts";

test("worktree artifact resolution falls back to project .gsd artifacts", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-auto-artifact-")));
  try {
    const projectGsd = join(root, ".gsd");
    const wtRoot = join(projectGsd, "worktrees", "M001");
    const wtGsd = join(wtRoot, ".gsd");
    const projectMilestoneDir = join(projectGsd, "milestones", "M001");
    const projectSliceDir = join(projectMilestoneDir, "slices", "S01");

    mkdirSync(projectSliceDir, { recursive: true });
    mkdirSync(wtGsd, { recursive: true });
    writeFileSync(join(projectMilestoneDir, "M001-ROADMAP.md"), "# roadmap\n");
    writeFileSync(join(projectSliceDir, "S01-PLAN.md"), "# plan\n");

    _clearGsdRootCache();
    clearPathCache();

    assert.equal(
      resolveExpectedArtifactPath("plan-milestone", "M001", wtRoot),
      join(projectMilestoneDir, "M001-ROADMAP.md"),
    );
    assert.equal(
      resolveExpectedArtifactPath("plan-slice", "M001/S01", wtRoot),
      join(projectSliceDir, "S01-PLAN.md"),
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── #852 follow-up: metadata-only milestones/<MID>/ must not flip the layout ──
//
// git-service.ts creates milestones/<MID>/ to store <MID>-META.json (the
// integration-branch metadata) even in flat-phase projects. Before this fix,
// the existence of that dir made layout detection conclude "legacy", so
// verification resolved the CONTEXT/ROADMAP to milestones/<MID>/<MID>-CONTEXT.md
// (which doesn't exist in a flat-phase project) instead of phases/NN-slug/ —
// trapping the unit in a finalize-retry loop. A milestones/<MID>/ dir holding
// only *-META.json must NOT count as a real legacy milestone.

test("metadata-only milestones/<MID>/ does not flip layout to legacy (#852)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-meta-pollution-")));
  try {
    const gsd = join(root, ".gsd");
    // Flat-phase layout: phases/15-m015/ with real content.
    const phaseDir = join(gsd, "phases", "15-m015");
    mkdirSync(phaseDir, { recursive: true });
    writeFileSync(join(phaseDir, "15-CONTEXT.md"), "# context\n");

    // Pollution: git-service.ts creates milestones/M015/ for META.json only.
    const metaDir = join(gsd, "milestones", "M015");
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(metaDir, "M015-META.json"), '{"branch":"milestone/M015"}');

    _clearGsdRootCache();
    clearPathCache();

    // The metadata-only dir must NOT make this look like a legacy project.
    assert.equal(isLegacyMilestonesLayout(root), false, "metadata-only milestones dir must not flip layout");
    assert.ok(milestonesDir(root).endsWith(join(".gsd", "phases")), "milestonesDir resolves to phases/ not milestones/");

    // And the discuss-milestone CONTEXT artifact must resolve to the flat-phase path.
    assert.equal(
      resolveExpectedArtifactPath("discuss-milestone", "M015", root),
      join(phaseDir, "15-CONTEXT.md"),
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("content-bearing milestones/<MID>/ still resolves to legacy (#852 regression guard)", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gsd-legacy-real-")));
  try {
    // Legacy layout: milestones/M001/ with real content (not just META).
    const legacyDir = join(root, ".gsd", "milestones", "M001");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "M001-CONTEXT.md"), "# context\n");

    _clearGsdRootCache();
    clearPathCache();

    assert.equal(isLegacyMilestonesLayout(root), true, "content-bearing milestones dir is legacy");
    assert.equal(
      resolveExpectedArtifactPath("discuss-milestone", "M001", root),
      join(legacyDir, "M001-CONTEXT.md"),
    );
  } finally {
    _clearGsdRootCache();
    clearPathCache();
    rmSync(root, { recursive: true, force: true });
  }
});
