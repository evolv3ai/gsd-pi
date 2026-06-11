import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  MANAGED_GSD_BROWSER_TOOL_NAMES,
  findMissingContractCoverage,
  registerManagedGsdBrowserTools,
} = await import("../engine/managed-gsd-browser.ts");

describe("registerManagedGsdBrowserTools", () => {
  it("registers the curated Pi browser contract", () => {
    const tools = [];
    registerManagedGsdBrowserTools({
      registerTool(tool) {
        tools.push(tool);
      },
    });

    assert.deepEqual(tools.map((tool) => tool.name), [...MANAGED_GSD_BROWSER_TOOL_NAMES]);
    assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
  });

  it("keeps screenshots marked as image-producing evidence", () => {
    const tools = [];
    registerManagedGsdBrowserTools({
      registerTool(tool) {
        tools.push(tool);
      },
    });

    const screenshot = tools.find((tool) => tool.name === "browser_screenshot");
    assert.equal(screenshot?.compatibility?.producesImages, true);
  });
});

describe("findMissingContractCoverage", () => {
  it("reports nothing when every contract tool has a served candidate", () => {
    // browser_snapshot_refs is served via its browser_snapshot alias here.
    const served = [...MANAGED_GSD_BROWSER_TOOL_NAMES].filter((name) => name !== "browser_snapshot_refs");
    served.push("browser_snapshot");
    assert.deepEqual(findMissingContractCoverage(served), []);
  });

  it("reports contract tools none of whose MCP candidates are served", () => {
    const served = [...MANAGED_GSD_BROWSER_TOOL_NAMES].filter(
      (name) => name !== "browser_assert" && name !== "browser_evaluate",
    );
    // browser_evaluate is still satisfied through its browser_eval alias.
    served.push("browser_eval");
    assert.deepEqual(findMissingContractCoverage(served), ["browser_assert"]);
  });
});
