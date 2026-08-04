// @gsd/pi-coding-agent + model-registry-catalog-overlay.test — coverage for the
// user-level models catalog overlay (models-catalog.json), written by
// `gsd update --models`. The overlay is a sibling of models.json and sits
// between the bundled catalog and models.json:
// bundled catalog < overlay < models.json custom providers/overrides.
// A missing or malformed overlay must never break startup.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels } from "@gsd/pi-ai";
import type { Api, Model } from "@gsd/pi-ai";
import { AuthStorage } from "../core/auth-storage.js";
import { ModelRegistry } from "../core/model-registry.js";

function makeTempDir(t: TestContext): string {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-test-models-catalog-overlay-"));
	t.after(() => rmSync(tempDir, { recursive: true, force: true }));
	return tempDir;
}

function makeRegistry(tempDir: string): ModelRegistry {
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	return ModelRegistry.create(authStorage, join(tempDir, "models.json"));
}

function overlayModel(overrides: Partial<Model<Api>> & { id: string; provider: string }): Model<Api> {
	return {
		name: overrides.id,
		api: "anthropic-messages",
		baseUrl: "https://api.anthropic.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		contextWindow: 200000,
		maxTokens: 8192,
		...overrides,
	} as Model<Api>;
}

function writeOverlay(tempDir: string, models: Record<string, Record<string, Model<Api>>>): void {
	writeFileSync(
		join(tempDir, "models-catalog.json"),
		JSON.stringify({
			version: 1,
			fetchedAt: "2025-01-01T00:00:00.000Z",
			source: "https://example.com/models.generated.json",
			models,
		}),
	);
}

test("model-registry catalog overlay: missing overlay file is a no-op", (t) => {
	const tempDir = makeTempDir(t);
	const registry = makeRegistry(tempDir);
	assert.equal(registry.getError(), undefined);
	assert.ok(registry.getAll().length > 0, "bundled models should load without an overlay");
});

test("model-registry catalog overlay: adds a new model to an existing provider", (t) => {
	const tempDir = makeTempDir(t);
	writeOverlay(tempDir, {
		anthropic: {
			"claude-future-9": overlayModel({ id: "claude-future-9", provider: "anthropic" }),
		},
	});

	const registry = makeRegistry(tempDir);
	assert.equal(registry.getError(), undefined);

	const overlaid = registry.find("anthropic", "claude-future-9");
	assert.ok(overlaid, "overlay model should be registered");
	assert.equal(overlaid.provider, "anthropic");
	assert.equal(overlaid.cost.input, 1);
	assert.equal(overlaid.contextWindow, 200000);

	const bundled = getModels("anthropic" as Parameters<typeof getModels>[0]) as Model<Api>[];
	assert.ok(bundled.length > 0);
	for (const model of bundled) {
		assert.ok(registry.find("anthropic", model.id), `bundled model ${model.id} should remain`);
	}
});

test("model-registry catalog overlay: replaces a bundled entry wholesale", (t) => {
	const tempDir = makeTempDir(t);
	const bundled = getModels("anthropic" as Parameters<typeof getModels>[0]) as Model<Api>[];
	assert.ok(bundled.length > 0, "expected bundled anthropic models");
	const target = bundled[0];

	writeOverlay(tempDir, {
		anthropic: {
			[target.id]: {
				...target,
				cost: { input: 999, output: 999, cacheRead: 999, cacheWrite: 999 },
			},
		},
	});

	const registry = makeRegistry(tempDir);
	assert.equal(registry.getError(), undefined);

	const replaced = registry.find("anthropic", target.id);
	assert.ok(replaced, "replaced model should still be registered");
	assert.equal(replaced.cost.input, 999);
	assert.equal(replaced.cost.output, 999);
});

