// Project/App: gsd-pi
// File Purpose: Regression coverage for shared MCP tool-name parsing helpers.

import test from "node:test";
import assert from "node:assert/strict";

import {
  mcpToolMatchesBaseName,
  parseMcpToolName,
  stripMcpToolPrefix,
  toMcpToolName,
  toMcpWildcardToolName,
} from "../mcp-tool-name.ts";

test("parseMcpToolName parses exact and wildcard MCP tool names", () => {
  assert.deepEqual(parseMcpToolName("mcp__gsd-workflow__ask_user_questions"), {
    serverName: "gsd-workflow",
    toolName: "ask_user_questions",
  });
  assert.deepEqual(parseMcpToolName("mcp__gsd-browser__*"), {
    serverName: "gsd-browser",
    toolName: "*",
  });
  assert.equal(parseMcpToolName("browser_navigate"), null);
});

test("MCP tool-name helpers strip, match, and format names consistently", () => {
  assert.equal(stripMcpToolPrefix("mcp__custom-workflow__gsd_exec"), "gsd_exec");
  assert.equal(stripMcpToolPrefix("read"), "read");
  assert.equal(mcpToolMatchesBaseName("mcp__custom-workflow__gsd_exec", "gsd_exec"), true);
  assert.equal(mcpToolMatchesBaseName("mcp__custom-workflow__gsd_exec", "gsd_summary_save"), false);
  assert.equal(toMcpToolName("custom-workflow", "gsd_exec"), "mcp__custom-workflow__gsd_exec");
  assert.equal(toMcpWildcardToolName("custom-workflow"), "mcp__custom-workflow__*");
});
