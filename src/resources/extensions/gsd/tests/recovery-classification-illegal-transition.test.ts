// GSD — recovery-classification: illegal-transition kind (ADR-030)

import test from "node:test";
import assert from "node:assert/strict";

import { classifyFailure } from "../recovery-classification.ts";
import { IllegalPhaseTransitionError } from "../state-transition-matrix.ts";

test("classifyFailure recognizes IllegalPhaseTransitionError by class and escalates", () => {
  const classification = classifyFailure({
    error: new IllegalPhaseTransitionError("executing", "complete"),
    unitType: "execute-task",
    unitId: "T-1",
  });

  assert.equal(classification.failureKind, "illegal-transition");
  assert.equal(classification.action, "escalate");
  assert.equal(classification.exitReason, "illegal-transition");
  assert.match(classification.reason, /Illegal phase transition/);
});

test("classifyFailure routes an explicit illegal-transition failureKind to the same case", () => {
  const classification = classifyFailure({
    error: new Error("derived edge rejected"),
    failureKind: "illegal-transition",
  });

  assert.equal(classification.failureKind, "illegal-transition");
  assert.equal(classification.action, "escalate");
});
