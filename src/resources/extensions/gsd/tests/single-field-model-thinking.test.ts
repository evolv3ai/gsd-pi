/**
 * Regression tests for #1269 — the object model form's `thinking` sub-field on
 * the three single-model fields (`post_unit_hooks[].model`,
 * `auto_supervisor.model`, and `reactive_execution.subagent_model`) was
 * silently dropped after validation/normalization, so a configured
 * hook/supervisor/subagent reasoning level never applied.
 *
 * These exercise the real preference pipeline through the exported runtime APIs:
 *   sanitize   → validatePreferences
 *   normalize  → normalizeModelFieldConfig
 *   resolve    → resolveThinkingLevelForUnit  (supervisor + hook/* early path)
 *
 * The `supervisor` and `hook/*` unit types have no phase-bucket chain, so the
 * pre-#1269 resolver walk never covered them and returned `undefined`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { validatePreferences } from "../preferences-validation.ts";
import { normalizeModelFieldConfig, resolveThinkingLevelForUnit } from "../preferences-models.ts";
import { invalidateAllCaches } from "../cache.ts";

/** Read the per-field `thinking` off a validated/normalized model config. */
function thinkingOf(model: unknown): string | undefined {
  return (model as { thinking?: string } | undefined)?.thinking;
}

/** Write a project-level `.gsd/PREFERENCES.md` and run `fn` with its basePath. */
function withProjectPreferences<T>(frontmatter: string, fn: (basePath: string) => T): T {
  const base = mkdtempSync(join(tmpdir(), "gsd-1269-thinking-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(join(base, ".gsd", "PREFERENCES.md"), `---\n${frontmatter}\n---\n`, "utf-8");
  invalidateAllCaches();
  try {
    return fn(base);
  } finally {
    invalidateAllCaches();
    rmSync(base, { recursive: true, force: true });
  }
}

// ── sanitize: validatePreferences preserves a valid object-form thinking ──────

test("validatePreferences preserves auto_supervisor.model object-form thinking", () => {
  const { preferences, errors } = validatePreferences({
    auto_supervisor: { model: { model: "supervisor-model", thinking: "high" } },
  });
  assert.equal(errors.length, 0);
  assert.equal(thinkingOf(preferences.auto_supervisor?.model), "high");
});

test("validatePreferences preserves post_unit_hooks[].model object-form thinking", () => {
  const { preferences, errors } = validatePreferences({
    post_unit_hooks: [
      {
        name: "code-review",
        after: ["execute-task"],
        prompt: "Review the diff",
        model: { model: "hook-model", thinking: "low" },
      },
    ],
  });
  assert.equal(errors.length, 0);
  assert.equal(thinkingOf(preferences.post_unit_hooks?.[0]?.model), "low");
});

test("validatePreferences preserves reactive_execution.subagent_model object-form thinking", () => {
  const { preferences, errors } = validatePreferences({
    reactive_execution: {
      enabled: true,
      max_parallel: 2,
      isolation_mode: "same-tree",
      subagent_model: { model: "subagent-model", thinking: "medium" },
    },
  });
  assert.equal(errors.length, 0);
  assert.equal(thinkingOf(preferences.reactive_execution?.subagent_model), "medium");
});

// ── sanitize: an invalid thinking level is warned and stripped ────────────────

test("validatePreferences warns and strips an invalid object-form thinking level", () => {
  const { preferences, errors, warnings } = validatePreferences({
    auto_supervisor: { model: { model: "supervisor-model", thinking: "ludicrous" } },
  } as never);
  // The model survives; only the bogus thinking is dropped, so a typo can never
  // reach the resolver and masquerade as explicit configuration.
  assert.equal(errors.length, 0);
  assert.equal(thinkingOf(preferences.auto_supervisor?.model), undefined);
  assert.ok(
    warnings.some((w) => w.includes("auto_supervisor.model") && w.includes("thinking")),
    `expected a thinking warning, got: ${JSON.stringify(warnings)}`,
  );
});

// ── normalize: normalizeModelFieldConfig carries thinking through ─────────────

test("normalizeModelFieldConfig carries object-form thinking through", () => {
  const config = normalizeModelFieldConfig({ model: "hook-model", thinking: "xhigh" });
  assert.equal(config?.primary, "hook-model");
  assert.equal(config?.thinking, "xhigh");
});

test("normalizeModelFieldConfig leaves thinking absent when omitted", () => {
  const fromObject = normalizeModelFieldConfig({ model: "hook-model" });
  assert.equal(fromObject?.primary, "hook-model");
  assert.equal(fromObject?.thinking, undefined);

  const fromString = normalizeModelFieldConfig("hook-model");
  assert.equal(fromString?.primary, "hook-model");
  assert.equal(fromString?.thinking, undefined);
});

// ── resolve: the single-field unit types surface their per-field thinking ──────

test("resolveThinkingLevelForUnit('supervisor') returns auto_supervisor.model thinking", () => {
  withProjectPreferences(
    ["auto_supervisor:", "  model:", "    model: supervisor-model", "    thinking: high"].join("\n"),
    (base) => {
      assert.equal(resolveThinkingLevelForUnit("supervisor", base), "high");
    },
  );
});

test("resolveThinkingLevelForUnit('hook/<name>') returns the matching hook model thinking", () => {
  withProjectPreferences(
    [
      "post_unit_hooks:",
      "  - name: code-review",
      "    after:",
      "      - execute-task",
      "    prompt: Review the diff",
      "    model:",
      "      model: hook-model",
      "      thinking: low",
    ].join("\n"),
    (base) => {
      assert.equal(resolveThinkingLevelForUnit("hook/code-review", base), "low");
    },
  );
});

test("resolveThinkingLevelForUnit('supervisor') stays undefined when thinking is omitted", () => {
  // Bare-string model form carries no thinking → dispatch falls back to the
  // session/floor level, unchanged from pre-#1269 behavior.
  withProjectPreferences(
    ["auto_supervisor:", "  model: supervisor-model"].join("\n"),
    (base) => {
      assert.equal(resolveThinkingLevelForUnit("supervisor", base), undefined);
    },
  );
});
