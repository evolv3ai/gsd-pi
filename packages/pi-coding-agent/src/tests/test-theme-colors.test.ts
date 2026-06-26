import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build, type Plugin } from "esbuild";

type RunResult = {
	logs: string[];
	errors: string[];
};

const root = process.cwd();

async function runThemeColorScript(args: string[]): Promise<RunResult> {
	const cacheDir = join(root, ".cache");
	await mkdir(cacheDir, { recursive: true });
	const outdir = await mkdtemp(join(cacheDir, "pi-coding-agent-theme-colors-"));
	const outfile = join(outdir, "entry.mjs");
	const plugin: Plugin = {
		name: "theme-colors-stub",
		setup(buildApi) {
			buildApi.onResolve({ filter: /^\.\.\/src\/modes\/interactive\/theme\/theme\.ts$/ }, (resolveArgs) => ({
				path: resolveArgs.path,
				namespace: "theme-colors-stub",
			}));
			buildApi.onLoad({ filter: /.*/, namespace: "theme-colors-stub" }, () => ({
				contents: `
					export function initTheme(name) { globalThis.__themeColorInit = name; }
					export const theme = {
						getFgAnsi() { return "\\x1b[38;2;0;0;0m"; },
						fg(name, value) { return "[" + name + "]" + value; },
						bg(name, value) { return "[" + name + "]" + value; },
					};
				`,
				loader: "js",
				resolveDir: root,
			}));
		},
	};
	await build({
		entryPoints: [join(root, "packages/pi-coding-agent/test/test-theme-colors.ts")],
		outfile,
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node22",
		plugins: [plugin],
	});

	const logs: string[] = [];
	const errors: string[] = [];
	const originalArgv = process.argv;
	const originalLog = console.log;
	const originalError = console.error;
	process.argv = [process.argv[0]!, process.argv[1]!, ...args];
	console.log = (...values: unknown[]) => {
		logs.push(values.map(String).join(" "));
	};
	console.error = (...values: unknown[]) => {
		errors.push(values.map(String).join(" "));
	};
	try {
		await import(pathToFileURL(outfile).href);
		return { logs, errors };
	} finally {
		process.argv = originalArgv;
		console.log = originalLog;
		console.error = originalError;
	}
}

test("theme color helper prints usage, contrast, file, and built-in theme reports", async () => {
	const usage = await runThemeColorScript([]);
	assert.match(usage.logs.join("\n"), /Usage:/);
	assert.match(usage.logs.join("\n"), /contrast 4\.5/);

	const contrast = await runThemeColorScript(["contrast", "4.5"]);
	assert.match(contrast.logs.join("\n"), /Colors adjusted to 4\.5:1 contrast/);
	assert.match(contrast.logs.join("\n"), /For LIGHT theme/);
	assert.match(contrast.logs.join("\n"), /teal/);

	const fixtureDir = await mkdtemp(join(root, ".cache", "theme-color-fixture-"));
	const fixturePath = join(fixtureDir, "colors.json");
	await writeFile(fixturePath, JSON.stringify({ vars: { brand: "#336699", ignored: "transparent" } }));
	const fileReport = await runThemeColorScript(["test", fixturePath]);
	assert.ok(fileReport.logs.join("\n").includes(`Testing ${fixturePath}`), `Expected output to include "Testing ${fixturePath}"`);
	assert.match(fileReport.logs.join("\n"), /brand/);
	assert.doesNotMatch(fileReport.logs.join("\n"), /ignored/);

	const dark = await runThemeColorScript(["dark"]);
	const darkOutput = dark.logs.join("\n");
	assert.match(darkOutput, /=== dark theme \(WCAG AA = 4\.5:1\) ===/);
	assert.match(darkOutput, /--- Core UI ---/);
	assert.match(darkOutput, /userMessageBg:/);
	assert.deepEqual(dark.errors, []);
});
