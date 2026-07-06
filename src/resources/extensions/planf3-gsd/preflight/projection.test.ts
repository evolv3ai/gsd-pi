import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { projectPreferences } from "./projection.js";

const GLOBAL = `---
version: 1
models:
  planning: openrouter/anthropic/claude-opus-4.7
  execution_simple: claude-code/claude-haiku-4-5
verification_commands:
  - pnpm typecheck
dynamic_routing:
  tier_models:
    heavy: claude-code/claude-fable-5
---
# global prefs
`;

const PROJECT = `---
version: 1
models:
  execution: claude-code/claude-sonnet-4-6
---
# project prefs
`;

describe("projectPreferences", () => {
  test("plan policy overlays project; project overrides global; commands union", () => {
    const p = projectPreferences({
      globalContent: GLOBAL,
      projectContent: PROJECT,
      modelPolicy: { planning: "claude-code/claude-fable-5" },
      validationCommands: ["pnpm typecheck", "pnpm test"],
      sourceHtmlPath: "specs/x.html",
    });
    assert.deepEqual(p.buckets, {
      planning: "claude-code/claude-fable-5",       // plan wins
      execution: "claude-code/claude-sonnet-4-6",   // project
      execution_simple: "claude-code/claude-haiku-4-5", // global
    });
    assert.deepEqual(p.verificationCommands, ["pnpm typecheck", "pnpm test"]); // deduped union
    assert.deepEqual(p.sources, { planning: "plan", execution: "project", execution_simple: "global" });
  });

  test("allModelIds includes hand-written tier_models (validation ≠ ownership)", () => {
    const p = projectPreferences({
      globalContent: GLOBAL, projectContent: PROJECT,
      modelPolicy: {}, validationCommands: [], sourceHtmlPath: "specs/x.html",
    });
    assert.ok(p.allModelIds.some((m) => m.id === "claude-code/claude-fable-5" && m.where === "dynamic_routing.tier_models.heavy"));
    assert.ok(p.allModelIds.some((m) => m.where === "buckets.execution"));
  });

  test("both files absent: plan policy alone forms the projection", () => {
    const p = projectPreferences({
      globalContent: null, projectContent: null,
      modelPolicy: { planning: "m1" }, validationCommands: ["c1"], sourceHtmlPath: "specs/x.html",
    });
    assert.deepEqual(p.buckets, { planning: "m1" });
    assert.deepEqual(p.verificationCommands, ["c1"]);
    assert.deepEqual(p.sources, { planning: "plan" });
  });
});
