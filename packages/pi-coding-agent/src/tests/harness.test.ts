import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build, type Plugin } from "esbuild";

const root = process.cwd();

async function importSuiteHarness(): Promise<typeof import("../../test/suite/harness.ts")> {
	const cacheDir = join(root, ".cache");
	await mkdir(cacheDir, { recursive: true });
	const outdir = await mkdtemp(join(cacheDir, "pi-coding-agent-suite-harness-"));
	const outfile = join(outdir, "entry.mjs");
	const plugin: Plugin = {
		name: "suite-harness-stubs",
		setup(buildApi) {
			buildApi.onResolve(
				{
					filter:
						/^@earendil-works\/pi-agent-core$|^@earendil-works\/pi-ai$|^@gsd\/agent-core$|^\.\.\/\.\.\/src\/core\/(?:auth-storage|messages|model-registry|session-manager|settings-manager)\.ts$|^\.\.\/\.\.\/src\/core\/extensions\/index\.ts$|^\.\.\/\.\.\/src\/index\.ts$|^\.\.\/utilities\.ts$/,
				},
				(args) => ({ path: args.path, namespace: "suite-harness-stub" }),
			);
			buildApi.onLoad({ filter: /.*/, namespace: "suite-harness-stub" }, (args) => {
				const stubs: Record<string, string> = {
					"@earendil-works/pi-agent-core": "export class Agent { constructor(options) { this.options = options; } }",
					"@earendil-works/pi-ai": `
						export function registerFauxProvider() {
							return {
								models: [{ id: "faux", provider: "faux", api: "faux" }],
								api: "faux",
								getModel() { return this.models[0]; },
								setResponses(responses) { this.responses = responses; },
								appendResponses(responses) { this.responses = [...(this.responses || []), ...responses]; },
								getPendingResponseCount() { return (this.responses || []).length; },
								unregister() {},
							};
						}
					`,
					"@gsd/agent-core": `
						export class AgentSession {
							constructor(options) { this.options = options; this.messages = []; }
							subscribe(callback) { this.callback = callback; }
							dispose() { this.disposed = true; }
						}
					`,
					"../../src/core/auth-storage.ts": `
						export class AuthStorage {
							static inMemory() { return { setRuntimeApiKey(provider, key) { this.provider = provider; this.key = key; } }; }
						}
					`,
					"../../src/core/extensions/index.ts": "export {};",
					"../../src/core/messages.ts": "export function convertToLlm(messages) { return messages; }",
					"../../src/core/model-registry.ts": `
						export class ModelRegistry {
							static inMemory() { return { registerProvider(provider, config) { this.provider = provider; this.config = config; } }; }
						}
					`,
					"../../src/core/session-manager.ts": "export class SessionManager { static inMemory() { return {}; } }",
					"../../src/core/settings-manager.ts": "export class SettingsManager { static inMemory(settings) { return { settings }; } }",
					"../../src/index.ts": "export {};",
					"../utilities.ts": `
						export async function createTestExtensionsResult() {
							return { extensions: [], errors: [], runtime: {} };
						}
						export function createTestResourceLoader() {
							return { getExtensions: () => ({ extensions: [], errors: [], runtime: {} }) };
						}
					`,
				};
				return { contents: stubs[args.path], loader: "js", resolveDir: root };
			});
		},
	};
	await build({
		entryPoints: [join(root, "packages/pi-coding-agent/test/suite/harness.ts")],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		plugins: [plugin],
	});
	return import(pathToFileURL(outfile).href);
}

test("suite harness extracts text content from session messages", async () => {
	const harness = await importSuiteHarness();
	assert.equal(harness.getMessageText(undefined), "");
	assert.equal(harness.getMessageText({ content: "plain text" }), "plain text");
	assert.equal(
		harness.getMessageText({
			content: [
				{ type: "text", text: "first" },
				{ type: "tool-call", text: "ignored" },
				{ type: "text", text: "second" },
			],
		}),
		"first\nsecond",
	);

	const fakeHarness = {
		session: {
			messages: [
				{ role: "user", content: "hello" },
				{ role: "assistant", content: [{ type: "text", text: "reply" }] },
				{ role: "tool", content: "ignored" },
			],
		},
	};
	assert.deepEqual(harness.getUserTexts(fakeHarness as never), ["hello"]);
	assert.deepEqual(harness.getAssistantTexts(fakeHarness as never), ["reply"]);
});
