import test from "node:test";
import assert from "node:assert/strict";

import { buildMcpModeTools, mergeMcpModeTools } from "../mcp-mode-tools.ts";
import type { McpToolDef } from "../mcp-server.ts";

function tool(name: string): McpToolDef {
  return {
    name,
    description: `${name} description`,
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: name }] };
    },
  };
}

test("mergeMcpModeTools appends workflow adapter tools without duplicating existing tools", () => {
  const base = [tool("read"), tool("gsd_status")];
  const adapter = [tool("gsd_status"), tool("gsd_roadmap"), tool("gsd_progress")];

  const merged = mergeMcpModeTools(base, adapter);

  assert.deepEqual(merged.map((entry) => entry.name), [
    "read",
    "gsd_status",
    "gsd_roadmap",
    "gsd_progress",
  ]);
  assert.equal(merged.find((entry) => entry.name === "gsd_status"), base[1]);
});

test("buildMcpModeTools loads missing workflow adapter tools for gsd --mode mcp", async () => {
  const merged = await buildMcpModeTools(
    [tool("read")],
    async () => [tool("gsd_status"), tool("gsd_roadmap")],
  );

  assert.deepEqual(merged.map((entry) => entry.name), [
    "read",
    "gsd_status",
    "gsd_roadmap",
  ]);
});
