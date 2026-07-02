const ZERO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

const CURSOR_INPUT: ("text" | "image")[] = ["text"];

export const CURSOR_AGENT_MODELS = [
	{
		id: "composer-2.5",
		name: "Composer 2.5 (via Cursor)",
		reasoning: true,
		input: CURSOR_INPUT,
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	},
	{
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (via Cursor)",
		reasoning: true,
		input: CURSOR_INPUT,
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 64_000,
	},
	{
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7 (via Cursor)",
		reasoning: true,
		input: CURSOR_INPUT,
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5 (via Cursor)",
		reasoning: true,
		input: CURSOR_INPUT,
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	},
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro (via Cursor)",
		reasoning: true,
		input: CURSOR_INPUT,
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
	{
		id: "grok-4",
		name: "Grok 4 (via Cursor)",
		reasoning: true,
		input: CURSOR_INPUT,
		cost: ZERO_COST,
		contextWindow: 256_000,
		maxTokens: 64_000,
	},
];
