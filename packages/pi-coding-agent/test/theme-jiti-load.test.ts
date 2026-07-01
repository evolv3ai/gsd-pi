import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { createJiti } from "@mariozechner/jiti";

/**
 * Extensions load pi-coding-agent through jiti with @sinclair/typebox aliased to
 * typebox 1.x. theme.ts must compile ThemeJsonSchema with typebox/compile, not
 * @sinclair/typebox/compiler, or every extension that value-imports the barrel
 * fails at load with TypeCompilerTypeGuardError.
 */
test("theme module loads through jiti typebox aliases", async () => {
	const require = createRequire(import.meta.url);
	const packageRoot = path.resolve(import.meta.dirname, "..");
	const typeboxEntry = require.resolve("typebox");
	const typeboxCompileEntry = require.resolve("typebox/compile");
	const typeboxValueEntry = require.resolve("typebox/value");
	const sinclairTypeboxCompilerEntry = require.resolve("@sinclair/typebox/compiler");
	const piCodingAgentEntry = path.join(packageRoot, "src", "index.ts");

	const jiti = createJiti(import.meta.url, {
		alias: {
			"@gsd/pi-coding-agent": piCodingAgentEntry,
			typebox: typeboxEntry,
			"typebox/compile": typeboxCompileEntry,
			"typebox/value": typeboxValueEntry,
			"@sinclair/typebox": typeboxEntry,
			"@sinclair/typebox/compile": typeboxCompileEntry,
			"@sinclair/typebox/compiler": sinclairTypeboxCompilerEntry,
			"@sinclair/typebox/value": typeboxValueEntry,
		},
	});

	const themeModule = (await jiti.import(path.join(packageRoot, "src", "theme", "theme.ts"))) as {
		initTheme: (name?: string) => void;
	};

	assert.equal(typeof themeModule.initTheme, "function");
	themeModule.initTheme("dark");

	// Value-importing the pi-coding-agent barrel must not throw during extension load.
	const barrel = (await jiti.import(piCodingAgentEntry)) as { getMarkdownTheme: () => unknown };
	assert.equal(typeof barrel.getMarkdownTheme, "function");
	barrel.getMarkdownTheme();
});
