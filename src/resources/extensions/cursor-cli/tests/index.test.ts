import { test } from "node:test";
import assert from "node:assert/strict";
import cursorCli from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function makeMockPi() {
	const providers: Array<{ name: string; config: Record<string, unknown> }> = [];
	const pi = {
		on(_event: string, _handler: Handler) {},
		registerProvider(name: string, config: Record<string, unknown>) {
			providers.push({ name, config });
		},
	};
	return { pi, providers };
}

test("registers the cursor-agent provider with external CLI auth", () => {
	const { pi, providers } = makeMockPi();
	cursorCli(pi as never);

	assert.equal(providers.length, 1);
	assert.equal(providers[0].name, "cursor-agent");
	assert.equal(providers[0].config.name, "Cursor Agent");
	assert.equal(providers[0].config.authMode, "externalCli");
	assert.equal(providers[0].config.api, "cursor-stream-json");
	assert.equal(providers[0].config.baseUrl, "local://cursor-agent");
	assert.equal(typeof providers[0].config.isReady, "function");
	assert.equal(typeof providers[0].config.streamSimple, "function");
});

test("registers static Cursor subscription models", () => {
	const { pi, providers } = makeMockPi();
	cursorCli(pi as never);

	const models = providers[0].config.models as Array<Record<string, unknown>>;
	assert.ok(models.some((model) => model.id === "composer-2.5"));
	assert.ok(models.some((model) => model.id === "claude-sonnet-4-6"));
	assert.ok(models.some((model) => model.id === "gpt-5.5"));
	assert.ok(models.every((model) => (model.cost as Record<string, number>).input === 0));
});

test("GSD_CURSOR_DISABLE keeps the provider dormant", () => {
	const original = process.env.GSD_CURSOR_DISABLE;
	process.env.GSD_CURSOR_DISABLE = "1";
	try {
		const { pi, providers } = makeMockPi();
		cursorCli(pi as never);
		assert.equal(providers.length, 0);
	} finally {
		if (original === undefined) delete process.env.GSD_CURSOR_DISABLE;
		else process.env.GSD_CURSOR_DISABLE = original;
	}
});
