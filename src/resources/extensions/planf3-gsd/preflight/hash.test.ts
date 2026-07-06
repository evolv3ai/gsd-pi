import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, projectionHash } from "./hash.js";
import type { ProjectionResult } from "./types.js";

const P: ProjectionResult = {
  buckets: { planning: "claude-code/claude-fable-5", execution: "claude-code/claude-sonnet-4-6" },
  verificationCommands: ["pnpm typecheck", "pnpm test"],
  sources: { planning: "plan", execution: "global" },
  allModelIds: [{ id: "claude-code/claude-fable-5", where: "buckets.planning" }],
};

describe("projectionHash", () => {
  test("stable under key reordering", () => {
    const reordered: ProjectionResult = {
      ...P,
      buckets: { execution: "claude-code/claude-sonnet-4-6", planning: "claude-code/claude-fable-5" },
    };
    assert.equal(projectionHash(P), projectionHash(reordered));
  });
  test("covers ONLY buckets + verificationCommands (disk-recomputable rule)", () => {
    const differentUnhashed: ProjectionResult = {
      ...P,
      sources: { planning: "global", execution: "project" },
      allModelIds: [],
    };
    assert.equal(projectionHash(P), projectionHash(differentUnhashed));
    const differentBucket = { ...P, buckets: { ...P.buckets, planning: "other/model" } };
    assert.notEqual(projectionHash(P), projectionHash(differentBucket));
    const differentCommands = { ...P, verificationCommands: ["pnpm test"] };
    assert.notEqual(projectionHash(P), projectionHash(differentCommands));
  });
  test("canonicalJson sorts recursively", () => {
    assert.equal(canonicalJson({ b: { d: 1, c: 2 }, a: 3 }), '{"a":3,"b":{"c":2,"d":1}}');
  });
});
