const ZERO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

export const GOOGLE_GEMINI_CLI_MODELS = [
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		reasoning: true,
		input: ["text" as const],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
	{
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		reasoning: true,
		input: ["text" as const],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
	{
		id: "gemini-3-flash-preview",
		name: "Gemini 3 Flash Preview",
		reasoning: true,
		input: ["text" as const],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
	{
		id: "gemini-3.1-pro-preview",
		name: "Gemini 3.1 Pro Preview",
		reasoning: true,
		input: ["text" as const],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
];

export const GOOGLE_ANTIGRAVITY_MODELS = [
	{
		id: "default",
		name: "Antigravity Default",
		reasoning: true,
		input: ["text" as const],
		cost: ZERO_COST,
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	},
];
