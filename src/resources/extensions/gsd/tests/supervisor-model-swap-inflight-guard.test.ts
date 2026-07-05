/**
 * Supervisor model swap honors the in-flight-tool guard (#1229 follow-up).
 *
 * The wrap-up soft-timeout timer gates `triggerTurn` on there being no tools
 * in flight — sending a turn mid-tool-call skips tool results and trips
 * provider errors (#3512). The supervisor model swap
 * (`applySupervisorModelIfConfigured`) must honor the identical guard: swapping
 * the session model while tool calls are still open risks the same provider
 * errors, so it must only run when the timer will actually trigger a turn.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startUnitSupervision, type SupervisionContext } from "../auto-timers.ts";
import { clearGSDPreferencesCache } from "../preferences.ts";
import {
  markToolStart,
  markToolEnd,
  clearInFlightTools,
} from "../auto-tool-tracking.ts";

const SUPERVISOR_PREFS = [
  "auto_supervisor:",
  "  soft_timeout_minutes: 1",
  "  idle_timeout_minutes: 100",
  "  hard_timeout_minutes: 100",
  "  model:",
  "    model: supervisor-primary",
  "    fallbacks: [supervisor-fb]",
];

interface Harness {
  home: string;
  base: string;
  ctx: any;
  pi: any;
  s: any;
  sctx: SupervisionContext;
  setModelCalls: unknown[][];
  sendMessageCalls: unknown[][];
}

function makeHarness(): Harness {
  const home = mkdtempSync(join(tmpdir(), "gsd-supervisor-guard-home-"));
  const base = mkdtempSync(join(tmpdir(), "gsd-supervisor-guard-base-"));
  process.env.GSD_HOME = home;
  writeFileSync(join(home, "preferences.md"), ["---", ...SUPERVISOR_PREFS, "---", ""].join("\n"));
  clearGSDPreferencesCache();

  const setModelCalls: unknown[][] = [];
  const sendMessageCalls: unknown[][] = [];

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
    sendMessage: (...args: unknown[]) => {
      sendMessageCalls.push(args);
    },
    setModel: async (...args: unknown[]) => {
      setModelCalls.push(args);
      return true;
    },
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
  } as any;

  const s = {
    active: true,
    verbose: false,
    basePath: base,
    currentUnit: { type: "task", id: "T01", startedAt: 1234 },
    cmdCtx: undefined,
    wrapupWarningHandle: null,
    idleWatchdogHandle: null,
    unitTimeoutHandle: null,
    continueHereHandle: null,
  } as any;

  const sctx: SupervisionContext = {
    s,
    ctx,
    pi,
    unitType: "task",
    unitId: "T01",
    prefs: undefined,
    buildSnapshotOpts: () => ({}) as any,
    buildRecoveryContext: () => ({}) as any,
    pauseAuto: async () => {},
  };

  return { home, base, ctx, pi, s, sctx, setModelCalls, sendMessageCalls };
}

function cleanup(h: Harness): void {
  clearInFlightTools();
  clearGSDPreferencesCache();
  delete process.env.GSD_HOME;
  rmSync(h.home, { recursive: true, force: true });
  rmSync(h.base, { recursive: true, force: true });
}

/** Neutralize every timer except the soft-timeout wrap-up so only it fires. */
function isolateSoftTimeout(s: any): void {
  if (s.idleWatchdogHandle) clearInterval(s.idleWatchdogHandle);
  if (s.unitTimeoutHandle) clearTimeout(s.unitTimeoutHandle);
  if (s.continueHereHandle) clearInterval(s.continueHereHandle);
}

/** Flush the soft-timeout callback's chained awaits. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

test("soft-timeout skips the supervisor model swap while a tool is in flight", async () => {
  const h = makeHarness();
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  try {
    startUnitSupervision(h.sctx);
    isolateSoftTimeout(h.s);

    // A tool is still executing when the soft timeout fires.
    markToolStart("call-1", true, "some_tool");

    mock.timers.tick(60_000);
    await flush();

    assert.equal(
      h.setModelCalls.length,
      0,
      "model must NOT swap while a tool is in flight",
    );
    assert.equal(h.sendMessageCalls.length, 1, "wrap-up message still sent (queued)");
    const opts = h.sendMessageCalls[0][1] as { triggerTurn?: boolean };
    assert.equal(opts.triggerTurn, false, "turn is not triggered mid-tool-call");

    markToolEnd("call-1");
  } finally {
    mock.timers.reset();
    cleanup(h);
  }
});

test("soft-timeout applies the supervisor model swap when no tools are in flight", async () => {
  const h = makeHarness();
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  try {
    startUnitSupervision(h.sctx);
    isolateSoftTimeout(h.s);

    // No tools in flight — the timer will trigger a turn, so the model swaps.
    mock.timers.tick(60_000);
    await flush();

    assert.equal(h.setModelCalls.length, 1, "model swaps to the supervisor model");
    assert.deepEqual(
      h.setModelCalls[0][0],
      { id: "supervisor-primary", provider: "anthropic" },
      "swaps to the configured supervisor primary",
    );
    assert.equal(h.sendMessageCalls.length, 1);
    const opts = h.sendMessageCalls[0][1] as { triggerTurn?: boolean };
    assert.equal(opts.triggerTurn, true, "turn is triggered when no tools are open");
  } finally {
    mock.timers.reset();
    cleanup(h);
  }
});
