import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build, type Plugin } from "esbuild";

type RuntimeState = {
	children: Array<{ messages: Array<{ content: Array<{ type: string; thinking?: string; text?: string }> }> }>;
	exitCode?: number | string | null;
	requestRenderCount: number;
	started: boolean;
	stopped: boolean;
};

const root = process.cwd();

async function drainUntilStopped(state: RuntimeState): Promise<void> {
	for (let i = 0; i < 1000 && !state.stopped; i += 1) await Promise.resolve();
}

async function importStreamingDebug(): Promise<RuntimeState> {
	const cacheDir = join(root, ".cache");
	await mkdir(cacheDir, { recursive: true });
	const outdir = await mkdtemp(join(cacheDir, "pi-coding-agent-streaming-debug-"));
	const outfile = join(outdir, "entry.mjs");
	const fixtureContent = await readFile(
		join(root, "packages/pi-coding-agent/test/fixtures/assistant-message-with-thinking-code.json"),
		"utf-8",
	);
	const plugin: Plugin = {
		name: "streaming-debug-stubs",
		setup(buildApi) {
			buildApi.onResolve(
				{
					filter:
						/^fs$|^@earendil-works\/pi-tui$|^\.\.\/src\/modes\/interactive\/components\/assistant-message\.ts$|^\.\.\/src\/modes\/interactive\/theme\/theme\.ts$/,
				},
				(args) => ({ path: args.path, namespace: "streaming-debug-stub" }),
			);
			buildApi.onLoad({ filter: /.*/, namespace: "streaming-debug-stub" }, (args) => {
				const stubs: Record<string, string> = {
					fs: `
						export function readFileSync() {
							return ${JSON.stringify(fixtureContent)};
						}
					`,
					"@earendil-works/pi-tui": `
						globalThis.__streamingDebugState = {
							children: [],
							requestRenderCount: 0,
							started: false,
							stopped: false,
						};
						export class ProcessTerminal {}
						export class TUI {
							constructor(terminal) { this.terminal = terminal; }
							addChild(child) { globalThis.__streamingDebugState.children.push(child); }
							requestRender() { globalThis.__streamingDebugState.requestRenderCount += 1; }
							start() { globalThis.__streamingDebugState.started = true; }
							stop() { globalThis.__streamingDebugState.stopped = true; }
						}
					`,
					"../src/modes/interactive/components/assistant-message.ts": `
						export class AssistantMessageComponent {
							constructor(message, collapsed) {
								this.messages = [message];
								this.collapsed = collapsed;
							}
							updateContent(message) { this.messages.push(message); }
						}
					`,
					"../src/modes/interactive/theme/theme.ts": `
						export function initTheme(name) { globalThis.__streamingDebugTheme = name; }
					`,
				};
				return { contents: stubs[args.path], loader: "js", resolveDir: root };
			});
		},
	};
	await build({
		entryPoints: [join(root, "packages/pi-coding-agent/test/streaming-render-debug.ts")],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		plugins: [plugin],
	});
	const originalSetTimeout = globalThis.setTimeout;
	const originalExit = process.exit;
	globalThis.setTimeout = ((callback: () => void) => {
		callback();
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	process.exit = ((code?: number | string | null) => {
		(globalThis as typeof globalThis & { __streamingDebugState: RuntimeState }).__streamingDebugState.exitCode = code;
		return undefined as never;
	}) as typeof process.exit;
	try {
		await import(pathToFileURL(outfile).href);
		const state = (globalThis as typeof globalThis & { __streamingDebugState: RuntimeState }).__streamingDebugState;
		await drainUntilStopped(state);
		return state;
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		process.exit = originalExit;
	}
}

test("streaming debug replays thinking chunks before final text content", async () => {
	const fixturePath = join(
		root,
		"packages/pi-coding-agent/test/fixtures/assistant-message-with-thinking-code.json",
	);
	const fixture = JSON.parse(await readFile(fixturePath, "utf-8")) as {
		content: Array<{ type: string; thinking?: string; text?: string }>;
	};
	const thinking = fixture.content.find((part) => part.type === "thinking")?.thinking ?? "";
	const text = fixture.content.find((part) => part.type === "text")?.text ?? "";
	const expectedChunkUpdates = Math.ceil(thinking.length / 10);

	const state = await importStreamingDebug();
	assert.equal(state.started, true);
	assert.equal(state.stopped, true);
	assert.equal(state.exitCode, 0);
	assert.equal(state.children.length, 1);
	assert.equal(state.requestRenderCount, expectedChunkUpdates + 1);

	const messages = state.children[0]!.messages;
	assert.equal(messages[0]?.content[0]?.thinking, "");
	assert.equal(messages.at(-2)?.content[0]?.thinking, thinking);
	assert.deepEqual(messages.at(-1)?.content, [
		{ type: "thinking", thinking },
		{ type: "text", text },
	]);
});
