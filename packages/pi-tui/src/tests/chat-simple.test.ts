import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build, type Plugin } from "esbuild";

type StubEditor = {
	disableSubmit: boolean;
	onSubmit?: (value: string) => void;
	provider?: { commands: Array<{ name: string; description: string }>; cwd: string };
	setAutocompleteProvider(provider: StubEditor["provider"]): void;
};

type RuntimeState = {
	children: Array<{ kind: string; text?: string } | StubEditor>;
	focus?: StubEditor;
	requestRenderCount: number;
	started: boolean;
};

const root = process.cwd();

async function importChatSimple(): Promise<RuntimeState> {
	const cacheDir = join(root, ".cache");
	await mkdir(cacheDir, { recursive: true });
	const outdir = await mkdtemp(join(cacheDir, "pi-tui-chat-simple-"));
	const outfile = join(outdir, "entry.mjs");
	const plugin: Plugin = {
		name: "chat-simple-stubs",
		setup(buildApi) {
			buildApi.onResolve(
				{
					filter:
						/^(chalk|\.\.\/src\/(?:autocomplete|terminal|tui)\.ts|\.\.\/src\/components\/(?:editor|loader|markdown|text)\.ts|\.\/test-themes\.ts)$/,
				},
				(args) => ({ path: args.path, namespace: "chat-simple-stub" }),
			);
			buildApi.onLoad({ filter: /.*/, namespace: "chat-simple-stub" }, (args) => {
				const stubs: Record<string, string> = {
					chalk: `
						export default {
							cyan(value) { return value; },
							dim(value) { return value; },
						};
					`,
					"../src/autocomplete.ts": `
						export class CombinedAutocompleteProvider {
							constructor(commands, cwd) { this.commands = commands; this.cwd = cwd; }
						}
					`,
					"../src/components/editor.ts": `
						export class Editor {
							constructor(tui, theme) {
								this.kind = "editor";
								this.tui = tui;
								this.theme = theme;
								this.disableSubmit = false;
							}
							setAutocompleteProvider(provider) { this.provider = provider; }
						}
					`,
					"../src/components/loader.ts": `
						export class Loader {
							constructor(tui, color, dim, text) {
								this.kind = "loader";
								this.tui = tui;
								this.text = text;
							}
						}
					`,
					"../src/components/markdown.ts": `
						export class Markdown {
							constructor(text, x, y, theme) {
								this.kind = "markdown";
								this.text = text;
								this.x = x;
								this.y = y;
								this.theme = theme;
							}
						}
					`,
					"../src/components/text.ts": `
						export class Text {
							constructor(text) {
								this.kind = "text";
								this.text = text;
							}
						}
					`,
					"../src/terminal.ts": `
						export class ProcessTerminal {}
					`,
					"../src/tui.ts": `
						globalThis.__chatSimpleState = { children: [], requestRenderCount: 0, started: false };
						export class TUI {
							constructor(terminal) {
								this.terminal = terminal;
								this.children = globalThis.__chatSimpleState.children;
							}
							addChild(child) { this.children.push(child); }
							removeChild(child) {
								const index = this.children.indexOf(child);
								if (index >= 0) this.children.splice(index, 1);
							}
							setFocus(child) { globalThis.__chatSimpleState.focus = child; }
							requestRender() { globalThis.__chatSimpleState.requestRenderCount += 1; }
							start() { globalThis.__chatSimpleState.started = true; }
						}
					`,
					"./test-themes.ts": `
						export const defaultEditorTheme = { name: "editor" };
						export const defaultMarkdownTheme = { name: "markdown" };
					`,
				};
				return { contents: stubs[args.path], loader: "js", resolveDir: root };
			});
		},
	};
	await build({
		entryPoints: [join(root, "packages/pi-tui/test/chat-simple.ts")],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		plugins: [plugin],
	});
	await import(pathToFileURL(outfile).href);
	return (globalThis as typeof globalThis & { __chatSimpleState: RuntimeState }).__chatSimpleState;
}

test("simple chat starts with command autocomplete and renders a response cycle", async () => {
	const originalSetTimeout = globalThis.setTimeout;
	const originalRandom = Math.random;
	const timers: Array<() => void> = [];
	globalThis.setTimeout = ((callback: () => void) => {
		timers.push(callback);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	Math.random = () => 0;
	try {
		const state = await importChatSimple();
		assert.equal(state.started, true);
		assert.match(String(state.children[0]?.text), /Welcome to Simple Chat!/);

		const editor = state.focus!;
		assert.equal(editor, state.children.at(-1));
		assert.deepEqual(
			editor.provider?.commands.map((command) => command.name),
			["delete", "clear"],
		);

		editor.onSubmit?.("hello there");
		assert.equal(editor.disableSubmit, true);
		assert.equal(state.requestRenderCount, 1);
		assert.equal(state.children.at(-3)?.text, "hello there");
		assert.equal(state.children.at(-2)?.text, "Thinking...");

		timers.shift()?.();
		assert.equal(editor.disableSubmit, false);
		assert.equal(state.requestRenderCount, 2);
		assert.equal(state.children.at(-2)?.text, "That's interesting! Tell me more.");
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		Math.random = originalRandom;
	}
});
