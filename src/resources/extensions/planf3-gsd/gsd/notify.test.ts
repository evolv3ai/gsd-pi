import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { emit, shouldMirrorToStdout, type EmitContext } from "./notify.js";

function ctxWith(overrides: Partial<{ hasUI: boolean; mode: string }> = {}, notified: string[] = []): EmitContext {
  return {
    hasUI: overrides.hasUI,
    ui: { mode: overrides.mode, notify: (message: string) => { notified.push(message); } },
  };
}

function withEnv<T>(pairs: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(pairs)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const CLEAN = { PLANF3_GSD_STDOUT: undefined, GSD_HEADLESS: undefined };

describe("shouldMirrorToStdout", () => {
  test("hasUI=false (print mode: no-op UI substituted) mirrors", () => {
    withEnv(CLEAN, () => assert.equal(shouldMirrorToStdout(ctxWith({ hasUI: false })), true));
  });
  test("interactive TUI (hasUI=true, no headless markers) does not mirror", () => {
    withEnv(CLEAN, () => assert.equal(shouldMirrorToStdout(ctxWith({ hasUI: true })), false));
  });
  test("GSD_HEADLESS=1 mirrors even with hasUI=true", () => {
    withEnv({ ...CLEAN, GSD_HEADLESS: "1" }, () => assert.equal(shouldMirrorToStdout(ctxWith({ hasUI: true })), true));
  });
  test("ui.mode rpc/headless mirrors", () => {
    withEnv(CLEAN, () => {
      assert.equal(shouldMirrorToStdout(ctxWith({ hasUI: true, mode: "rpc" })), true);
      assert.equal(shouldMirrorToStdout(ctxWith({ hasUI: true, mode: "headless" })), true);
    });
  });
  test("PLANF3_GSD_STDOUT overrides both ways", () => {
    withEnv({ ...CLEAN, PLANF3_GSD_STDOUT: "1" }, () => assert.equal(shouldMirrorToStdout(ctxWith({ hasUI: true })), true));
    withEnv({ ...CLEAN, PLANF3_GSD_STDOUT: "0" }, () => assert.equal(shouldMirrorToStdout(ctxWith({ hasUI: false })), false));
  });
});

describe("emit", () => {
  test("always notifies; mirrors with prefix when non-interactive", () => {
    withEnv(CLEAN, () => {
      const notified: string[] = [];
      const written: string[] = [];
      emit(ctxWith({ hasUI: false }, notified), "hello world", "info", (chunk) => written.push(chunk));
      assert.deepEqual(notified, ["hello world"]);
      assert.deepEqual(written, ["[planf3-gsd] hello world\n"]);
    });
  });
  test("does not mirror in interactive mode", () => {
    withEnv(CLEAN, () => {
      const notified: string[] = [];
      const written: string[] = [];
      emit(ctxWith({ hasUI: true }, notified), "quiet", "info", (chunk) => written.push(chunk));
      assert.deepEqual(notified, ["quiet"]);
      assert.deepEqual(written, []);
    });
  });
});
