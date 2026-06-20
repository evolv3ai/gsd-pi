// Project/App: gsd-pi
// File Purpose: Auto runtime state snapshot regression tests.

import test from "node:test";
import assert from "node:assert/strict";

import {
  autoSession,
  clearAutoToolSurfaceSnapshot,
  clearToolInvocationError,
  getAutoRuntimeSnapshot,
  recordAutoToolSurfaceSnapshot,
} from "../auto-runtime-state.ts";

test("getAutoRuntimeSnapshot includes orchestration phase when available", () => {
  autoSession.reset();
  clearAutoToolSurfaceSnapshot();
  autoSession.active = true;
  autoSession.basePath = "/tmp/project";
  autoSession.orchestration = {
    async start() { return { kind: "stopped" as const, reason: "test" }; },
    async advance() { return { kind: "stopped" as const, reason: "test" }; },
    async completeActiveUnit() {},
    async retryActiveUnit() {},
    async resume() { return { kind: "stopped" as const, reason: "test" }; },
    async stop() { return { kind: "stopped" as const, reason: "test" }; },
    getStatus() {
      return { phase: "running" as const, transitionCount: 3, lastTransitionAt: 123 };
    },
  };

  const snap = getAutoRuntimeSnapshot();

  assert.equal(snap.active, true);
  assert.equal(snap.basePath, "/tmp/project");
  assert.equal(snap.orchestrationPhase, "running");
  assert.equal(snap.orchestrationTransitionCount, 3);
  assert.equal(snap.orchestrationLastTransitionAt, 123);
  assert.equal(snap.toolSurface, null);

  autoSession.reset();
});

test("getAutoRuntimeSnapshot includes the active typed tool-surface snapshot", () => {
  autoSession.reset();
  clearAutoToolSurfaceSnapshot();
  autoSession.active = true;

  recordAutoToolSurfaceSnapshot({
    source: "dispatch-scope",
    unitType: "run-uat",
    modelFacingToolNames: ["read", "read", "gsd_uat_exec"],
    registeredToolNames: ["read", "browser_navigate"],
    scopedToolNames: ["read", "browser_navigate"],
    presentedToolNames: ["gsd_uat_exec"],
    capturedAt: 123,
  });

  const snap = getAutoRuntimeSnapshot();

  assert.equal(snap.toolSurface?.source, "dispatch-scope");
  assert.equal(snap.toolSurface?.unitType, "run-uat");
  assert.deepEqual(snap.toolSurface?.modelFacingToolNames, ["read", "gsd_uat_exec"]);
  assert.deepEqual(snap.toolSurface?.registeredToolNames, ["read", "browser_navigate"]);
  assert.deepEqual(snap.toolSurface?.scopedToolNames, ["read", "browser_navigate"]);
  assert.deepEqual(snap.toolSurface?.presentedToolNames, ["gsd_uat_exec"]);
  assert.equal(snap.toolSurface?.capturedAt, 123);

  autoSession.reset();
  clearAutoToolSurfaceSnapshot();
});

test("clearToolInvocationError clears stale tool error state for active auto sessions", () => {
  autoSession.reset();
  autoSession.active = true;
  autoSession.lastToolInvocationError = "gsd_task_complete: simulated transient tool error";

  clearToolInvocationError();

  assert.equal(autoSession.lastToolInvocationError, null);
  autoSession.reset();
});

test("getAutoRuntimeSnapshot omits orchestration phase when seam not wired", () => {
  autoSession.reset();

  const snap = getAutoRuntimeSnapshot();

  assert.equal(snap.orchestrationPhase, undefined);
  assert.equal(snap.orchestrationTransitionCount, undefined);
  assert.equal(snap.orchestrationLastTransitionAt, undefined);
  assert.equal(snap.toolSurface, null);
});
