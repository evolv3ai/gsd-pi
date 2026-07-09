import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMigrationPlan, splitValidationIssues } from "../migrate/plan.ts";
import type { ValidationResult } from "../migrate/types.ts";

function makeBase(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function write(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

test("splitValidationIssues separates warnings from fatals without dropping issue order", () => {
  const validation: ValidationResult = {
    valid: false,
    issues: [
      { file: "ROADMAP.md", severity: "warning", message: "missing roadmap" },
      { file: ".planning", severity: "fatal", message: "missing directory" },
      { file: "PROJECT.md", severity: "warning", message: "missing project" },
    ],
  };

  assert.deepEqual(splitValidationIssues(validation), {
    warnings: [
      { file: "ROADMAP.md", severity: "warning", message: "missing roadmap" },
      { file: "PROJECT.md", severity: "warning", message: "missing project" },
    ],
    fatals: [
      { file: ".planning", severity: "fatal", message: "missing directory" },
    ],
  });
});

test("createMigrationPlan reports a missing .planning source without parsing", async () => {
  const base = makeBase("gsd-migrate-plan-missing-");
  try {
    const result = await createMigrationPlan(base);

    assert.equal(result.status, "missing-source");
    assert.equal(result.sourcePath, join(base, ".planning"));
    assert.equal(result.targetRoot, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("createMigrationPlan reports zero-slice migrations as blocked after validation", async () => {
  const base = makeBase("gsd-migrate-plan-blocked-");
  try {
    mkdirSync(join(base, ".planning"), { recursive: true });
    write(join(base, ".planning", "PROJECT.md"), "# Legacy Project\n");

    const result = await createMigrationPlan(base);

    assert.equal(result.status, "blocked");
    assert.match(result.message, /zero slices/);
    assert.equal(result.validation.valid, true);
    assert.ok(result.warnings.some((issue) => issue.file === "ROADMAP.md"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
