import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build, type Plugin } from "esbuild";

const root = process.cwd();

async function importUtilities(): Promise<typeof import("../../test/utilities.ts")> {
	const cacheDir = join(root, ".cache");
	await mkdir(cacheDir, { recursive: true });
	const outdir = await mkdtemp(join(cacheDir, "pi-coding-agent-utilities-"));
	const outfile = join(outdir, "entry.mjs");
	const plugin: Plugin = {
		name: "utilities-stubs",
		setup(buildApi) {
			buildApi.onResolve(
				{
					filter:
						/^@earendil-works\/pi-agent-core$|^@earendil-works\/pi-ai$|^@earendil-works\/pi-ai\/oauth$|^@gsd\/agent-core$|^\.\.\/src\/(?:index|core\/(?:auth-storage|event-bus|model-registry|resource-loader|session-manager|settings-manager))\.ts$|^\.\.\/src\/core\/extensions\/(?:index|loader)\.ts$/,
				},
				(args) => ({ path: args.path, namespace: "utilities-stub" }),
			);
			buildApi.onLoad({ filter: /.*/, namespace: "utilities-stub" }, (args) => {
				const stubs: Record<string, string> = {
					"@earendil-works/pi-agent-core": "export class Agent { constructor(options) { this.options = options; } }",
					"@earendil-works/pi-ai": "export function getModel() { return { provider: 'faux', id: 'model' }; }",
					"@earendil-works/pi-ai/oauth": `
						export async function getOAuthApiKey() {
							return { apiKey: "oauth-key", newCredentials: { accessToken: "tok" } };
						}
					`,
					"@gsd/agent-core": `
						export class AgentSession {
							constructor(options) { this.options = options; this.messages = []; }
							subscribe() {}
							dispose() { this.disposed = true; }
						}
					`,
					"../src/core/auth-storage.ts": `
						export class AuthStorage {
							static create(path) { return { kind: "auth", path }; }
						}
					`,
					"../src/core/event-bus.ts": "export function createEventBus() { return { kind: 'event-bus' }; }",
					"../src/core/extensions/index.ts": "export {};",
					"../src/core/extensions/loader.ts": `
						export function createExtensionRuntime() { return { kind: "runtime" }; }
						export async function loadExtensionFromFactory(factory, cwd, eventBus, runtime, extensionPath) {
							return { value: await factory(), cwd, eventBus, runtime, extensionPath };
						}
					`,
					"../src/core/model-registry.ts": `
						export class ModelRegistry {
							static create(authStorage, tempDir) { return { authStorage, tempDir }; }
						}
					`,
					"../src/core/resource-loader.ts": "export {};",
					"../src/core/session-manager.ts": `
						export class SessionManager {
							static create(tempDir) { return { kind: "session-manager", tempDir }; }
							static inMemory() { return { kind: "session-manager", memory: true }; }
						}
					`,
					"../src/core/settings-manager.ts": `
						export class SettingsManager {
							static create(tempDir, cwd) { return { tempDir, cwd, applyOverrides(overrides) { this.overrides = overrides; } }; }
						}
					`,
					"../src/index.ts": "export function createCodingTools(cwd) { return [{ name: 'tool', cwd }]; }",
				};
				return { contents: stubs[args.path], loader: "js", resolveDir: root };
			});
		},
	};
	await build({
		entryPoints: [join(root, "packages/pi-coding-agent/test/utilities.ts")],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		plugins: [plugin],
	});
	return import(pathToFileURL(outfile).href);
}

test("test utilities build canonical messages and resource loaders", async () => {
	const utilities = await importUtilities();

	assert.equal(utilities.userMsg("hello").role, "user");
	assert.equal(utilities.userMsg("hello").content, "hello");

	const assistant = utilities.assistantMsg("reply");
	assert.equal(assistant.role, "assistant");
	assert.deepEqual(assistant.content, [{ type: "text", text: "reply" }]);
	assert.equal(assistant.usage.totalTokens, 2);

	const loader = utilities.createTestResourceLoader();
	assert.deepEqual(loader.getSkills(), { skills: [], diagnostics: [] });
	assert.deepEqual(loader.getPrompts(), { prompts: [], diagnostics: [] });
	assert.deepEqual(loader.getThemes(), { themes: [], diagnostics: [] });
	assert.deepEqual(loader.getAgentsFiles(), { agentsFiles: [] });
	assert.equal(loader.getSystemPrompt(), undefined);
	assert.deepEqual(loader.getAppendSystemPrompt(), []);
});

test("test utilities assemble extension results and branch session trees", async () => {
	const utilities = await importUtilities();
	const result = await utilities.createTestExtensionsResult(
		[() => ({ name: "one" }), { factory: () => ({ name: "two" }), path: "/tmp/two.ts" }],
		"/tmp/project",
	);
	assert.equal(result.errors.length, 0);
	assert.equal(result.extensions[0]?.extensionPath, "<inline:1>");
	assert.equal(result.extensions[1]?.extensionPath, "/tmp/two.ts");
	assert.deepEqual(result.extensions.map((extension) => extension.value.name), ["one", "two"]);

	const appended: Array<{ role: string; content?: string }> = [];
	const branches: string[] = [];
	const fakeSession = {
		appendMessage(message: { role: string; content?: string }) {
			appended.push(message);
			return `id-${appended.length}`;
		},
		branch(id: string) {
			branches.push(id);
		},
	};
	const ids = utilities.buildTestTree(fakeSession as never, {
		messages: [
			{ role: "user", text: "first" },
			{ role: "assistant", text: "second" },
			{ role: "user", text: "branch", branchFrom: "first" },
		],
	});
	assert.equal(ids.get("branch"), "id-3");
	assert.deepEqual(branches, ["id-1"]);
	assert.deepEqual(appended.map((message) => message.role), ["user", "assistant", "user"]);
	assert.throws(
		() =>
			utilities.buildTestTree(fakeSession as never, {
				messages: [{ role: "user", text: "missing", branchFrom: "unknown" }],
			}),
		/Cannot branch from unknown entry: unknown/,
	);
});
