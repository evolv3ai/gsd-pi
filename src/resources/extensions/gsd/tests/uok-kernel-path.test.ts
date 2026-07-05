// Project/App: gsd-pi
// File Purpose: Verifies UOK kernel path selection, legacy fallback telemetry,
// and that a failing telemetry-only audit emit never aborts orchestration.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import { runAutoLoopWithUok } from "../uok/kernel.ts";
import type { AutoSession } from "../auto/session.ts";
import type { LoopDeps } from "../auto/loop-deps.ts";
import { gsdRoot } from "../paths.ts";
import type { GSDPreferences } from "../preferences.ts";
import { getLegacyTelemetry, resetLegacyTelemetry } from "../legacy-telemetry.ts";
import { closeDatabase, openDatabase, _getAdapter } from "../gsd-db.ts";
import { peekLogs, _resetLogs } from "../workflow-logger.ts";

function makeBasePath(): string {
  return mkdtempSync(join(tmpdir(), "gsd-uok-kernel-"));
}

function makeArgs(
  basePath: string,
  preferences: GSDPreferences | undefined,
): {
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  s: AutoSession;
  deps: LoopDeps;
  runKernelLoop: (
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    s: AutoSession,
    deps: LoopDeps,
  ) => Promise<void>;
  runLegacyLoop: (
    ctx: ExtensionContext,
    pi: ExtensionAPI,
    s: AutoSession,
    deps: LoopDeps,
  ) => Promise<void>;
  calls: {
    kernel: number;
    legacy: number;
    kernelDeps: LoopDeps | null;
    legacyDeps: LoopDeps | null;
  };
} {
  const calls = {
    kernel: 0,
    legacy: 0,
    kernelDeps: null as LoopDeps | null,
    legacyDeps: null as LoopDeps | null,
  };

  return {
    ctx: {
      sessionManager: {
        getSessionId: (): string => "session-test",
      },
    } as unknown as ExtensionContext,
    pi: {} as unknown as ExtensionAPI,
    s: {
      basePath,
      autoStartTime: 1,
    } as unknown as AutoSession,
    deps: {
      loadEffectiveGSDPreferences: () => ({ preferences }),
    } as unknown as LoopDeps,
    runKernelLoop: async (_ctx, _pi, _s, loopDeps): Promise<void> => {
      calls.kernel += 1;
      calls.kernelDeps = loopDeps;
    },
    runLegacyLoop: async (_ctx, _pi, _s, loopDeps): Promise<void> => {
      calls.legacy += 1;
      calls.legacyDeps = loopDeps;
    },
    calls,
  };
}

function readParityEvents(basePath: string): Array<Record<string, unknown>> {
  const file = join(gsdRoot(basePath), "runtime", "uok-parity.jsonl");
  const raw = readFileSync(file, "utf-8").trim();
  if (raw.length === 0) return [];
  return raw.split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
}

