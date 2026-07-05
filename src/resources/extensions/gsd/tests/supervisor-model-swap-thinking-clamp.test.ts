/**
 * Supervisor model swap reclamps the reasoning level (#1229 follow-up).
 *
 * Hook overrides in `unit-phase.ts` reapply `applyThinkingLevelForModel` after a
 * model swap so the session's reasoning effort is re-clamped to what the newly
 * selected model supports (ADR-026). `applySupervisorModelIfConfigured` swaps
 * the session model for supervisor interventions (wrap-up, context-budget,
 * timeout recovery) and must do the same — otherwise a level that was valid for
 * the prior model can reach the provider on the steered turn.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { applySupervisorModelIfConfigured } from "../auto-model-selection.ts";
import { clearGSDPreferencesCache } from "../preferences.ts";

const SUPERVISOR_PREFS = [
  "auto_supervisor:",
  "  model:",
  "    model: supervisor-primary",
  "    fallbacks: [supervisor-fb]",
];

interface Harness {
  home: string;
  base: string;
  ctx: any;
  pi: any;
  setModelCalls: unknown[][];
  setThinkingCalls: unknown[];
  order: string[];
}

function makeHarness(): Harness {
  const home = mkdtempSync(join(tmpdir(), "gsd-supervisor-clamp-home-"));
  const base = mkdtempSync(join(tmpdir(), "gsd-supervisor-clamp-base-"));
  process.env.GSD_HOME = home;
  writeFileSync(join(home, "preferences.md"), ["---", ...SUPERVISOR_PREFS, "---", ""].join("\n"));
  clearGSDPreferencesCache();

  const setModelCalls: unknown[][] = [];
  const setThinkingCalls: unknown[] = [];
  const order: string[] = [];

  const ctx = {
    ui: { notify: () => {} },
    model: { provider: "anthropic" },
    modelRegistry: {
      getAvailable: () => [
        { id: "supervisor-primary", provider: "anthropic" },
        { id: "supervisor-fb", provider: "anthropic" },
      ],
    },
  } as any;

  const pi = {
    setModel: async (...args: unknown[]) => {
      setModelCalls.push(args);
      order.push("setModel");
      return true;
    },
    getThinkingLevel: () => "high",
    setThinkingLevel: (level: unknown) => {
      setThinkingCalls.push(level);
      order.push("setThinkingLevel");
    },
  } as any;

  return { home, base, ctx, pi, setModelCalls, setThinkingCalls, order };
}

function cleanup(h: Harness): void {
  clearGSDPreferencesCache();
  delete process.env.GSD_HOME;
  rmSync(h.home, { recursive: true, force: true });
  rmSync(h.base, { recursive: true, force: true });
}

test("supervisor swap reapplies the thinking level after selecting the model", async () => {
  const h = makeHarness();
  try {
    await applySupervisorModelIfConfigured(h.ctx, h.pi, h.base);

    assert.equal(h.setModelCalls.length, 1, "model swaps to the supervisor model");
    assert.deepEqual(
      h.setModelCalls[0][0],
      { id: "supervisor-primary", provider: "anthropic" },
      "swaps to the configured supervisor primary",
    );
    assert.equal(
      h.setThinkingCalls.length,
      1,
      "thinking level is reclamped exactly once after the swap",
    );
    assert.deepEqual(
      h.order,
      ["setModel", "setThinkingLevel"],
      "reclamp happens after setModel, matching the hook-override pattern",
    );
  } finally {
    cleanup(h);
  }
});

test("supervisor swap does not touch the thinking level when no model is configured", async () => {
  const h = makeHarness();
  // Overwrite prefs with no auto_supervisor.model.
  writeFileSync(join(h.home, "preferences.md"), ["---", "auto_supervisor:", "  soft_timeout_minutes: 1", "---", ""].join("\n"));
  clearGSDPreferencesCache();
  try {
    await applySupervisorModelIfConfigured(h.ctx, h.pi, h.base);

    assert.equal(h.setModelCalls.length, 0, "no swap without a configured supervisor model");
    assert.equal(h.setThinkingCalls.length, 0, "thinking level untouched when nothing swaps");
  } finally {
    cleanup(h);
  }
});
