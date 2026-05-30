import test, { describe } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@gsd/pi-ai";
import type { ModelRegistry } from "@gsd/pi-coding-agent/core/model-registry.js";
import { listModels } from "./list-models.js";

function testModel(provider: string, id: string): Model<any> {
	return {
		provider,
		id,
		name: id,
		contextWindow: 1000,
		maxTokens: 100,
		reasoning: false,
		input: ["text"],
	} as Model<any>;
}

describe("listModels", () => {
	test("filters non-ready providers from discover listings", async () => {
		const enabledModel = testModel("enabled", "visible-model");
		const disabledModel = testModel("disabled", "hidden-model");
		const registry = {
			discoverModels: async () => [],
			getAllWithDiscovered: () => [enabledModel, disabledModel],
			getAvailable: () => [enabledModel],
			isProviderRequestReady: (provider: string) => provider !== "disabled",
			isDiscovered: () => false,
		} as unknown as ModelRegistry;

		const output: string[] = [];
		const originalLog = console.log;
		console.log = (message?: unknown) => {
			output.push(String(message));
		};

		try {
			await listModels(registry, { discover: true });
		} finally {
			console.log = originalLog;
		}

		assert.match(output.join("\n"), /visible-model/);
		assert.doesNotMatch(output.join("\n"), /hidden-model/);
	});
});
