import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { resolveAgentTool } from "../src/resolve-agent-tool.js";
import type { AgentTool } from "../src/types.js";

function makeTool(name: string): AgentTool<any> {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: name }] };
		},
	};
}

describe("resolveAgentTool", () => {
	it("matches exact and case-insensitive built-in names", () => {
		const tools = [makeTool("bash"), makeTool("find"), makeTool("gsd_exec")];
		expect(resolveAgentTool(tools, "Bash")?.name).toBe("bash");
		expect(resolveAgentTool(tools, "READ")?.name).toBeUndefined();
	});

	it("maps Claude Code Glob to Pi find", () => {
		const tools = [makeTool("find")];
		expect(resolveAgentTool(tools, "Glob")?.name).toBe("find");
	});

	it("maps Claude Code Agent to GSD subagent", () => {
		const tools = [makeTool("subagent")];
		expect(resolveAgentTool(tools, "Agent")?.name).toBe("subagent");
	});

	it("maps Claude Code Grep to Pi grep when registered", () => {
		const tools = [makeTool("grep")];
		expect(resolveAgentTool(tools, "Grep")?.name).toBe("grep");
	});

	it("maps Claude Code Read/Write/Edit/Bash via case-insensitive match", () => {
		const tools = [makeTool("read"), makeTool("write"), makeTool("edit"), makeTool("bash")];
		expect(resolveAgentTool(tools, "Read")?.name).toBe("read");
		expect(resolveAgentTool(tools, "Write")?.name).toBe("write");
		expect(resolveAgentTool(tools, "Edit")?.name).toBe("edit");
		expect(resolveAgentTool(tools, "Bash")?.name).toBe("bash");
	});

	it("maps Claude Code WebFetch to fetch_page when registered", () => {
		const tools = [makeTool("fetch_page")];
		expect(resolveAgentTool(tools, "WebFetch")?.name).toBe("fetch_page");
	});

	it("resolves MCP-prefixed extension tools", () => {
		const tools = [makeTool("gsd_milestone_status")];
		expect(resolveAgentTool(tools, "mcp__gsd-workflow__gsd_milestone_status")?.name).toBe(
			"gsd_milestone_status",
		);
	});
});
