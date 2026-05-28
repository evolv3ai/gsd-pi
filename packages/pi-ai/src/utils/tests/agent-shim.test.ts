import { describe, expect, test } from "vitest";
import {
	createAgentShimResult,
	extractNormalizedSubagentCall,
	isAgentToolName,
	mapSubagentTypeToGsdAgent,
	normalizeClaudeCodeAgentArguments,
} from "../agent-shim.js";

describe("isAgentToolName", () => {
	test("matches Agent case-insensitively", () => {
		expect(isAgentToolName("Agent")).toBe(true);
		expect(isAgentToolName("agent")).toBe(true);
		expect(isAgentToolName("subagent")).toBe(false);
	});
});

describe("mapSubagentTypeToGsdAgent", () => {
	test("maps Claude Code Explore to scout", () => {
		expect(mapSubagentTypeToGsdAgent("Explore")).toBe("scout");
	});

	test("maps general-purpose variants to worker", () => {
		expect(mapSubagentTypeToGsdAgent("general-purpose")).toBe("worker");
		expect(mapSubagentTypeToGsdAgent("generalPurpose")).toBe("worker");
	});
});

describe("normalizeClaudeCodeAgentArguments", () => {
	test("converts Agent args to subagent shape", () => {
		const args = {
			subagent_type: "Explore",
			description: "Scout current project state",
			prompt: "Read key files and summarize.",
		};
		normalizeClaudeCodeAgentArguments(args);
		expect(args).toEqual({
			agent: "scout",
			task: "Scout current project state\n\nRead key files and summarize.",
		});
	});

	test("prefers explicit task when present", () => {
		const args = {
			subagent_type: "Explore",
			task: "Existing task",
			prompt: "Ignored",
		};
		normalizeClaudeCodeAgentArguments(args);
		expect(args).toEqual({
			agent: "scout",
			task: "Existing task",
		});
	});

	test("removes case-varied subagent type keys after reading them", () => {
		const args = {
			SUBAGENT_TYPE: "Explore",
			prompt: "Inspect repository",
		};

		normalizeClaudeCodeAgentArguments(args);

		expect(args).toEqual({
			agent: "scout",
			task: "Inspect repository",
		});
	});
});

describe("extractNormalizedSubagentCall", () => {
	test("returns mapped agent and task", () => {
		expect(
			extractNormalizedSubagentCall({
				subagent_type: "Explore",
				description: "Scout",
				prompt: "Go",
			}),
		).toEqual({ agent: "scout", task: "Scout\n\nGo" });
	});
});

describe("createAgentShimResult", () => {
	test("returns non-error guidance when subagent is unavailable", () => {
		const result = createAgentShimResult({
			subagent_type: "Explore",
			description: "Scout codebase",
			prompt: "Map modules",
		});
		expect(result.content[0]?.text).toContain("inline");
		expect(result.details.agent).toBe("scout");
		expect(result.details.task).toContain("Scout codebase");
	});
});
