import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  MANAGED_BROWSER_TOOL_SPECS,
  MANAGED_GSD_BROWSER_TOOL_NAMES,
  ManagedGsdBrowserConnectionPool,
  findMissingContractCoverage,
  normalizeManagedArgs,
  registerManagedGsdBrowserTools,
} = await import("../engine/managed-gsd-browser.ts");

// The tools @opengsd/gsd-browser actually serves over MCP (subset relevant to
// the contract). Notably absent: browser_click, browser_type, browser_verify,
// browser_reload — those are satisfied through translations.
const GSD_BROWSER_SERVED_TOOLS = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click_ref",
  "browser_fill_ref",
  "browser_fill_form",
  "browser_wait_for",
  "browser_assert",
  "browser_screenshot",
  "browser_find_element",
  "browser_console",
  "browser_network",
  "browser_evaluate",
  "browser_batch",
  "browser_act",
];

function makeLaunchConfig() {
  return {
    command: "gsd-browser",
    args: ["mcp"],
    cwd: "/tmp/example-project",
    projectRoot: "/tmp/example-project",
    serverName: "gsd-browser",
    sessionName: "test-session",
  };
}

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
  it("reports nothing for the tool list gsd-browser actually serves", () => {
    assert.deepEqual(findMissingContractCoverage(GSD_BROWSER_SERVED_TOOLS), []);
  });

  it("reports contract tools none of whose MCP candidates are served", () => {
    const served = GSD_BROWSER_SERVED_TOOLS.filter((name) => name !== "browser_assert");
    // browser_verify also depends on browser_assert through its translation.
    assert.deepEqual(findMissingContractCoverage(served), ["browser_assert", "browser_verify"]);
  });

  it("reports translated tools when a required MCP tool is missing", () => {
    const served = GSD_BROWSER_SERVED_TOOLS.filter((name) => name !== "browser_batch");
    assert.deepEqual(findMissingContractCoverage(served), ["browser_click", "browser_type", "browser_batch"]);
  });
});

describe("ManagedGsdBrowserConnectionPool", () => {
  it("closes a pending connection that resolves after the pool is closed", async () => {
    const closed = [];
    let resolveConnect;
    const pool = new ManagedGsdBrowserConnectionPool(async () => {
      return new Promise((resolve) => {
        resolveConnect = resolve;
      });
    }, async (connection) => {
      closed.push(connection.id);
    });

    const launch = makeLaunchConfig();

    const pending = pool.getOrConnect(launch);
    const closedPool = pool.closeAll();
    resolveConnect({ id: "late-connection" });

    await assert.rejects(
      pending,
      /closed during startup/,
      "pending callers must not receive a reusable connection after close",
    );
    await closedPool;

    assert.deepEqual(closed, ["late-connection"]);
    assert.equal(pool.activeCount, 0);
    assert.equal(pool.pendingCount, 0);
  });

  it("aborts pending connection attempts when the pool is closed", async () => {
    let receivedSignal;
    const pool = new ManagedGsdBrowserConnectionPool(async (_launch, signal) => {
      receivedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("connect aborted")), { once: true });
      });
    }, async () => {});

    const pending = pool.getOrConnect(makeLaunchConfig());
    const closedPool = pool.closeAll();

    await assert.rejects(pending, /connect aborted/);
    await closedPool;

    assert.equal(receivedSignal?.aborted, true);
    assert.equal(pool.activeCount, 0);
    assert.equal(pool.pendingCount, 0);
  });

  it("rejects new connection attempts started while the pool is closing", async () => {
    let resolveConnect;
    let connectCount = 0;
    const pool = new ManagedGsdBrowserConnectionPool(async () => {
      connectCount += 1;
      return new Promise((resolve) => {
        resolveConnect = resolve;
      });
    }, async () => {});

    const pending = pool.getOrConnect(makeLaunchConfig());
    const closedPool = pool.closeAll();

    // A caller that arrives during the in-flight closeAll must not open a new
    // connection that could survive shutdown.
    await assert.rejects(
      pool.getOrConnect(makeLaunchConfig()),
      /closing/,
      "getOrConnect must reject while the pool is closing",
    );

    resolveConnect({ id: "pending-connection" });
    await assert.rejects(pending, /closed during startup/);
    await closedPool;

    assert.equal(connectCount, 1, "no second connection is started during shutdown");
    assert.equal(pool.activeCount, 0);
    assert.equal(pool.pendingCount, 0);
  });
});

