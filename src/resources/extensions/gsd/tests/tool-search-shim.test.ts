import test from "node:test";
import assert from "node:assert/strict";

import { parseToolSearchSelectQuery } from "@gsd/pi-ai";

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
