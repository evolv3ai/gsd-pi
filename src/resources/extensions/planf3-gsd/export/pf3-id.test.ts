import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { pf3PhaseId, pf3TaskId, uniqueTag } from "./pf3-id.js";

describe("pf3 ids", () => {
  test("deterministic positional format", () => {
    assert.equal(pf3PhaseId(0), "PF3-P1");
    assert.equal(pf3PhaseId(10), "PF3-P11");
    assert.equal(pf3TaskId(0, 0), "PF3-P1-T1");
    assert.equal(pf3TaskId(2, 4), "PF3-P3-T5");
  });
});

describe("uniqueTag", () => {
  test("extracts a phase tag from a GSD-minted title", () => {
    assert.deepEqual(uniqueTag("Build hello-log CLI [PF3-P1]"), { phase: 1, task: null });
  });
  test("extracts a task tag", () => {
    assert.deepEqual(uniqueTag("Write parser tests [PF3-P2-T3]"), { phase: 2, task: 3 });
  });
  test("same tag repeated is still unique", () => {
    assert.deepEqual(uniqueTag("[PF3-P1] setup [PF3-P1]"), { phase: 1, task: null });
  });
  test("two distinct tags -> null (not unique)", () => {
    assert.equal(uniqueTag("merge [PF3-P1] and [PF3-P2]"), null);
  });
  test("no tag -> null", () => {
    assert.equal(uniqueTag("Build hello-log CLI"), null);
  });
});
