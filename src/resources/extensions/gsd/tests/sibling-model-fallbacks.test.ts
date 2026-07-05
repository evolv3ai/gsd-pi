/**
 * Sibling single-model fields honor `fallbacks[]` (#1229).
 *
 * `post_unit_hooks[].model`, `auto_supervisor.model`, and
 * `reactive_execution.subagent_model` accept the same
 * `{ model, provider?, fallbacks? }` object form as `models.<phase>` so a
 * transient provider trip falls back to the next entry instead of hard-failing
 * (and, for a blocking hook, pausing the whole auto-mode run).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  normalizeModelFieldConfig,
  resolveModelWithFallbacksForUnit,
  resolveAutoSupervisorConfig,
} from "../preferences-models.ts";
import { validatePreferences } from "../preferences-validation.ts";

function withPreferences<T>(frontmatter: string[], fn: () => T): T {
  const oldHome = process.env.GSD_HOME;
  const home = mkdtempSync(join(tmpdir(), "gsd-sibling-models-"));
  try {
    process.env.GSD_HOME = home;
    writeFileSync(join(home, "preferences.md"), ["---", ...frontmatter, "---", ""].join("\n"));
    return fn();
  } finally {
    if (oldHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
}

// ─── normalizeModelFieldConfig ───────────────────────────────────────────────

test("normalizeModelFieldConfig: bare string → primary with empty fallbacks", () => {
  assert.deepEqual(normalizeModelFieldConfig("my-model"), { primary: "my-model", fallbacks: [] });
});

test("normalizeModelFieldConfig: object form carries fallbacks", () => {
  assert.deepEqual(
    normalizeModelFieldConfig({ model: "primary", fallbacks: ["fb-1", "fb-2"] }),
    { primary: "primary", fallbacks: ["fb-1", "fb-2"] },
  );
});

test("normalizeModelFieldConfig: provider prefix is prepended to bare model", () => {
  assert.deepEqual(
    normalizeModelFieldConfig({ model: "gpt-5.4", provider: "openai-codex" }),
    { primary: "openai-codex/gpt-5.4", fallbacks: [] },
  );
});

test("normalizeModelFieldConfig: unset / blank / model-less → undefined", () => {
  assert.equal(normalizeModelFieldConfig(undefined), undefined);
  assert.equal(normalizeModelFieldConfig("   "), undefined);
  assert.equal(normalizeModelFieldConfig({ model: "" }), undefined);
});

// ─── post_unit_hooks[].model fallback resolution ─────────────────────────────

test("hook/<name> resolves the hook's object-form model with fallbacks", () => {
  withPreferences(
    [
      "post_unit_hooks:",
      "  - name: plan-review",
      "    after: [plan-slice]",
      "    prompt: review the plan",
      "    model:",
      "      model: primary-model",
      "      fallbacks:",
      "        - fallback-a",
      "        - fallback-b",
    ],
    () => {
      const resolved = resolveModelWithFallbacksForUnit("hook/plan-review");
      assert.deepEqual(resolved, { primary: "primary-model", fallbacks: ["fallback-a", "fallback-b"] });
    },
  );
});

test("hook/<name> still resolves the legacy bare-string model form", () => {
  withPreferences(
    [
      "post_unit_hooks:",
      "  - name: plan-review",
      "    after: [plan-slice]",
      "    prompt: review the plan",
      "    model: solo-model",
    ],
    () => {
      assert.deepEqual(
        resolveModelWithFallbacksForUnit("hook/plan-review"),
        { primary: "solo-model", fallbacks: [] },
      );
    },
  );
});

test("hook/<name> resolves undefined when the hook has no model", () => {
  withPreferences(
    [
      "post_unit_hooks:",
      "  - name: plan-review",
      "    after: [plan-slice]",
      "    prompt: review the plan",
    ],
    () => {
      assert.equal(resolveModelWithFallbacksForUnit("hook/plan-review"), undefined);
      assert.equal(resolveModelWithFallbacksForUnit("hook/unknown-hook"), undefined);
    },
  );
});

// ─── auto_supervisor.model ───────────────────────────────────────────────────

test("auto_supervisor.model object form resolves with fallbacks", () => {
  withPreferences(
    [
      "auto_supervisor:",
      "  model:",
      "    model: supervisor-primary",
      "    fallbacks: [supervisor-fb]",
    ],
    () => {
      assert.deepEqual(resolveModelWithFallbacksForUnit("supervisor"), {
        primary: "supervisor-primary",
        fallbacks: ["supervisor-fb"],
      });
      const supervisor = resolveAutoSupervisorConfig();
      assert.equal(supervisor.model, "supervisor-primary");
      assert.deepEqual(supervisor.modelFallbacks, ["supervisor-fb"]);
    },
  );
});

// ─── validation accepts the object form ──────────────────────────────────────

test("validatePreferences accepts object-form hook and subagent models", () => {
  const { preferences: validated, errors } = validatePreferences({
    post_unit_hooks: [
      {
        name: "plan-review",
        after: ["plan-slice"],
        prompt: "review",
        model: { model: "primary", fallbacks: ["fb-1"] },
      },
    ],
    reactive_execution: {
      enabled: true,
      subagent_model: { model: "sub-primary", fallbacks: ["sub-fb"] },
    },
  } as never);

  assert.deepEqual(errors, []);
  assert.deepEqual(validated.post_unit_hooks?.[0].model, { model: "primary", fallbacks: ["fb-1"] });
  assert.deepEqual(validated.reactive_execution?.subagent_model, { model: "sub-primary", fallbacks: ["sub-fb"] });
});

test("validatePreferences rejects a model-less object form", () => {
  const { errors } = validatePreferences({
    post_unit_hooks: [
      { name: "plan-review", after: ["plan-slice"], prompt: "review", model: { fallbacks: ["fb"] } },
    ],
  } as never);
  assert.ok(errors.some((e) => e.includes('requires a non-empty "model"')));
});

test("validatePreferences accepts object-form auto_supervisor.model", () => {
  const { preferences: validated, errors } = validatePreferences({
    auto_supervisor: { model: { model: "sup-primary", fallbacks: ["sup-fb"] } },
  } as never);
  assert.deepEqual(errors, []);
  assert.deepEqual(validated.auto_supervisor?.model, { model: "sup-primary", fallbacks: ["sup-fb"] });
});

test("validatePreferences rejects a model-less auto_supervisor.model object", () => {
  const { errors } = validatePreferences({
    auto_supervisor: { model: { fallbacks: ["sup-fb"] } },
  } as never);
  assert.ok(
    errors.some((e) => e.includes("auto_supervisor.model") && e.includes('requires a non-empty "model"')),
    `expected supervisor model error, got: ${JSON.stringify(errors)}`,
  );
});
