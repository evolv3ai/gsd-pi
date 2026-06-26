// Project/App: gsd-pi
// File Purpose: Regression test for upstream issue #876 — flat-phase
// validation-path readers must use layout-aware helpers, not hardcoded
// legacy paths.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { relMilestoneFile, resolveMilestoneFile } from "../paths.ts";

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

test("flat-phase: relMilestoneFile resolves to the layout-aware path", () => {
  const { basePath, cleanup } = makeFlatPhaseFixture();
  try {
    const rel = relMilestoneFile(basePath, "M001", "VALIDATION");
    assert.equal(rel, ".gsd/phases/01-foo/01-VALIDATION.md");
    const abs = join(basePath, rel);
    assert.equal(existsSync(abs), true);
  } finally {
    cleanup();
  }
});

test("flat-phase: resolveMilestoneFile finds the on-disk file", () => {
  const { basePath, cleanup } = makeFlatPhaseFixture();
  try {
    const abs = resolveMilestoneFile(basePath, "M001", "VALIDATION");
    assert.ok(abs, "resolveMilestoneFile must return a path for the flat-phase fixture");
    assert.equal(abs!.endsWith("/.gsd/phases/01-foo/01-VALIDATION.md"), true);
    assert.equal(existsSync(abs!), true);
  } finally {
    cleanup();
  }
});

test("flat-phase: the legacy hardcoded path does NOT resolve (regression for #876)", () => {
  const { basePath, cleanup } = makeFlatPhaseFixture();
  try {
    // This is the path that auto-verification.ts:264-270 used to construct.
    // It must NOT exist on a flat-phase project — that's the whole bug.
    const legacyHardcoded = join(basePath, ".gsd", "milestones", "M001", "M001-VALIDATION.md");
    assert.equal(
      existsSync(legacyHardcoded),
      false,
      "legacy hardcoded path must not exist in flat-phase fixture — if it does, the test fixture is wrong",
    );
  } finally {
    cleanup();
  }
});
