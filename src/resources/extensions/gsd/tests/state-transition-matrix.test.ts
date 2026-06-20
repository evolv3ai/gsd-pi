import test from "node:test";
import assert from "node:assert/strict";

import {
  STATE_TRANSITION_MATRIX,
  findTransition,
  validateTransitionMatrix,
  isLegalEdge,
  IllegalPhaseTransitionError,
} from "../state-transition-matrix.ts";

test("state transition matrix covers required swarm hardening events", () => {
  const result = validateTransitionMatrix([
    "context-ready",
    "research-ready",
    "plan-ready",
    "task-dispatched",
    "slice-complete",
    "validation-pass",
    "recovery-plan-ready",
    "closeout-complete",
  ]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.missingEvents, []);
  assert.deepEqual(result.duplicateKeys, []);
});

test("state transition matrix fails closed for recovery and closeout guards", () => {
  const recovery = findTransition("blocked", "recovery-plan-ready");
  assert.equal(recovery?.to, "executing");
  assert.equal(recovery?.onFail, "blocked");
  assert.equal(recovery?.reasonCode, "recovery");

  const closeout = findTransition("completing-milestone", "closeout-complete");
  assert.equal(closeout?.to, "complete");
  assert.equal(closeout?.onFail, "blocked");
});

test("state transition matrix entries all have guard and reason codes", () => {
  assert.ok(STATE_TRANSITION_MATRIX.length >= 8);
  for (const entry of STATE_TRANSITION_MATRIX) {
    assert.ok(entry.guard.length > 0, `${entry.event} must document its guard`);
    assert.ok(entry.reasonCode.length > 0, `${entry.event} must include reason code`);
  }
});

// ─── ADR-030: Phase Transition Invariant ───────────────────────────────────

test("isLegalEdge treats a self-edge as trivially legal", () => {
  assert.equal(isLegalEdge("executing", "executing"), true);
  assert.equal(isLegalEdge("planning", "planning"), true);
});

test("isLegalEdge accepts edges enumerated in the matrix", () => {
  assert.equal(isLegalEdge("planning", "executing"), true);
  assert.equal(isLegalEdge("executing", "summarizing"), true);
  assert.equal(isLegalEdge("summarizing", "validating-milestone"), true);
  assert.equal(isLegalEdge("completing-milestone", "complete"), true);
});

test("isLegalEdge honors the * wildcard rows (any -> blocked, any -> executing)", () => {
  assert.equal(isLegalEdge("planning", "blocked"), true);
  assert.equal(isLegalEdge("summarizing", "executing"), true);
});

test("isLegalEdge rejects an edge no matrix entry permits", () => {
  // executing -> complete skips validation — exactly the illegal jump the
  // invariant exists to catch.
  assert.equal(isLegalEdge("executing", "complete"), false);
  assert.equal(isLegalEdge("planning", "summarizing"), false);
});

test("IllegalPhaseTransitionError carries both endpoints and a descriptive message", () => {
  const err = new IllegalPhaseTransitionError("executing", "complete");
  assert.equal(err.from, "executing");
  assert.equal(err.to, "complete");
  assert.equal(err.name, "IllegalPhaseTransitionError");
  assert.match(err.message, /executing -> complete/);
});