describe("contract tool translations", () => {
  it("translates browser_click into a single-step batch call", () => {
    const calls = MANAGED_BROWSER_TOOL_SPECS.browser_click.translate.build({ selector: "#save" });
    assert.deepEqual(calls, [{
      mcpTool: "browser_batch",
      args: { steps: [{ action: "click", selector: "#save" }] },
    }]);
  });

  it("translates browser_type into a single-step batch call", () => {
    const calls = MANAGED_BROWSER_TOOL_SPECS.browser_type.translate.build({
      selector: "#name",
      text: "hello",
      clearFirst: true,
      submit: true,
    });
    assert.deepEqual(calls, [{
      mcpTool: "browser_batch",
      args: { steps: [{ action: "type", selector: "#name", text: "hello", clearFirst: true, submit: true }] },
    }]);
  });

  it("normalizes batch options and step keys to the daemon's snake_case", () => {
    const normalized = normalizeManagedArgs("browser_batch", {
      steps: [{ action: "type", selector: "#name", text: "hi", clearFirst: true }],
      stopOnFailure: false,
      finalSummaryOnly: true,
    });
    assert.deepEqual(normalized, {
      steps: [{ action: "type", selector: "#name", text: "hi", clear_first: true }],
      stop_on_failure: false,
      summary_only: true,
    });
  });

  it("translates browser_verify into navigate, assert, and screenshot calls", () => {
    const calls = MANAGED_BROWSER_TOOL_SPECS.browser_verify.translate.build({
      url: "http://localhost:3000",
      timeout: 5000,
      checks: [
        { description: "heading shows", selector: "h1", expectedText: "Welcome" },
        { description: "spinner gone", selector: ".spinner", expectedVisible: false },
        { description: "evidence", selector: "main", expectedVisible: true, screenshot: true },
      ],
    });
    assert.deepEqual(calls, [
      { mcpTool: "browser_navigate", args: { url: "http://localhost:3000", timeout: 5000 } },
      {
        mcpTool: "browser_assert",
        args: {
          checks: [
            { kind: "text_visible", text: "Welcome" },
            { kind: "selector_hidden", selector: ".spinner" },
            { kind: "selector_visible", selector: "main" },
          ],
        },
      },
      { mcpTool: "browser_screenshot", args: {}, optional: true },
    ]);
  });

  it("declares every tool a translation can emit in its coverage requirements", () => {
    for (const [name, spec] of Object.entries(MANAGED_BROWSER_TOOL_SPECS)) {
      if (!spec.translate) continue;
      const maximalArgs = {
        url: "http://localhost:3000",
        timeout: 5000,
        selector: "#el",
        text: "hi",
        clearFirst: true,
        checks: [{ description: "d", selector: "#el", expectedText: "hi", expectedVisible: true, screenshot: true }],
      };
      const emitted = spec.translate.build(maximalArgs).map((call) => call.mcpTool);
      for (const mcpTool of emitted) {
        assert.ok(
          spec.translate.requires.includes(mcpTool),
          `${name} translation emits ${mcpTool} but does not require it for coverage`,
        );
      }
    }
  });

  it("translates browser_verify without checks into navigation only", () => {
    const calls = MANAGED_BROWSER_TOOL_SPECS.browser_verify.translate.build({ url: "http://localhost:3000", checks: [] });
    assert.deepEqual(calls, [{ mcpTool: "browser_navigate", args: { url: "http://localhost:3000" } }]);
  });

  it("translates browser_reload into evaluate plus best-effort network-idle wait", () => {
    const calls = MANAGED_BROWSER_TOOL_SPECS.browser_reload.translate.build({});
    assert.deepEqual(calls, [
      { mcpTool: "browser_evaluate", args: { expression: "location.reload()" } },
      { mcpTool: "browser_wait_for", args: { condition: "network_idle", timeout: 3_000 }, optional: true },
    ]);
  });
});
