/**
 * tool-schema-model-fallback.test.ts — Regression test for #813.
 *
 * Auto mode aborted with "Schema overload: consecutive tool validation
 * failures exceeded cap" instead of recovering. The tool-schema handler now
 * attempts the unit's configured fallbacks and the auto-mode start model (the
 * model the user actually selected) before hard-pausing, mirroring the
 * model-error path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyError } from "../error-classifier.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RECOVERY_PATH = join(__dirname, "..", "bootstrap", "agent-end-recovery.ts");

function getRecoverySource(): string {
  return readFileSync(RECOVERY_PATH, "utf-8");
}

test("schema overload classifies as tool-schema (#813)", () => {
  const cls = classifyError(
    "Schema overload: consecutive tool validation failures exceeded cap",
  );
  assert.equal(cls.kind, "tool-schema");
});

test("tool-schema handler attempts model fallback before pausing (#813)", () => {
  const src = getRecoverySource();

  // Isolate the tool-schema branch body.
  const branchStart = src.indexOf('if (cls.kind === "tool-schema")');
  assert.ok(branchStart !== -1, "tool-schema branch must exist");
  const branch = src.slice(branchStart, branchStart + 1200);

  assert.ok(
    branch.includes("tryProviderModelFallback"),
    "tool-schema branch must attempt tryProviderModelFallback before pausing (#813)",
  );
  // Fallback success must short-circuit the pause so auto-mode continues.
  assert.ok(
    /if\s*\(switched\)\s*return;/.test(branch),
    "tool-schema branch must return early when a fallback model is switched in (#813)",
  );
});

test("tool-schema handler still pauses when no fallback succeeds (#813)", () => {
  const src = getRecoverySource();

  const branchStart = src.indexOf('if (cls.kind === "tool-schema")');
  const branch = src.slice(branchStart, branchStart + 1200);

  // The terminal pause must still classify as a tool-schema pause, not a
  // generic provider pause.
  assert.ok(
    /category:\s*"tool-schema"/.test(branch),
    "tool-schema branch must retain its tool-schema pause category when fallback fails (#813)",
  );
});
