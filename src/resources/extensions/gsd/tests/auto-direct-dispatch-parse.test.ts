import test from "node:test";
import assert from "node:assert/strict";

import { parseDirectDispatchPhase } from "../auto-direct-dispatch.ts";

test("parseDirectDispatchPhase accepts milestone id suffix", () => {
  assert.deepEqual(parseDirectDispatchPhase("complete-milestone M005"), {
    phase: "complete-milestone",
    milestoneId: "M005",
  });
});

test("parseDirectDispatchPhase ignores trailing punctuation on milestone id", () => {
  assert.deepEqual(parseDirectDispatchPhase("complete-milestone M005."), {
    phase: "complete-milestone",
    milestoneId: "M005",
  });
});

test("parseDirectDispatchPhase ignores extra words after milestone id", () => {
  assert.deepEqual(parseDirectDispatchPhase("complete-milestone M005 complete"), {
    phase: "complete-milestone",
    milestoneId: "M005",
  });
});

test("parseDirectDispatchPhase preserves bare phase names", () => {
  assert.deepEqual(parseDirectDispatchPhase("plan"), { phase: "plan", milestoneId: undefined });
  assert.deepEqual(parseDirectDispatchPhase("complete-milestone"), {
    phase: "complete-milestone",
    milestoneId: undefined,
  });
});
