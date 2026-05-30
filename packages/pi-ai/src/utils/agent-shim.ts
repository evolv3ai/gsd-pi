/**
 * Claude Code `Agent` tool compatibility for Pi/GSD runtimes.
 * Models emit `{ subagent_type, description, prompt }`; GSD uses `subagent` with `{ agent, task }`.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isAgentToolName(toolName: string): boolean {
	return toolName.toLowerCase() === "agent";
}

function normalizeSubagentTypeKey(value: string): string {
	return value.toLowerCase().replace(/[-_\s]/g, "");
}

/** Claude Code / Cursor subagent_type values mapped to GSD agent names. */
export const SUBAGENT_TYPE_ALIASES: Readonly<Record<string, string>> = {
	explore: "scout",
	generalpurpose: "worker",
	general: "worker",
	shell: "worker",
	plan: "planner",
	planner: "planner",
	research: "researcher",
	researcher: "researcher",
	review: "reviewer",
	reviewer: "reviewer",
	debug: "debugger",
	debugger: "debugger",
	test: "tester",
	tester: "tester",
	doc: "doc-writer",
	docwriter: "doc-writer",
	security: "security",
	refactor: "refactorer",
	refactorer: "refactorer",
	typescript: "typescript-pro",
	typescriptpro: "typescript-pro",
	javascript: "javascript-pro",
	javascriptpro: "javascript-pro",
	git: "git-ops",
	gitops: "git-ops",
	scout: "scout",
	worker: "worker",
};

export function mapSubagentTypeToGsdAgent(subagentType: string): string {
	const key = normalizeSubagentTypeKey(subagentType);
	return SUBAGENT_TYPE_ALIASES[key] ?? subagentType.toLowerCase();
}

function readStringField(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

function readSubagentType(args: Record<string, unknown>): string | undefined {
	for (const [key, value] of Object.entries(args)) {
		if (key.toLowerCase() !== "subagent_type") continue;
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return undefined;
}

/**
 * Convert Claude Code Agent arguments to GSD subagent shape in-place.
 */
export function normalizeClaudeCodeAgentArguments(args: Record<string, unknown>): void {
	const subagentType = readSubagentType(args);
	if (subagentType && args.agent === undefined) {
		args.agent = mapSubagentTypeToGsdAgent(subagentType);
	}

	if (typeof args.agent === "string") {
		args.agent = mapSubagentTypeToGsdAgent(args.agent);
	}

	const prompt = readStringField(args, ["prompt", "Prompt"]);
	const description = readStringField(args, ["description", "Description"]);
	const existingTask = readStringField(args, ["task", "Task"]);

	if (!existingTask) {
		if (prompt && description && prompt !== description) {
			args.task = `${description}\n\n${prompt}`;
		} else {
			args.task = prompt ?? description;
		}
	}

	for (const key of Object.keys(args)) {
		const lowerKey = key.toLowerCase();
		if (lowerKey === "subagent_type" || lowerKey === "subagenttype") {
			delete args[key];
		}
	}
	delete args.prompt;
	delete args.Prompt;
	delete args.description;
	delete args.Description;
}

export function extractNormalizedSubagentCall(args: unknown): { agent: string | null; task: string | null } {
	if (!isRecord(args)) {
		return { agent: null, task: null };
	}
	const cloned = structuredClone(args);
	normalizeClaudeCodeAgentArguments(cloned);
	const agent = typeof cloned.agent === "string" ? cloned.agent : null;
	const task = typeof cloned.task === "string" ? cloned.task : null;
	return { agent, task };
}

export function createAgentShimResult(args: unknown): {
	content: Array<{ type: "text"; text: string }>;
	details: { operation: "agent_shim"; agent: string | null; task: string | null };
} {
	const { agent, task } = extractNormalizedSubagentCall(args);
	const text =
		agent && task
			? `Subagent dispatch is not available in the current tool scope. Perform this work inline using read, grep, and bash instead of delegating to \`${agent}\`. Task summary: ${task.slice(0, 200)}${task.length > 200 ? "…" : ""}`
			: "Subagent dispatch is not available in the current tool scope. Perform this work inline using read, grep, and bash instead of the Claude Code Agent tool.";
	return {
		content: [{ type: "text", text }],
		details: { operation: "agent_shim", agent, task },
	};
}
