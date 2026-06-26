import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build, type Plugin } from "esbuild";

type MarkedState = {
	configured?: unknown;
};

const root = process.cwd();

async function importHelper(): Promise<{ loadVendoredMarked(): { configured?: boolean; parse(text: string): string } }> {
	const cacheDir = join(root, ".cache");
	await mkdir(cacheDir, { recursive: true });
	const outdir = await mkdtemp(join(cacheDir, "pi-coding-agent-vendored-marked-"));
	const outfile = join(outdir, "entry.mjs");
	const plugin: Plugin = {
		name: "vendored-marked-stubs",
		setup(buildApi) {
			buildApi.onResolve({ filter: /^(marked|\.\.\/\.\.\/src\/core\/export-html\/safe-marked\.ts)$/ }, (args) => ({
				path: args.path,
				namespace: "vendored-marked-stub",
			}));
			buildApi.onLoad({ filter: /.*/, namespace: "vendored-marked-stub" }, (args) => {
				const stubs: Record<string, string> = {
					marked: `
						export class Marked {
							use(config) { this.config = config; }
							parse(text) { return this.configured ? "<p>" + text + "</p>" : text; }
						}
					`,
					"../../src/core/export-html/safe-marked.ts": `
						export function configureSafeMarked(marked) {
							marked.configured = true;
							globalThis.__markedState = { configured: marked };
						}
					`,
				};
				return { contents: stubs[args.path], loader: "js", resolveDir: root };
			});
		},
	};
	await build({
		entryPoints: [join(root, "packages/pi-coding-agent/test/helpers/load-vendored-marked.ts")],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		plugins: [plugin],
	});
	return import(pathToFileURL(outfile).href);
}

test("loadVendoredMarked creates a marked instance with export sanitizers configured", async () => {
	const { loadVendoredMarked } = await importHelper();
	const marked = loadVendoredMarked();
	const state = (globalThis as typeof globalThis & { __markedState?: MarkedState }).__markedState;
	assert.equal(marked.configured, true);
	assert.equal(state?.configured, marked);
	assert.equal(marked.parse("hello"), "<p>hello</p>");
});
