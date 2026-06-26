// Project/App: gsd-pi
// File Purpose: Tests for .planning/ layout classification.
import test from "node:test";
import assert from "node:assert/strict";

import { detectPlanningLayout } from "../migrate/layout-detect.ts";
import type { PlanningProject } from "../migrate/types.ts";

function emptyProject(over: Partial<PlanningProject> = {}): PlanningProject {
  return {
    path: "", project: null, roadmap: null, requirements: [], state: null,
    config: null, phases: {}, quickTasks: [], milestones: [], research: [],
    decisions: [], seeds: [], validation: { valid: true, issues: [] },
    ...over,
  } as PlanningProject;
}

test("detectPlanningLayout returns legacy-milestone-dir when milestones/ has phases", () => {
  const p = emptyProject({
    milestones: [{
      id: "v1.0",
      requirements: null,
      roadmap: null,
      phases: { "01-foo": {} as never },
      extraFiles: [],
    }],
  });
  assert.equal(detectPlanningLayout(p), "legacy-milestone-dir");
});

test("detectPlanningLayout returns multi-milestone when roadmap.milestones non-empty", () => {
  const p = emptyProject({
    roadmap: {
      raw: "",
      milestones: [{ id: "v1", title: "V1", collapsed: false, phases: [] }],
      phases: [],
    },
  });
  assert.equal(detectPlanningLayout(p), "multi-milestone");
});

test("detectPlanningLayout returns flat-phases when roadmap.phases non-empty and no milestone dirs", () => {
  const p = emptyProject({
    roadmap: {
      raw: "",
      milestones: [],
      phases: [{ number: 1, title: "Foo", done: false, raw: "" }],
    },
  });
  assert.equal(detectPlanningLayout(p), "flat-phases");
});

test("detectPlanningLayout returns null when nothing recognizable", () => {
  assert.equal(detectPlanningLayout(emptyProject()), null);
});

test("priority: legacy-milestone-dir wins over multi-milestone", () => {
  const p = emptyProject({
    milestones: [{
      id: "v1.0",
      requirements: null,
      roadmap: null,
      phases: { "01-foo": {} as never },
      extraFiles: [],
    }],
    roadmap: {
      raw: "",
      milestones: [{ id: "v1", title: "V1", collapsed: false, phases: [] }],
      phases: [],
    },
  });
  assert.equal(detectPlanningLayout(p), "legacy-milestone-dir");
});

test("priority: multi-milestone wins over flat-phases when both roadmap arrays non-empty", () => {
  const p = emptyProject({
    roadmap: {
      raw: "",
      milestones: [{ id: "v1", title: "V1", collapsed: false, phases: [] }],
      phases: [{ number: 1, title: "Foo", done: false, raw: "" }],
    },
  });
  assert.equal(detectPlanningLayout(p), "multi-milestone");
});
