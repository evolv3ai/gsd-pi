import test from "node:test";
import assert from "node:assert/strict";

import { parseToolSearchSelectQuery } from "@gsd/pi-ai";
import { registerToolSearchShim } from "../bootstrap/tool-search-shim.ts";

test("parseToolSearchSelectQuery extracts MCP tool name", () => {
  assert.equal(
    parseToolSearchSelectQuery("select:mcp__gsd-workflow__gsd_save_gate_result"),
    "mcp__gsd-workflow__gsd_save_gate_result",
  );
});

test("parseToolSearchSelectQuery extracts canonical gsd tool name", () => {
  assert.equal(parseToolSearchSelectQuery("select:gsd_summary_save"), "gsd_summary_save");
});

test("parseToolSearchSelectQuery returns null for non-select queries", () => {
  assert.equal(parseToolSearchSelectQuery("gsd_save_gate_result"), null);
  assert.equal(parseToolSearchSelectQuery(""), null);
});

// ── #852 follow-up: registerToolSearchShim tolerates the pre-bind runtime ──
//
// During extension loading, getActiveTools()/setActiveTools() are throwing
// stubs ("Extension runtime not initialized"). The old shim called them
// unconditionally, the throw propagated to register-extension.ts's catch,
// and the whole "Extension setup partially failed" warning fired — which
// under Claude Code CLI could leave workflow tools missing and trap
// plan-milestone in a finalize-retry loop. The shim must register the tool
// regardless and tolerate the pre-bind throw.

function makeFakePi(opts: {
  getActiveToolsThrows?: boolean;
  setActiveToolsThrows?: boolean;
  activeTools?: string[];
}): {
  registerTool(tool: { name: string }): void;
  getActiveTools(): string[];
  setActiveTools(tools: string[]): void;
  registered: string[];
  setCalls: string[][];
} {
  const registered: string[] = [];
  const setCalls: string[][] = [];
  const active = opts.activeTools ?? [];
  return {
    registerTool(tool) {
      registered.push(tool.name);
    },
    getActiveTools() {
      if (opts.getActiveToolsThrows) {
        throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
      }
      return [...active];
    },
    setActiveTools(tools) {
      if (opts.setActiveToolsThrows) {
        throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
      }
      setCalls.push(tools);
      active.length = 0;
      active.push(...tools);
    },
    registered,
    setCalls,
  };
}

test("registerToolSearchShim registers the tool even when getActiveTools throws (pre-bind runtime)", () => {
  const pi = makeFakePi({ getActiveToolsThrows: true, setActiveToolsThrows: true });
  // Must not throw — the old code let this propagate.
  assert.doesNotThrow(() => registerToolSearchShim(pi as any));
  assert.ok(pi.registered.includes("ToolSearch"), "tool must be registered despite the pre-bind stubs");
});

test("registerToolSearchShim activates ToolSearch when the runtime is bound (no throw)", () => {
  const pi = makeFakePi({ activeTools: ["bash", "read"] });
  registerToolSearchShim(pi as any);
  assert.ok(pi.registered.includes("ToolSearch"));
  assert.equal(pi.setCalls.length, 1, "setActiveTools called once to add ToolSearch");
  assert.ok(pi.setCalls[0]!.includes("ToolSearch"), "ToolSearch added to the active set");
});

test("registerToolSearchShim does not re-add ToolSearch if already active", () => {
  const pi = makeFakePi({ activeTools: ["ToolSearch", "bash"] });
  registerToolSearchShim(pi as any);
  assert.ok(pi.registered.includes("ToolSearch"));
  assert.equal(pi.setCalls.length, 0, "setActiveTools not called when ToolSearch is already active");
});