test("model-registry catalog overlay: adds a brand-new provider", (t) => {
	const tempDir = makeTempDir(t);
	writeOverlay(tempDir, {
		"future-labs": {
			"fl-1": overlayModel({ id: "fl-1", provider: "future-labs" }),
		},
	});

	const registry = makeRegistry(tempDir);
	assert.equal(registry.getError(), undefined);

	const added = registry.find("future-labs", "fl-1");
	assert.ok(added, "overlay model from a new provider should be registered");
	assert.equal(added.provider, "future-labs");
	assert.equal(added.name, "fl-1");
});

test("model-registry catalog overlay: malformed JSON is ignored without breaking startup", (t) => {
	const tempDir = makeTempDir(t);
	writeFileSync(join(tempDir, "models-catalog.json"), "{ not valid json !!!");

	const registry = makeRegistry(tempDir);
	const error = registry.getError();
	assert.ok(error, "malformed overlay should surface a non-fatal error");
	assert.match(error, /models-catalog\.json/);
	assert.ok(registry.getAll().length > 0, "bundled models should still load");
});

test("model-registry catalog overlay: invalid overlay is ignored without breaking startup", (t) => {
	const tempDir = makeTempDir(t);
	for (const overlay of [
		{ version: 2, models: { anthropic: { "claude-future-9": overlayModel({ id: "claude-future-9", provider: "anthropic" }) } } },
		{ version: 1, models: ["nope"] },
		{ version: 1, models: { anthropic: { "claude-future-9": {} } } },
		{ version: 1, models: { anthropic: { "claude-future-9": null } } },
	]) {
		writeFileSync(join(tempDir, "models-catalog.json"), JSON.stringify(overlay));

		const registry = makeRegistry(tempDir);
		const error = registry.getError();
		assert.ok(error, "invalid overlay should surface a non-fatal error");
		assert.match(error, /models-catalog\.json/);
		assert.ok(registry.getAll().length > 0, "bundled models should still load");
		assert.equal(registry.find("anthropic", "claude-future-9"), undefined);
	}
});

test("model-registry catalog overlay: models.json custom entry wins over the overlay", (t) => {
	const tempDir = makeTempDir(t);
	writeOverlay(tempDir, {
		anthropic: {
			"claude-future-9": overlayModel({
				id: "claude-future-9",
				provider: "anthropic",
				name: "Overlay Name",
				cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
			}),
		},
	});
	writeFileSync(
		join(tempDir, "models.json"),
		JSON.stringify({
			providers: {
				anthropic: {
					models: [
						{
							id: "claude-future-9",
							name: "User Custom Name",
							cost: { input: 42, output: 42, cacheRead: 42, cacheWrite: 42 },
						},
					],
				},
			},
		}),
	);

	const registry = makeRegistry(tempDir);
	assert.equal(registry.getError(), undefined);

	const winner = registry.find("anthropic", "claude-future-9");
	assert.ok(winner, "model should be registered");
	assert.equal(winner.name, "User Custom Name", "models.json custom entry should win over the overlay");
	assert.equal(winner.cost.input, 42);
});

test("model-registry catalog overlay: models.json modelOverrides apply on top of the overlay", (t) => {
	const tempDir = makeTempDir(t);
	writeOverlay(tempDir, {
		anthropic: {
			"claude-future-9": overlayModel({ id: "claude-future-9", provider: "anthropic" }),
		},
	});
	writeFileSync(
		join(tempDir, "models.json"),
		JSON.stringify({
			providers: {
				anthropic: {
					modelOverrides: {
						"claude-future-9": { cost: { input: 7 } },
					},
				},
			},
		}),
	);

	const registry = makeRegistry(tempDir);
	assert.equal(registry.getError(), undefined);

	const model = registry.find("anthropic", "claude-future-9");
	assert.ok(model, "overlay model should be registered");
	assert.equal(model.cost.input, 7, "user modelOverride should apply on top of the overlay");
	assert.equal(model.cost.output, 2, "non-overridden fields keep overlay values");
});
