import { describe, expect, test } from "vitest";
import {
	createToolSearchShimResult,
	isToolSearchToolName,
	parseToolSearchSelectQuery,
} from "../tool-search-shim.js";

describe("tool-search-shim", () => {
	test("parseToolSearchSelectQuery extracts MCP tool name", () => {
		expect(parseToolSearchSelectQuery("select:mcp__gsd-workflow__gsd_milestone_status")).toBe(
			"mcp__gsd-workflow__gsd_milestone_status",
		);
	});

	test("createToolSearchShimResult guides direct MCP call", () => {
		const result = createToolSearchShimResult({
			query: "select:mcp__gsd-workflow__gsd_milestone_status",
		});
		expect(result.content[0]?.text).toContain("mcp__gsd-workflow__gsd_milestone_status");
		expect(result.details.resolvedTool).toBe("mcp__gsd-workflow__gsd_milestone_status");
	});

	test("isToolSearchToolName is case insensitive", () => {
		expect(isToolSearchToolName("ToolSearch")).toBe(true);
		expect(isToolSearchToolName("toolsearch")).toBe(true);
		expect(isToolSearchToolName("Read")).toBe(false);
	});
});
