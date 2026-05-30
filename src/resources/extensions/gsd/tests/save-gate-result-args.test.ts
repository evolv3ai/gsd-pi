import assert from "node:assert/strict";
import { test } from "node:test";

import { autoSession } from "../auto-runtime-state.js";
import { prepareSaveGateResultArguments } from "../tools/save-gate-result-args.js";

test("prepareSaveGateResultArguments fills milestone and slice from auto current unit", () => {
  autoSession.currentUnit = { type: "slice", id: "M002-mskcfz/S01", startedAt: Date.now() };
  try {
    const prepared = prepareSaveGateResultArguments({}) as Record<string, unknown>;
    assert.equal(prepared.milestoneId, "M002-mskcfz");
    assert.equal(prepared.sliceId, "S01");
  } finally {
    autoSession.currentUnit = null;
  }
});

test("prepareSaveGateResultArguments accepts snake_case aliases and nested params", () => {
  const prepared = prepareSaveGateResultArguments({
    params: {
      milestone_id: "M001",
      slice_id: "S02",
      gate_id: "q4",
      verdict: "pass",
      rationale: "Looks good",
    },
  }) as Record<string, unknown>;
  assert.equal(prepared.milestoneId, "M001");
  assert.equal(prepared.sliceId, "S02");
  assert.equal(prepared.gateId, "Q4");
  assert.equal(prepared.verdict, "pass");
  assert.equal(prepared.rationale, "Looks good");
});

test("prepareSaveGateResultArguments normalizes common verdict synonyms", () => {
  const prepared = prepareSaveGateResultArguments({
    milestoneId: "M001",
    sliceId: "S01",
    gateId: "Q3",
    status: "concerns",
    reason: "Auth surface missing tests",
  }) as Record<string, unknown>;
  assert.equal(prepared.verdict, "flag");
  assert.equal(prepared.rationale, "Auth surface missing tests");
});
