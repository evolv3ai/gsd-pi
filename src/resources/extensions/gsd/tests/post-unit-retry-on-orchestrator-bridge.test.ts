import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mock } from "node:test";

import { postUnitPostVerification, type PostUnitContext } from "../auto-post-unit.ts";
import { AutoSession } from "../auto/session.ts";
import { checkPostUnitHooks, resetHookState, resolveHookArtifactPath } from "../post-unit-hooks.ts";
import { _clearGsdRootCache } from "../paths.ts";
import { invalidateAllCaches } from "../cache.ts";

function writePreferences(basePath: string): void {
  const content = `---
post_unit_hooks:
  - name: review-arbiter
    after:
      - execute-task
    prompt: Review {taskId}
    agent: arbiter
    artifact: REVIEW-DEBATE.md
    retry_on: NEEDS-REWORK.md
    max_cycles: 3
    enabled: true
---
`;
  writeFileSync(join(basePath, ".gsd", "PREFERENCES.md"), content, "utf-8");
}

test("post-unit retry_on marks trigger unit as retry in orchestrator before redispatch", async () => {
  const originalCwd = process.cwd();
  const base = mkdtempSync(join(tmpdir(), "gsd-post-unit-retry-"));
  const taskDir = join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks");
  mkdirSync(taskDir, { recursive: true });

  try {
    process.chdir(base);
    _clearGsdRootCache();
    invalidateAllCaches();
    resetHookState();
    writePreferences(base);

    const hookDispatch = checkPostUnitHooks("execute-task", "M001/S01/T01", base);
    assert.ok(hookDispatch, "hook should dispatch for execute-task");

    const retryPath = resolveHookArtifactPath(base, "M001/S01/T01", "NEEDS-REWORK.md");
    writeFileSync(retryPath, "rework requested", "utf-8");

    const retryActiveUnit = mock.fn(async (_unit: { unitType: string; unitId: string }) => {});
    const s = new AutoSession();
    s.basePath = base;
    s.active = true;
    s.currentUnit = { type: "hook/review-arbiter", id: "M001/S01/T01", startedAt: Date.now() };
    s.orchestration = {
      start: async () => ({ kind: "started" }),
      advance: async () => ({ kind: "stopped", reason: "unused" }),
      completeActiveUnit: async () => {},
      retryActiveUnit,
      resume: async () => ({ kind: "resumed" }),
      stop: async (reason: string) => ({ kind: "stopped", reason }),
      getStatus: () => ({ phase: "running", transitionCount: 0 }),
    };

    const pctx: PostUnitContext = {
      s,
      ctx: {
        ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, setFooter: () => {} },
        model: { id: "test-model" },
      } as any,
      pi: { sendMessage: async () => {}, setModel: async () => true } as any,
      buildSnapshotOpts: () => ({}),
      lockBase: () => base,
      stopAuto: async () => {},
      pauseAuto: async () => {},
      updateProgressWidget: () => {},
    };

    const result = await postUnitPostVerification(pctx);
    assert.equal(result, "continue");
    assert.equal(retryActiveUnit.mock.callCount(), 1);
    assert.deepEqual(retryActiveUnit.mock.calls[0]?.arguments[0], {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
    });
  } finally {
    process.chdir(originalCwd);
    resetHookState();
    invalidateAllCaches();
    _clearGsdRootCache();
    rmSync(base, { recursive: true, force: true });
  }
});
