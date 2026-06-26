import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build, type Plugin } from "esbuild";

type RuntimeState = {
	children: Array<{ render(width: number): string[] }>;
	requestRenderCount: number;
	started: boolean;
	stopped: boolean;
};

const root = process.cwd();

async function importViewportRepro(): Promise<RuntimeState> {
	const cacheDir = join(root, ".cache");
	await mkdir(cacheDir, { recursive: true });
	const outdir = await mkdtemp(join(cacheDir, "pi-tui-viewport-repro-"));
	const outfile = join(outdir, "entry.mjs");
	const plugin: Plugin = {
		name: "viewport-repro-stubs",
		setup(buildApi) {
			buildApi.onResolve({ filter: /^\.\.\/src\/(?:terminal|tui)\.ts$/ }, (args) => ({
				path: args.path,
				namespace: "viewport-repro-stub",
			}));
			buildApi.onLoad({ filter: /.*/, namespace: "viewport-repro-stub" }, (args) => {
				const stubs: Record<string, string> = {
					"../src/terminal.ts": `
						export class ProcessTerminal {
							constructor() { this.rows = 4; }
						}
					`,
					"../src/tui.ts": `
						globalThis.__viewportReproState = { children: [], requestRenderCount: 0, started: false, stopped: false };
						export class TUI {
							constructor(terminal) {
								this.terminal = terminal;
								this.children = globalThis.__viewportReproState.children;
							}
							addChild(child) { this.children.push(child); }
							requestRender() { globalThis.__viewportReproState.requestRenderCount += 1; }
							start() { globalThis.__viewportReproState.started = true; }
							stop() { globalThis.__viewportReproState.stopped = true; }
						}
					`,
				};
				return { contents: stubs[args.path], loader: "js", resolveDir: root };
			});
		},
	};
	await build({
		entryPoints: [join(root, "packages/pi-tui/test/viewport-overwrite-repro.ts")],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		plugins: [plugin],
	});
	await import(pathToFileURL(outfile).href);
	for (let i = 0; i < 80; i += 1) await Promise.resolve();
	return (globalThis as typeof globalThis & { __viewportReproState: RuntimeState }).__viewportReproState;
}

test("viewport repro streams every phase into the buffer and stops the TUI", async () => {
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((callback: () => void) => {
		callback();
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	try {
		const state = await importViewportRepro();
		assert.equal(state.started, true);
		assert.equal(state.stopped, true);
		assert.equal(state.requestRenderCount, 37);
		assert.equal(state.children.length, 1);

		const output = state.children[0]!.render(40).join("\n");
		assert.match(output, /TUI viewport overwrite repro/);
		assert.match(output, /Viewport rows detected: 4/);
		assert.match(output, /PRE-TOOL LINE 12/);
		assert.match(output, /TOOL OUT 16/);
		assert.match(output, /POST-TOOL LINE 06/);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
});
