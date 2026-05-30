// Project/App: gsd-pi
// File Purpose: Behavior tests for closeout-aware wizard ordering.

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCloseoutMenuActions,
  buildIdleMenuSummary,
  getPrimaryCloseoutRecommendation,
} from "../closeout-wizard.ts";
import { buildGsdHomeModel } from "../gsd-command-home.ts";
import type { GSDState } from "../types.ts";

function baseState(overrides: Partial<GSDState> = {}): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Menu Cleanup" },
    activeSlice: { id: "S01", title: "Home Menu" },
    activeTask: { id: "T01", title: "Wire choices" },
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "Execute T01.",
    registry: [{ id: "M001", title: "Menu Cleanup", status: "active" }],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: {
      milestones: { done: 0, total: 1 },
      slices: { done: 0, total: 1 },
      tasks: { done: 0, total: 1 },
    },
    ...overrides,
  };
}

test("closeout menu prioritizes stranded quick branch over unmerged milestone", () => {
  const closeout = {
    strandedQuick: {
      quickBranch: "gsd/quick/1-fix-typo",
      originalBranch: "main",
      taskNum: 1,
      slug: "fix-typo",
    },
    unmergedMilestones: [{
      milestoneId: "M004",
      branch: "gsd/M004",
      integrationBranch: "main",
      files: ["src/app.ts"],
      dirtyOverlap: [],
    }],
  };

  assert.equal(getPrimaryCloseoutRecommendation(closeout), "finish_quick");
  const actions = buildCloseoutMenuActions(closeout);
  assert.deepEqual(actions.map((action) => action.id), ["finish_quick", "finish_milestone"]);
  assert.equal(actions[0]?.recommended, true);
  assert.equal(actions[1]?.recommended, false);
});

test("idle menu summary surfaces unmerged milestone closeout before new work", () => {
  const summary = buildIdleMenuSummary(baseState({
    activeMilestone: null,
    activeSlice: null,
    activeTask: null,
    phase: "complete",
    lastCompletedMilestone: { id: "M004", title: "Due Dates" },
  }), {
    strandedQuick: null,
    unmergedMilestones: [{
      milestoneId: "M004",
      branch: "gsd/M004",
      integrationBranch: "main",
      files: ["src/app.ts"],
      dirtyOverlap: [],
    }],
  });

  assert.deepEqual(summary, ["M004 is complete but not merged into main."]);
});

test("/gsd home recommends start or configure after clean milestone completion", () => {
  const model = buildGsdHomeModel(baseState({
    activeMilestone: null,
    activeSlice: null,
    activeTask: null,
    phase: "complete",
    nextAction: "All milestones complete.",
    lastCompletedMilestone: { id: "M001", title: "Menu Cleanup" },
    registry: [{ id: "M001", title: "Menu Cleanup", status: "complete" }],
    progress: { milestones: { done: 1, total: 1 } },
  }));

  const start = model.actions.find((candidate) => candidate.id === "start_configure");
  const review = model.actions.find((candidate) => candidate.id === "review_status");
  assert.equal(start?.recommended, true);
  assert.equal(review?.recommended, false);
  assert.equal(model.actions.find((candidate) => candidate.id === "continue_step")?.enabled, false);
  assert.equal(model.actions.find((candidate) => candidate.id === "run_auto")?.enabled, false);
  assert.match(model.summary.join("\n"), /All milestones complete/);
});

test("/gsd home recommends merge milestone when closeout is pending", () => {
  const model = buildGsdHomeModel(baseState({
    activeMilestone: null,
    activeSlice: null,
    activeTask: null,
    phase: "complete",
  }), {
    strandedQuick: null,
    unmergedMilestones: [{
      milestoneId: "M004",
      branch: "gsd/M004",
      integrationBranch: "main",
      files: ["src/app.ts"],
      dirtyOverlap: [],
    }],
  });

  const merge = model.actions.find((action) => action.id === "finish_milestone");
  assert.equal(merge?.recommended, true);
  assert.equal(merge?.enabled, true);
});
