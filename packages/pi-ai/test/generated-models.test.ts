// Project/App: gsd-pi
// File Purpose: Regression tests for generated model catalog output.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { MODELS } from "../src/models.generated.ts";

describe("models.generated.ts", () => {
	test("does not include floating-point precision artifacts in cost literals", () => {
		// allow-source-grep: generated catalog is data output; this test guards numeric literal formatting only
		const generated = readFileSync(join(import.meta.dirname, "../src/models.generated.ts"), "utf8");
		const noisyCostLiteral = /^\s+(?:input|output|cacheRead|cacheWrite): \d+\.\d{13,},/m;

		expect(generated).not.toMatch(noisyCostLiteral);
	});

	test("includes Claude Fable 5 across its supported providers with adaptive thinking", () => {
		const anthropic = MODELS.anthropic["claude-fable-5"];
		expect(anthropic).toBeDefined();
		expect(anthropic.api).toBe("anthropic-messages");
		expect(anthropic.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
		expect(anthropic.compat).toMatchObject({ forceAdaptiveThinking: true });

		const vertex = MODELS["anthropic-vertex"]["claude-fable-5"];
		expect(vertex).toBeDefined();
		expect(vertex.api).toBe("anthropic-vertex");
		expect(vertex.compat).toMatchObject({ forceAdaptiveThinking: true });

		expect(MODELS["amazon-bedrock"]["us.anthropic.claude-fable-5"]).toBeDefined();
		expect(MODELS.openrouter["anthropic/claude-fable-5"]).toBeDefined();
	});

	test("includes Claude Sonnet 5 across Anthropic-backed providers with adaptive thinking", () => {
		const anthropic = MODELS.anthropic["claude-sonnet-5"];
		expect(anthropic).toBeDefined();
		expect(anthropic.api).toBe("anthropic-messages");
		expect(anthropic.name).toBe("Claude Sonnet 5");
		expect(anthropic.contextWindow).toBe(1_000_000);
		expect(anthropic.maxTokens).toBe(128_000);
		expect(anthropic.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
		expect(anthropic.compat).toMatchObject({ forceAdaptiveThinking: true });

		const vertex = MODELS["anthropic-vertex"]["claude-sonnet-5"];
		expect(vertex).toBeDefined();
		expect(vertex.api).toBe("anthropic-vertex");
		expect(vertex.name).toBe("Claude Sonnet 5 (Vertex)");
		expect(vertex.contextWindow).toBe(1_000_000);
		expect(vertex.maxTokens).toBe(128_000);
		expect(vertex.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
		expect(vertex.compat).toMatchObject({ forceAdaptiveThinking: true });

		for (const [id, name] of [
			["anthropic.claude-sonnet-5", "Claude Sonnet 5"],
			["us.anthropic.claude-sonnet-5", "Claude Sonnet 5 (US)"],
			["global.anthropic.claude-sonnet-5", "Claude Sonnet 5 (Global)"],
		] as const) {
			const bedrock = MODELS["amazon-bedrock"][id];
			expect(bedrock).toBeDefined();
			expect(bedrock.api).toBe("bedrock-converse-stream");
			expect(bedrock.name).toBe(name);
			expect(bedrock.contextWindow).toBe(1_000_000);
			expect(bedrock.maxTokens).toBe(128_000);
			expect(bedrock.thinkingLevelMap).toMatchObject({ xhigh: "xhigh" });
		}
	});

	test("includes Anthropic Vertex models from the generated catalog", () => {
		const models = MODELS["anthropic-vertex"];

		expect(models).toBeDefined();
		expect(models["claude-sonnet-4-6"]).toBeDefined();
		expect(models["claude-opus-4-8"]).toBeDefined();
		expect(models["claude-haiku-4-5@20251001"]).toBeDefined();
		expect(Object.keys(models).some((id) => id.includes("@default"))).toBe(false);

		for (const model of Object.values(models)) {
			expect(model.provider).toBe("anthropic-vertex");
			expect(model.api).toBe("anthropic-vertex");
		}
	});

	test("includes MiniMax M3 for direct MiniMax providers", () => {
		const providers = [
			["minimax", "https://api.minimax.io/anthropic"],
			["minimax-cn", "https://api.minimaxi.com/anthropic"],
		] as const;

		for (const [provider, baseUrl] of providers) {
			const model = MODELS[provider]["MiniMax-M3"];

			expect(model).toMatchObject({
				id: "MiniMax-M3",
				name: "MiniMax-M3",
				api: "anthropic-messages",
				provider,
				baseUrl,
				reasoning: true,
				input: ["text", "image"],
				cost: {
					input: 0.6,
					output: 2.4,
					cacheRead: 0.12,
					cacheWrite: 0,
				},
				contextWindow: 1000000,
				maxTokens: 131072,
			});
		}
	});

	test("keeps GitHub Copilot Claude 4.6 context at Copilot's 200K limit", () => {
		for (const id of ["claude-opus-4.6", "claude-sonnet-4.6"] as const) {
			const model = MODELS["github-copilot"][id];

			expect(model.provider).toBe("github-copilot");
			expect(model.api).toBe("anthropic-messages");
			expect(model.contextWindow).toBe(200000);
			expect(model.maxTokens).toBe(32000);
		}
	});
});
