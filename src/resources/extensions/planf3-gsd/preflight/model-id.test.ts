import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { validateModelIds, type CatalogPort } from "./model-id.js";

const catalog: CatalogPort = {
  ids: () => [
    "claude-code/claude-fable-5",
    "claude-code/claude-sonnet-4-6",
    "openrouter/anthropic/claude-opus-4.7",
  ],
};

describe("validateModelIds (tier 0)", () => {
  test("exact and bare matches pass; unknown ids are reported with their location", () => {
    const issues = validateModelIds(
      [
        { id: "claude-code/claude-fable-5", where: "buckets.planning" },          // exact
        { id: "anthropic/claude-opus-4.7", where: "buckets.execution" },          // bare match (3-segment catalog form)
        { id: "claude-code/claude-hiaku-4-5", where: "dynamic_routing.tier_models.light" }, // typo
      ],
      catalog,
    );
    assert.equal(issues.length, 1);
    assert.equal(issues[0].where, "dynamic_routing.tier_models.light");
    assert.match(issues[0].reason, /not found in the model catalog/);
  });

  test("3-segment OpenRouter form validates against a 2-segment catalog id", () => {
    const twoSegCatalog: CatalogPort = { ids: () => ["claude-code/claude-fable-5"] };
    const issues = validateModelIds([{ id: "openrouter/anthropic/claude-fable-5", where: "buckets.heavy" }], twoSegCatalog);
    assert.deepEqual(issues, []);
  });

  test("empty catalog reports nothing as an issue (catalog unavailable ≠ typo)", () => {
    const issues = validateModelIds([{ id: "x/y", where: "buckets.a" }], { ids: () => [] });
    assert.deepEqual(issues, []);
  });
});
