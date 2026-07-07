/**
 * Regression tests for batched touched-file collection in parallel eligibility.
 *
 * `collectTouchedFiles` used to run one `getSliceTasks` query per slice (N+1);
 * it now issues a single `getTasksBySliceIds` batch and dedups paths into a
 * Set. These tests pin the observable contract of that path through the public
 * `analyzeParallelEligibility` API:
 *   1. files are collected from EVERY slice of a milestone, not just the first
 *      (a file present only in a non-first slice must still drive overlap), and
 *   2. a path repeated across a milestone's slices is deduped (Set semantics),
 *      so it appears once in the cross-milestone overlap.
 */

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { analyzeParallelEligibility } from "../parallel-eligibility.ts";
import { invalidateStateCache } from "../state.ts";
import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
} from "../gsd-db.ts";

// ─── Fixture Helpers ───────────────────────────────────────────────────────

function createFixtureBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-parallel-elig-overlap-"));
  mkdirSync(join(base, ".gsd", "milestones"), { recursive: true });
  return base;
}

function writeMilestoneFile(base: string, milestoneId: string, filename: string, content: string): void {
  const filePath = join(base, ".gsd", "milestones", milestoneId, filename);
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, content);
}

/**
 * Write the on-disk planning artifacts that make a milestone eligible
 * (CONTEXT + ROADMAP listing its slices + a PLAN per slice). Mirrors the
 * proven-eligible setup used by parallel-eligibility-ghost.test.ts.
 */
function writeEligibleMilestoneFiles(base: string, milestoneId: string, sliceIds: string[]): void {
  writeMilestoneFile(base, milestoneId, `${milestoneId}-CONTEXT.md`, `# ${milestoneId}: Fixture\n\nBatch fixture.`);
  const roadmapSlices = sliceIds
    .map((sid) => `- [ ] **${sid}: Slice ${sid}** \`risk:low\` \`depends:[]\`\n  > Slice ${sid}.`)
    .join("\n");
  writeMilestoneFile(
    base,
    milestoneId,
    `${milestoneId}-ROADMAP.md`,
    `# ${milestoneId}: Fixture\n\n## Slices\n\n${roadmapSlices}\n`,
  );
  for (const sid of sliceIds) {
    writeMilestoneFile(
      base,
      milestoneId,
      `slices/${sid}/${sid}-PLAN.md`,
      `# ${sid}: Slice ${sid}\n\n**Goal:** Do ${sid}.\n**Demo:** Done.\n\n## Tasks\n\n- [ ] **T01: Task** \`est:10m\`\n  Do it.\n`,
    );
  }
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("parallel-eligibility: batched touched-file collection", () => {
  let base: string;

  beforeEach(() => {
    base = createFixtureBase();
    openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
    cleanup(base);
    invalidateStateCache();
  });

  test("collects files from every slice (batch) and dedups repeated paths", async () => {
    // M001 spans two slices. `src/shared.ts` appears in BOTH slices (dedup
    // target); `src/beta.ts` appears ONLY in the second slice S02 (proves the
    // batch covers non-first slices). `src/alpha.ts` is unique to M001.
    writeEligibleMilestoneFiles(base, "M001", ["S01", "S02"]);
    insertMilestone({ id: "M001", title: "M001: Fixture", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Slice S01", status: "active", risk: "low", depends: [], sequence: 1 });
    insertSlice({ id: "S02", milestoneId: "M001", title: "Slice S02", status: "active", risk: "low", depends: [], sequence: 2 });
    insertTask({
      id: "T01", sliceId: "S01", milestoneId: "M001", title: "S01 task", status: "pending",
      planning: { files: ["src/alpha.ts", "src/shared.ts"] },
    });
    insertTask({
      id: "T01", sliceId: "S02", milestoneId: "M001", title: "S02 task", status: "pending",
      planning: { files: ["src/shared.ts", "src/beta.ts"] },
    });

    // M002 overlaps M001 on both `src/shared.ts` and `src/beta.ts`.
    writeEligibleMilestoneFiles(base, "M002", ["S01"]);
    insertMilestone({ id: "M002", title: "M002: Fixture", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M002", title: "Slice S01", status: "active", risk: "low", depends: [], sequence: 1 });
    insertTask({
      id: "T01", sliceId: "S01", milestoneId: "M002", title: "S01 task", status: "pending",
      planning: { files: ["src/shared.ts", "src/beta.ts"] },
    });

    invalidateStateCache();
    const result = await analyzeParallelEligibility(base);

    // Both milestones must be eligible so Rule 3 (file overlap) runs on them.
    assert.ok(result.eligible.find((e) => e.milestoneId === "M001"), "M001 should be eligible");
    assert.ok(result.eligible.find((e) => e.milestoneId === "M002"), "M002 should be eligible");

    const overlap = result.fileOverlaps.find(
      (o) =>
        (o.mid1 === "M001" && o.mid2 === "M002") ||
        (o.mid1 === "M002" && o.mid2 === "M001"),
    );
    assert.ok(overlap, "M001 and M002 must be reported as overlapping");

    // `src/beta.ts` lives only in M001's SECOND slice — its presence proves the
    // batched query collected tasks from every slice, not just the first.
    assert.ok(
      overlap!.files.includes("src/beta.ts"),
      "overlap must include src/beta.ts (only present in M001's non-first slice S02)",
    );
    assert.ok(overlap!.files.includes("src/shared.ts"), "overlap must include src/shared.ts");

    // `src/shared.ts` appears in both of M001's slices but must be deduped to a
    // single entry (Set collection), so the sorted overlap is exactly these two.
    assert.deepEqual(
      [...overlap!.files].sort(),
      ["src/beta.ts", "src/shared.ts"],
      "overlap files must be deduped and limited to the shared paths",
    );
  });
});
