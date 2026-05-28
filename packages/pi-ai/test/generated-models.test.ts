// Project/App: gsd-pi
// File Purpose: Regression tests for generated model catalog output.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

describe("models.generated.ts", () => {
	test("does not include floating-point precision artifacts in cost literals", () => {
		// allow-source-grep: generated catalog is data output; this test guards numeric literal formatting only
		const generated = readFileSync(join(import.meta.dirname, "../src/models.generated.ts"), "utf8");
		const noisyCostLiteral = /^\s+(?:input|output|cacheRead|cacheWrite): \d+\.\d{13,},/m;

		expect(generated).not.toMatch(noisyCostLiteral);
	});
});
