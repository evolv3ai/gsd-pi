// gsd-pi — Regression tests for milestone merge commit message construction.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  _resetMilestoneMergeMessageDepsForTests,
  _setMilestoneMergeMessageDepsForTests,
  buildMilestoneMergeMessage,
} from "../auto-worktree-merge-message.js";

describe("buildMilestoneMergeMessage", () => {
  beforeEach(() => {
    _resetMilestoneMergeMessageDepsForTests();
  });

  afterEach(() => {
    _resetMilestoneMergeMessageDepsForTests();
  });

  test("uses completed DB slices and tasks with display prefixes stripped", () => {
    _setMilestoneMergeMessageDepsForTests({
      isDbAvailable: () => true,
      getMilestone: () => ({ id: "M002", title: "M002: Auth foundation" } as never),
      getMilestoneSlices: () => [
        { id: "S01", title: "S01: Login flow", status: "complete" },
        { id: "S02", title: "S02: Later", status: "pending" },
      ] as never,
      getSliceTasks: (_milestoneId, sliceId) => sliceId === "S01"
        ? [
            { id: "T01", title: "T01: Add callback", status: "complete" },
            { id: "T02", title: "T02: Pending", status: "pending" },
          ] as never
        : [] as never,
    });

    const result = buildMilestoneMergeMessage({
      milestoneId: "M002",
      milestoneBranch: "milestone/M002",
      roadmapContent: "# M002: Roadmap title should not win when DB has title\n",
    });

    assert.equal(result.milestoneTitle, "Auth foundation");
    assert.deepEqual(result.sliceSummaries, ["### S01\nLogin flow"]);
    assert.equal(
      result.commitMessage,
      [
        "feat: Auth foundation",
        "",
        "Completed slices:",
        "- S01: Login flow",
        "",
        "Completed tasks:",
        "- S01/T01: Add callback",
        "",
        "Milestone: M002 - Auth foundation",
        "GSD-Milestone: M002",
        "Branch: milestone/M002",
      ].join("\n"),
    );
  });

  test("falls back to checked roadmap slices and roadmap title when DB has no completed slices", () => {
    _setMilestoneMergeMessageDepsForTests({
      isDbAvailable: () => false,
    });

    const result = buildMilestoneMergeMessage({
      milestoneId: "M007",
      milestoneBranch: "milestone/M007",
      roadmapContent: [
        "# M007: Roadmap fallback",
        "",
        "- [x] **S01: First shipped slice**",
        "- [ ] **S02: Not done**",
        "- [x] **S03: Third shipped slice**",
      ].join("\n"),
    });

    assert.equal(result.milestoneTitle, "Roadmap fallback");
    assert.deepEqual(result.sliceSummaries, [
      "### S01\nFirst shipped slice",
      "### S03\nThird shipped slice",
    ]);
    assert.match(result.commitMessage, /^feat: Roadmap fallback\n\nCompleted slices:/);
    assert.match(result.commitMessage, /- S01: First shipped slice/);
    assert.match(result.commitMessage, /- S03: Third shipped slice/);
    assert.doesNotMatch(result.commitMessage, /Completed tasks:/);
  });

  test("uses milestone id when no title or completed slice source exists", () => {
    _setMilestoneMergeMessageDepsForTests({
      isDbAvailable: () => false,
    });

    const result = buildMilestoneMergeMessage({
      milestoneId: "M009",
      milestoneBranch: "milestone/M009",
      roadmapContent: "",
    });

    assert.deepEqual(result.sliceSummaries, []);
    assert.equal(
      result.commitMessage,
      [
        "feat: M009",
        "",
        "Milestone: M009",
        "GSD-Milestone: M009",
        "Branch: milestone/M009",
      ].join("\n"),
    );
  });
});
