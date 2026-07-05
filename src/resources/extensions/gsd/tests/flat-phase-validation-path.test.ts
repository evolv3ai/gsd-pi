// Project/App: gsd-pi
// File Purpose: Regression test for upstream issue #876 — flat-phase
// validation-path readers must use layout-aware helpers, not hardcoded
// legacy paths.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRealPath, relMilestoneFile, relSliceFile, resolveMilestoneFile, targetMilestoneFile } from "../paths.ts";

function makeFlatPhaseFixture(): { basePath: string; cleanup: () => void } {
  const basePath = mkdtempSync(join(tmpdir(), "flat-phase-validation-"));
  const phaseDir = join(basePath, ".gsd", "phases", "01-foo");
  mkdirSync(phaseDir, { recursive: true });
  const validationPath = join(phaseDir, "01-VALIDATION.md");
  writeFileSync(
    validationPath,
    [
      "---",
      "verdict: pass",
      "---",
      "",
      "# M001 Validation",
      "",
      "All slices verified.",
      "",
    ].join("\n"),
    "utf-8",
  );
  return { basePath, cleanup: () => rmSync(basePath, { recursive: true, force: true }) };
}

test("flat-phase: relMilestoneFile resolves to the layout-aware path", (t) => {
  const { basePath, cleanup } = makeFlatPhaseFixture();
  t.after(cleanup);

  const rel = relMilestoneFile(basePath, "M001", "VALIDATION");
  assert.equal(rel, ".gsd/phases/01-foo/01-VALIDATION.md");
  const abs = join(basePath, rel);
  assert.equal(existsSync(abs), true);
});

test("flat-phase: relMilestoneFile fallback uses the milestone title when no directory exists", (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "flat-phase-missing-dir-"));
  t.after(() => rmSync(basePath, { recursive: true, force: true }));

  const rel = relMilestoneFile(basePath, "M001", "ROADMAP", "Milestone");
  assert.equal(rel, ".gsd/phases/01-milestone/01-ROADMAP.md");
});

test("legacy layout: relMilestoneFile fallback stays in milestones when the target dir is missing", (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "legacy-missing-dir-"));
  t.after(() => rmSync(basePath, { recursive: true, force: true }));
  const existingLegacyDir = join(basePath, ".gsd", "milestones", "M002");
  mkdirSync(existingLegacyDir, { recursive: true });
  writeFileSync(join(existingLegacyDir, "M002-ROADMAP.md"), "# existing legacy roadmap\n");

  const rel = relMilestoneFile(basePath, "M001", "ROADMAP", "Milestone");

  assert.equal(rel, ".gsd/milestones/M001/M001-ROADMAP.md");
});

test("legacy layout: relSliceFile fallback uses slices directory when target milestone is missing", (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "legacy-missing-slice-"));
  t.after(() => rmSync(basePath, { recursive: true, force: true }));
  const existingLegacyDir = join(basePath, ".gsd", "milestones", "M002");
  mkdirSync(existingLegacyDir, { recursive: true });
  writeFileSync(join(existingLegacyDir, "M002-ROADMAP.md"), "# existing legacy roadmap\n");

  const rel = relSliceFile(basePath, "M001", "S01", "PLAN", "Milestone");

  assert.equal(rel, ".gsd/milestones/M001/slices/S01/S01-PLAN.md");
});

test("flat-phase: targetMilestoneFile ignores legacy-named compatibility files when writing", (t) => {
  const basePath = mkdtempSync(join(tmpdir(), "flat-phase-legacy-named-file-"));
  t.after(() => rmSync(basePath, { recursive: true, force: true }));
  const phaseDir = join(basePath, ".gsd", "phases", "01-foo");
  mkdirSync(phaseDir, { recursive: true });
  writeFileSync(join(phaseDir, "M001-ROADMAP.md"), "# legacy named roadmap\n");

  assert.equal(
    targetMilestoneFile(basePath, "M001", "ROADMAP", "Foo"),
    join(normalizeRealPath(phaseDir), "01-ROADMAP.md"),
  );
  assert.equal(relMilestoneFile(basePath, "M001", "ROADMAP", "Foo"), ".gsd/phases/01-foo/M001-ROADMAP.md");
});

test("flat-phase: resolveMilestoneFile finds the on-disk file", (t) => {
  const { basePath, cleanup } = makeFlatPhaseFixture();
  t.after(cleanup);

  const abs = resolveMilestoneFile(basePath, "M001", "VALIDATION");
  assert.ok(abs, "resolveMilestoneFile must return a path for the flat-phase fixture");
  assert.equal(abs!.endsWith("/.gsd/phases/01-foo/01-VALIDATION.md"), true);
  assert.equal(existsSync(abs!), true);
});

test("flat-phase: the legacy hardcoded path does NOT resolve (regression for #876)", (t) => {
  const { basePath, cleanup } = makeFlatPhaseFixture();
  t.after(cleanup);

  // This is the path that auto-verification.ts:264-270 used to construct.
  // It must NOT exist on a flat-phase project — that's the whole bug.
  const legacyHardcoded = join(basePath, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
  assert.equal(
    existsSync(legacyHardcoded),
    false,
    "legacy hardcoded path must not exist in flat-phase fixture — if it does, the test fixture is wrong",
  );
});