test("runAutoLoopWithUok uses kernel path by default and records uok-kernel parity", async () => {
  const basePath = makeBasePath();
  try {
    resetLegacyTelemetry();
    const args = makeArgs(basePath, {
      uok: {
        enabled: true,
        audit_unified: { enabled: false },
        gitops: { enabled: false },
      },
    });
    await runAutoLoopWithUok(args);

    assert.equal(args.calls.kernel, 1);
    assert.equal(args.calls.legacy, 0);
    assert.ok(args.calls.kernelDeps);
    assert.notEqual(args.calls.kernelDeps, args.deps);
    assert.ok(args.calls.kernelDeps?.uokObserver);
    assert.equal(process.env.GSD_UOK_AUDIT_UNIFIED, "0");

    const events = readParityEvents(basePath);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.path, "uok-kernel");
    assert.equal(events[0]?.phase, "enter");
    assert.equal(events[1]?.path, "uok-kernel");
    assert.equal(events[1]?.phase, "exit");
    assert.equal(events[1]?.status, "ok");
    assert.equal(getLegacyTelemetry()["legacy.uokFallbackUsed"], 0);
  } finally {
    resetLegacyTelemetry();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("runAutoLoopWithUok uses legacy path when explicit legacy fallback is enabled", async () => {
  const basePath = makeBasePath();
  try {
    resetLegacyTelemetry();
    const args = makeArgs(basePath, {
      uok: {
        enabled: true,
        legacy_fallback: { enabled: true },
      },
    });
    await runAutoLoopWithUok(args);

    assert.equal(args.calls.kernel, 0);
    assert.equal(args.calls.legacy, 1);
    assert.equal(args.calls.legacyDeps, args.deps);

    const events = readParityEvents(basePath);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.path, "legacy-fallback");
    assert.equal(events[1]?.path, "legacy-fallback");
    assert.equal(events[1]?.status, "ok");
    assert.equal(getLegacyTelemetry()["legacy.uokFallbackUsed"], 1);
  } finally {
    resetLegacyTelemetry();
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("runAutoLoopWithUok respects GSD_UOK_FORCE_LEGACY emergency switch", async () => {
  const basePath = makeBasePath();
  const previous = process.env.GSD_UOK_FORCE_LEGACY;
  process.env.GSD_UOK_FORCE_LEGACY = "1";
  try {
    resetLegacyTelemetry();
    const args = makeArgs(basePath, {
      uok: {
        enabled: true,
      },
    });
    await runAutoLoopWithUok(args);

    assert.equal(args.calls.kernel, 0);
    assert.equal(args.calls.legacy, 1);

    const events = readParityEvents(basePath);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.path, "legacy-fallback");
    assert.equal(events[1]?.path, "legacy-fallback");
    assert.equal(getLegacyTelemetry()["legacy.uokFallbackUsed"], 1);
  } finally {
    resetLegacyTelemetry();
    if (previous === undefined) delete process.env.GSD_UOK_FORCE_LEGACY;
    else process.env.GSD_UOK_FORCE_LEGACY = previous;
    rmSync(basePath, { recursive: true, force: true });
  }
});

test("runAutoLoopWithUok does not abort when the uok-kernel-enter audit emit fails (regression #1233)", async () => {
  const basePath = makeBasePath();
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  const previousAuditEnv = process.env.GSD_UOK_AUDIT_UNIFIED;
  // Open a real DB so emitUokAuditEvent takes the authoritative write branch,
  // then drop audit_events so that write throws — the on-disk analogue of a DB
  // handle that is open but not writable, exactly the #1233 failure mode.
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true, "DB must open for this scenario");
  _getAdapter()!.exec("DROP TABLE audit_events");
  try {
    resetLegacyTelemetry();
    _resetLogs();
    const args = makeArgs(basePath, {
      uok: {
        enabled: true,
        audit_unified: { enabled: true },
        gitops: { enabled: false },
      },
    });

    // Before the fix, the telemetry-only kernel-enter emit propagated the DB
    // write error and aborted /gsd auto before the loop ever ran. It must now
    // resolve and let orchestration proceed.
    await runAutoLoopWithUok(args);

    assert.equal(args.calls.kernel, 1, "kernel loop must still run after a failed audit emit");
    assert.equal(args.calls.legacy, 0);

    // A clean enter + exit parity pair proves the loop ran to completion.
    const events = readParityEvents(basePath);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.phase, "enter");
    assert.equal(events[1]?.phase, "exit");
    assert.equal(events[1]?.status, "ok");

    // The failure must be recorded as a non-fatal warning, not silently lost.
    const warned = peekLogs().some(
      (e) =>
        e.severity === "warn" &&
        e.component === "db" &&
        /uok-kernel-enter audit emit failed/u.test(e.message),
    );
    assert.ok(warned, "a non-fatal db warning must be recorded for the failed audit emit");
  } finally {
    closeDatabase();
    _resetLogs();
    resetLegacyTelemetry();
    if (previousAuditEnv === undefined) delete process.env.GSD_UOK_AUDIT_UNIFIED;
    else process.env.GSD_UOK_AUDIT_UNIFIED = previousAuditEnv;
    rmSync(basePath, { recursive: true, force: true });
  }
});
