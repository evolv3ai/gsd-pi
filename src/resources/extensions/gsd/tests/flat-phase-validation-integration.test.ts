// Project/App: gsd-pi
// File Purpose: End-to-end integration test for the upstream issue #876
// fix — exercises the actual verdict-resolution code paths against a real
// on-disk flat-phase project fixture, with no LLM or smoke required.
//
// Counterpart to flat-phase-validation-path.test.ts (which tests the
// path helpers in isolation). This file tests the integrated readers
// that auto-verification, commands-verdict, and milestone-validation-verdict
// rely on.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { loadFile } from "../files.ts";
import { resolveMilestoneValidationVerdict } from "../milestone-validation-verdict.ts";
import { relMilestoneFile } from "../paths.ts";

function makeFlatPhaseFixtureWithPassVerdict(): {
  basePath: string;
  cleanup: () => void;
} {
  const basePath = mkdtempSync(join(tmpdir(), "flat-phase-validation-int-"));
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
      "All slices verified, all acceptance criteria met.",
      "",
    ].join("\n"),
    "utf-8",
  );
  return {
    basePath,
    cleanup: () => rmSync(basePath, { recursive: true, force: true }),
  };
}

test("flat-phase integration: auto-verification reader path loads the on-disk VALIDATION.md (#876)", async () => {
  // Simulates the exact path construction at auto-verification.ts:264-266
  // after the Task 2 fix: join(basePath, relMilestoneFile(basePath, mid, "VALIDATION")).
  // This is the load-bearing reader that was permanently null-returning on
  // flat-phase projects before the fix.
  const { basePath, cleanup } = makeFlatPhaseFixtureWithPassVerdict();
  try {
    const validationFile = join(
      basePath,
      relMilestoneFile(basePath, "M001", "VALIDATION"),
    );
    const content = await loadFile(validationFile);
    assert.ok(
      content && content.includes("verdict: pass"),
      "auto-verification reader path must load the flat-phase VALIDATION.md content; received: " +
        JSON.stringify(content),
    );
  } finally {
    cleanup();
  }
});

test("flat-phase integration: resolveMilestoneValidationVerdict returns 'pass' from disk (#876)", async () => {
  // Exercises the full verdict-resolution waterfall in
  // resolveMilestoneValidationVerdict: DB check first (returns undefined
  // when no DB is open), then canonical/project-root file lookups, then
  // the last-resort path Task 4 patched. With the fix, at least one of
  // these branches finds the flat-phase VALIDATION.md and returns "pass".
  // Pre-fix, the last-resort branch hardcoded milestones/MID/MID-VALIDATION.md
  // and would miss the flat-phase file.
  const { basePath, cleanup } = makeFlatPhaseFixtureWithPassVerdict();
  try {
    const verdict = await resolveMilestoneValidationVerdict(basePath, "M001");
    assert.equal(
      verdict,
      "pass",
      "resolveMilestoneValidationVerdict must read the verdict from the flat-phase VALIDATION.md on disk",
    );
  } finally {
    cleanup();
  }
});

test("flat-phase integration: pre-fix legacy hardcoded path would have missed this fixture", async () => {
  // Documents what the bug looked like: the legacy hardcoded reader path
  // (milestones/MID/MID-VALIDATION.md) does NOT exist in a flat-phase
  // fixture, so loadFile on it returns null. This is the failure the fix
  // closes.
  const { basePath, cleanup } = makeFlatPhaseFixtureWithPassVerdict();
  try {
    const legacyHardcoded = join(
      basePath,
      ".gsd",
      "milestones",
      "M001",
      "M001-VALIDATION.md",
    );
    assert.equal(
      existsSync(legacyHardcoded),
      false,
      "fixture invariant: legacy path must not exist on flat-phase",
    );
    const content = await loadFile(legacyHardcoded);
    assert.equal(
      content,
      null,
      "loadFile on the pre-fix legacy hardcoded path must return null on a flat-phase fixture — this is the bug shape",
    );
  } finally {
    cleanup();
  }
});
