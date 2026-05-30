/**
 * Anthropic deferred-tool ToolSearch is not supported in Pi/GSD runtimes.
 * Models still emit `select:mcp__…__tool` queries; return explicit guidance instead
 * of a hard "Tool ToolSearch not found" failure.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isToolSearchToolName(toolName: string): boolean {
	return toolName.toLowerCase() === "toolsearch";
}

export function parseToolSearchSelectQuery(query: string): string | null {
	const trimmed = query.trim();
	const match = trimmed.match(/^select:(.+)$/i);
	if (!match) return null;
	const name = match[1]?.trim();
	return name && name.length > 0 ? name : null;
}

export function extractToolSearchQuery(args: unknown): string {
	if (typeof args === "string") {
		return args;
	}
	if (!isRecord(args)) {
		return "";
	}
	if (typeof args.query === "string") {
		return args.query;
	}
	if (typeof args.input === "string") {
		return args.input;
	}
	return "";
}

function formatDirectCallHint(toolName: string): string {
	if (toolName.startsWith("mcp__")) {
		return `Call \`${toolName}\` directly in a tool-use block. ToolSearch is not available in GSD.`;
	}
	if (toolName.startsWith("gsd_") || toolName === "memory_query" || toolName === "capture_thought") {
		return (
			`Call \`${toolName}\` directly (or \`mcp__gsd-workflow__${toolName}\` when running inside Claude Code). ` +
			"ToolSearch is not available in GSD."
		);
	}
	return `Call \`${toolName}\` directly. ToolSearch is not available in GSD.`;
}

export function createToolSearchShimResult(args: unknown): {
	content: Array<{ type: "text"; text: string }>;
	details: { operation: "tool_search_shim"; query: string; resolvedTool: string | null };
} {
	const query = extractToolSearchQuery(args);
	const selected = parseToolSearchSelectQuery(query);
	const text = selected
		? formatDirectCallHint(selected)
		: "ToolSearch is not available in GSD. Call the workflow tool you need directly by name.";
	return {
		content: [{ type: "text", text }],
		details: { operation: "tool_search_shim", query, resolvedTool: selected },
	};
}
