import type { AgentTool } from "./types.js";
import { CLAUDE_CODE_TOOL_ALIASES, resolveAgentToolName } from "@gsd/pi-ai";

/**
 * Resolve a tool call name against the active tool registry.
 * Matches exact name, MCP-unprefixed name, case-insensitive name, then known CC aliases.
 */
export function resolveAgentTool(
	tools: AgentTool<any>[] | undefined,
	requestedName: string,
): AgentTool<any> | undefined {
	if (!tools?.length) {
		return undefined;
	}

	const candidates = [requestedName, resolveAgentToolName(requestedName)];
	for (const candidate of candidates) {
		const direct = tools.find((tool) => tool.name === candidate);
		if (direct) {
			return direct;
		}

		const lower = candidate.toLowerCase();
		const caseInsensitive = tools.find((tool) => tool.name.toLowerCase() === lower);
		if (caseInsensitive) {
			return caseInsensitive;
		}

		const mappedName = CLAUDE_CODE_TOOL_ALIASES[lower];
		if (mappedName) {
			const aliased = tools.find((tool) => tool.name === mappedName);
			if (aliased) {
				return aliased;
			}
		}
	}

	return undefined;
}
