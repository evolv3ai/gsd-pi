// Project/App: gsd-pi
// File Purpose: Guard the vendored pkg/dist export-html assets against drifting from their source.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

function findRepoRoot(start: string): string {
	let dir = start;
	for (let i = 0; i < 10; i++) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			if (pkg.name === "@opengsd/gsd-pi" && existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
		} catch {
			// Keep walking.
		}
		const parent = resolve(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(`Could not locate repo root from ${start}`);
}

const projectRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

// These assets are plain files copied verbatim by the build: gsd-agent-core's build
// stages them into packages/gsd-agent-core/dist/export-html, and
// scripts/copy-export-html.cjs copies that directory over pkg/dist/core/export-html.
// The pkg/dist copies are force-added to git, so a source edit that skips the
// regen step leaves the shipped template stale (#1107 → PR #1218).
// pkg/dist/core/export-html/vendor/* is third-party (not built from src), so it
// has no source counterpart to compare against.
const VERBATIM_ASSETS = ["template.js", "template.css", "template.html"];

for (const asset of VERBATIM_ASSETS) {
	test(`vendored pkg/dist export-html ${asset} matches its packages/gsd-agent-core source`, () => {
		const sourcePath = join(projectRoot, "packages/gsd-agent-core/src/export-html", asset);
		const vendoredPath = join(projectRoot, "pkg/dist/core/export-html", asset);
		// allow-source-grep: parity guardrail intentionally reads source and vendored assets to compare them.
		const source = readFileSync(sourcePath, "utf8");
		const vendored = readFileSync(vendoredPath, "utf8");
		assert.equal(
			vendored,
			source,
			`pkg/dist/core/export-html/${asset} is stale: it no longer matches ` +
				`packages/gsd-agent-core/src/export-html/${asset}. ` +
				`Run \`pnpm run build:core && node scripts/copy-export-html.cjs\` and commit the regenerated copy.`,
		);
	});
}
