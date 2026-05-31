import { describe, expect, it } from "vitest";
import { getModels } from "../src/models.ts";

const bedrockModelIds = new Set(getModels("amazon-bedrock").map((model) => model.id));

describe("Bedrock lifecycle validation", () => {
	it("excludes known EOL Bedrock model IDs", () => {
		const eolModelIds = [
			"anthropic.claude-3-opus-20240229-v1:0",
			"us.anthropic.claude-3-opus-20240229-v1:0",
			"global.anthropic.claude-3-sonnet-20240229-v1:0",
			"us.anthropic.claude-3-haiku-20240307-v1:0",
		];

		for (const modelId of eolModelIds) {
			expect(bedrockModelIds.has(modelId), `${modelId} should not be present`).toBe(false);
		}
	});

	it("excludes known legacy Bedrock model IDs", () => {
		const legacyModelIds = [
			"anthropic.claude-3-5-sonnet-20240620-v1:0",
			"anthropic.claude-3-5-sonnet-20241022-v2:0",
			"anthropic.claude-3-5-haiku-20241022-v1:0",
			"us.anthropic.claude-3-5-sonnet-20241022-v2:0",
			"global.anthropic.claude-3-5-haiku-20241022-v1:0",
		];

		for (const modelId of legacyModelIds) {
			expect(bedrockModelIds.has(modelId), `${modelId} should not be present`).toBe(false);
		}
	});

	it("ensures bare Anthropic model IDs have inference profiles", () => {
		const bareAnthropicIds = Array.from(bedrockModelIds).filter((modelId) => modelId.startsWith("anthropic."));

		for (const modelId of bareAnthropicIds) {
			const profiledId = modelId.replace(/^anthropic\./, "us.anthropic.");
			const globalProfiledId = modelId.replace(/^anthropic\./, "global.anthropic.");
			expect(
				bedrockModelIds.has(profiledId) || bedrockModelIds.has(globalProfiledId),
				`${modelId} should have a us.* or global.* inference profile`,
			).toBe(true);
		}
	});

	it("includes the current-generation Opus Bedrock profile", () => {
		expect(bedrockModelIds.has("us.anthropic.claude-opus-4-8")).toBe(true);
	});
});
