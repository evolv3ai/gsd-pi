import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMatrix, strictMatrixFailures } from "../lib/test-audit-lib.mjs";

test("audit:test-matrix strict passes after P0 extension backfill", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["scripts/audit-test-matrix.mjs", "--strict"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || "matrix strict failed");
});

test("audit:test-matrix counts reachable suite tests as indirect source coverage", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-test-matrix-"));
  mkdirSync(join(root, "src/tests"), { recursive: true });
  writeFileSync(join(root, "src/feature.ts"), "export const feature = true;\n");
  writeFileSync(
    join(root, "src/tests/feature-flow.test.ts"),
    "import test from 'node:test';\ntest('feature flow', () => {});\n",
  );

  const matrix = buildMatrix(root);
  assert.equal(matrix.summary.untested, 0);
  assert.equal(matrix.summary.criticalUntested, 0);
  assert.equal(matrix.summary.highUntested, 0);
  assert.deepEqual(matrix.rows.map((row) => row.status), ["indirect"]);
});

test("audit:test-matrix json reports no untested source files for current coverage branch", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["scripts/audit-test-matrix.mjs", "--json"], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout || "matrix json failed");

  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.untested, 0);
  assert.equal(report.summary.criticalUntested, 0);
  assert.equal(report.summary.highUntested, 0);
  assert.equal(report.unwiredTests.length, 0);
  assert.equal(report.unreachableTests.length, 0);
});

test("audit:test-matrix strict fails when literal matrix counts are nonzero", () => {
  assert.deepEqual(
    strictMatrixFailures({
      summary: {
        untested: 2,
        criticalUntested: 1,
        highUntested: 1,
        unwired: 1,
      },
      unwiredTests: ["src/resources/extensions/example/tests/example.test.ts"],
      unreachableTests: ["tests/live/example.test.ts"],
      rows: [],
    }),
    [
      "2 untested source file(s)",
      "1 critical untested source file(s)",
      "1 high untested source file(s)",
      "1 source file(s) mapped only to unwired tests",
      "1 unwired test file(s)",
      "1 unreachable test file(s)",
    ],
  );
});
