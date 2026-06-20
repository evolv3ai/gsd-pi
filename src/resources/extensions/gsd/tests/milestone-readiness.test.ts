import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyMilestoneReadiness,
  describeMilestoneReadinessPhase,
  formatAcceptedDiscussHandoffMessage,
  readinessNeedsDiscussion,
} from "../milestone-readiness.ts";

test("classifyMilestoneReadiness distinguishes queued shells from draft discussion work", () => {
  const shell = classifyMilestoneReadiness({
    status: "queued",
    hasDraftContext: true,
    sliceCount: 0,
  });

  assert.equal(shell.kind, "queued-shell");
  assert.equal(readinessNeedsDiscussion(shell), true);
});

test("classifyMilestoneReadiness marks context-only milestones as planning pending", () => {
  const readiness = classifyMilestoneReadiness({
    status: "queued",
    hasContext: true,
    sliceCount: 0,
  });

  assert.equal(readiness.kind, "planning-pending");
  assert.equal(formatAcceptedDiscussHandoffMessage("M001", readiness), "Milestone M001 context captured. Continuing the planning pipeline.");
});

test("classifyMilestoneReadiness marks persisted slices as executable plan", () => {
  const readiness = classifyMilestoneReadiness({
    status: "active",
    hasContext: true,
    sliceCount: 1,
  });

  assert.equal(readiness.kind, "executable-plan");
  assert.equal(formatAcceptedDiscussHandoffMessage("M001", readiness), "Milestone M001 ready.");
});

test("formatAcceptedDiscussHandoffMessage preserves ready copy for any executable plan", () => {
  const readiness = classifyMilestoneReadiness({
    status: "complete",
    hasContext: true,
    sliceCount: 1,
  });

  assert.equal(readiness.kind, "terminal");
  assert.equal(formatAcceptedDiscussHandoffMessage("M001", readiness), "Milestone M001 ready.");
});

test("describeMilestoneReadinessPhase keeps dashboard phase copy centralized", () => {
  assert.deepEqual(describeMilestoneReadinessPhase("needs-discussion"), {
    label: "Discuss milestone draft",
    description: "Milestone has a draft context — needs discussion before planning.",
  });
  assert.deepEqual(describeMilestoneReadinessPhase("pre-planning"), {
    label: "Research & plan milestone",
    description: "Scout the landscape and create the roadmap.",
  });
  assert.equal(describeMilestoneReadinessPhase("executing"), null);
});
