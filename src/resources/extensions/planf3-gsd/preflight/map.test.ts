import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { assembleStageMap } from "./map.js";
import { renderMap, verdictLine } from "./render.js";
import type { MapInputs } from "./map.js";

const BASE: MapInputs = {
  projection: {
    buckets: { planning: "claude-code/claude-fable-5", execution_simple: "claude-code/claude-haiku-4-5", execution: "openrouter/x/y" },
    verificationCommands: ["pnpm typecheck"],
    sources: { planning: "plan", execution_simple: "global", execution: "project" },
    allModelIds: [],
  },
  probes: [
    { target: "claude-code", tier: "auth", verdict: "ok", detail: "claude CLI logged in", checkedAt: "t" },
    { target: "openrouter", tier: "auth", verdict: "failed", detail: "auth rejected (HTTP 401)", checkedAt: "t" },
  ],
  modelIdIssues: [{ id: "claude-code/claude-hiaku-4-5", where: "dynamic_routing.tier_models.light", reason: "model id not found in the model catalog (checked exact and provider-prefix-stripped forms)" }],
  orchestrator: { host: "claude-code", model: "claude-code/claude-fable-5", authMode: "subscription", skills: ["planf3", "superpowers"] },
  gsdBinary: "gsd",
  gsdVersion: "1.6.0",
  generatorVersion: "0.3.0",
  projectRoot: "/tmp/x",
  gitBranch: "main",
  product: [],
  exercisedBuckets: ["planning"],
};

describe("assembleStageMap", () => {
  test("honesty ladder: exercised > probed-ok > configured", () => {
    const map = assembleStageMap(BASE);
    const byBucket = Object.fromEntries(map.gsdBuild.buckets.map((b) => [b.bucket, b.status]));
    assert.equal(byBucket.planning, "exercised");           // evidence handed in
    assert.equal(byBucket.execution_simple, "probed-ok");   // claude-code auth ok, no dispatch evidence
    assert.equal(byBucket.execution, "configured");         // openrouter probe failed
  });

  test("planning stage inherits the orchestrator model and skill availability", () => {
    const map = assembleStageMap(BASE);
    assert.equal(map.planning.inheritsModel, "claude-code/claude-fable-5");
    assert.equal(map.planning.skillAvailable, true);
    const bare = assembleStageMap({ ...BASE, orchestrator: null });
    assert.equal(bare.planning.skillAvailable, null);
    assert.equal(bare.planning.inheritsModel, null);
  });

  test("tier-0 issues surface as validationIssues strings", () => {
    const map = assembleStageMap(BASE);
    assert.equal(map.validationIssues.length, 1);
    assert.match(map.validationIssues[0], /tier_models\.light/);
  });

  test("ping-ok promotes a bucket to probed-ok even when provider auth is not ok", () => {
    const map = assembleStageMap({
      ...BASE,
      exercisedBuckets: [],
      probes: [
        { target: "openrouter", tier: "auth", verdict: "failed", detail: "auth rejected (HTTP 401)", checkedAt: "t" },
        { target: "ping:execution", tier: "ping", verdict: "ok", detail: "1-token round trip", checkedAt: "t", cost: "≈$0.001" },
      ],
    });
    const byBucket = Object.fromEntries(map.gsdBuild.buckets.map((b) => [b.bucket, b.status]));
    assert.equal(byBucket.execution, "probed-ok");        // ping alone promotes (auth failed)
    assert.equal(byBucket.execution_simple, "configured"); // no auth ok, no ping for this bucket
  });
});

describe("renderMap", () => {
  test("renders tables, drift rows, and ends with the exact verdict line", () => {
    const map = assembleStageMap(BASE);
    const text = renderMap(map, "drift", [{ kind: "config", field: "buckets.execution", approved: "a/b", current: "openrouter/x/y" }]);
    assert.match(text, /\| planning \| claude-code\/claude-fable-5 \| plan \| exercised \|/);
    assert.match(text, /config-drift/);
    const lines = text.trimEnd().split("\n");
    assert.equal(lines[lines.length - 1], "preflight: verdict=drift");
  });

  test("verdictLine format is stable", () => {
    assert.equal(verdictLine("ok"), "preflight: verdict=ok");
  });
});
