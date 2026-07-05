// Project/App: gsd-pi
// File Purpose: Tests for run-uat dispatch discovery boundaries.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { checkNeedsRunUat as checkNeedsRunUatFromPrompts } from "../auto-prompts.ts";
import { checkNeedsRunUat } from "../uat-dispatch.ts";
import type { GSDState } from "../types.ts";

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-uat-dispatch-test-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function writeRoadmap(base: string, milestoneId: string): void {
  const dir = join(base, ".gsd", "milestones", milestoneId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${milestoneId}-ROADMAP.md`),
    [
      `# ${milestoneId}: UAT dispatch`,
      "",
      "## Slices",
      "",
      "- [x] **S01: First slice** `risk:low` `depends:[]`",
      "- [ ] **S02: Next slice** `risk:low` `depends:[S01]`",
      "",
      "## Boundary Map",
      "",
    ].join("\n"),
  );
}

function writeSliceFile(
  base: string,
  milestoneId: string,
  sliceId: string,
  suffix: string,
  content: string,
): void {
  const dir = join(base, ".gsd", "milestones", milestoneId, "slices", sliceId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sliceId}-${suffix}.md`), content);
}

test("checkNeedsRunUat resolves runtime harness dispatch from UAT plus summary context", async (t) => {
  const base = createFixtureBase();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  writeRoadmap(base, "M001");
  writeSliceFile(
    base,
    "M001",
    "S01",
    "UAT",
    [
      "# S01 UAT",
      "",
      "## UAT Type",
      "- UAT mode: browser-executable",
      "",
      "## Preconditions",
      "- Start the dev server with `npm run test:server`.",
    ].join("\n"),
  );
  writeSliceFile(
    base,
    "M001",
    "S01",
    "SUMMARY",
    [
      "# S01 Summary",
      "",
      "Verification: `npm run test:uat` passed and exercises the browser harness end-to-end.",
    ].join("\n"),
  );

  assert.deepEqual(await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [{ sliceId: "S01" }]), {
    sliceId: "S01",
    uatType: "runtime-executable",
  });
});

test("checkNeedsRunUat skips slices that already have an ASSESSMENT verdict", async (t) => {
  const base = createFixtureBase();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  writeRoadmap(base, "M001");
  writeSliceFile(
    base,
    "M001",
    "S01",
    "UAT",
    [
      "# S01 UAT",
      "",
      "## UAT Type",
      "- UAT mode: artifact-driven",
    ].join("\n"),
  );
  writeSliceFile(base, "M001", "S01", "ASSESSMENT", "---\nverdict: PASS\n---\n# UAT Assessment\n");

  assert.equal(await checkNeedsRunUat(base, "M001", { uat_dispatch: true }, [{ sliceId: "S01" }]), null);
});

test("auto-prompts keeps the compatibility checkNeedsRunUat wrapper", async (t) => {
  const base = createFixtureBase();
  t.after(() => rmSync(base, { recursive: true, force: true }));

  writeRoadmap(base, "M001");
  writeSliceFile(
    base,
    "M001",
    "S01",
    "UAT",
    [
      "# S01 UAT",
      "",
      "## UAT Type",
      "- UAT mode: human-experience",
    ].join("\n"),
  );

  const legacyState: GSDState = {
    activeMilestone: { id: "M001", title: "UAT dispatch" },
    activeSlice: { id: "S02", title: "Next slice" },
    activeTask: null,
    phase: "planning",
    recentDecisions: [],
    blockers: [],
    nextAction: "Plan S02",
    registry: [],
  };

  assert.deepEqual(
    await checkNeedsRunUatFromPrompts(base, "M001", legacyState, { uat_dispatch: true }),
    { sliceId: "S01", uatType: "human-experience" },
  );
});
