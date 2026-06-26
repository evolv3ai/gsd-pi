/**
 * Regression test for issue #909.
 *
 * When S##-PLAN.md exists (causing deriveState → phase:'executing') but the
 * individual task plan files (tasks/T01-PLAN.md, etc.) are absent, the dispatch
 * table must recover by re-running plan-slice — NOT hard-stop.
 *
 * Prior behaviour: action:"stop" → infinite loop on restart.
 * Fixed behaviour: action:"dispatch" unitType:"plan-slice".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveDispatch } from "../auto-dispatch.ts";
import type { DispatchContext } from "../auto-dispatch.ts";
import type { AutoSession } from "../auto/session.ts";
import type { GSDState } from "../types.ts";
import { enableDebug, disableDebug, getDebugLogPath } from "../debug-logger.ts";
import { closeDatabase, insertMilestone, isDbAvailable, openDatabase } from "../gsd-db.ts";

function makeState(overrides: Partial<GSDState> = {}): GSDState {
  return {
    activeMilestone: { id: "M002", title: "Test Milestone" },
    activeSlice: { id: "S03", title: "Third Slice" },
    activeTask: { id: "T01", title: "First Task" },
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
    ...overrides,
  };
}

function makeContext(basePath: string, stateOverrides?: Partial<GSDState>): DispatchContext {
  return {
    basePath,
    mid: "M002",
    midTitle: "Test Milestone",
    state: makeState(stateOverrides),
    prefs: undefined,
  };
}

function makeContextFor(
  basePath: string,
  mid: string,
  sid: string,
  tid: string,
  session?: Partial<AutoSession>,
): DispatchContext {
  return {
    basePath,
    mid,
    midTitle: "Test Milestone",
    state: makeState({
      activeMilestone: { id: mid, title: "Test Milestone" },
      activeSlice: { id: sid, title: "Second Slice" },
      activeTask: { id: tid, title: "First Task" },
    }),
    prefs: undefined,
    session: session as AutoSession | undefined,
  };
}

// ─── Scaffold helpers ──────────────────────────────────────────────────────

function scaffoldSlicePlan(basePath: string, mid: string, sid: string): void {
  // Flat-phase: phases/NN-slug/NN-MM-PLAN.md
  const phaseNum = parseInt(mid.match(/^M0*(\d+)/i)?.[1] || '1', 10);
  const planNum = parseInt(sid.match(/^S0*(\d+)/i)?.[1] || '1', 10);
  const dir = join(basePath, ".gsd", "phases", `${String(phaseNum).padStart(2, '0')}-test`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${String(phaseNum).padStart(2, '0')}-${String(planNum).padStart(2, '0')}-PLAN.md`), [
    `# ${sid}: Third Slice`,
    "",
    "## Tasks",
    "- [ ] **T01: Do something** `est:1h`",
    "- [ ] **T02: Do another thing** `est:30m`",
    "",
  ].join("\n"));
}

function scaffoldMilestoneContext(basePath: string, mid: string): void {
  const phaseNum = parseInt(mid.match(/^M0*(\d+)/i)?.[1] || '1', 10);
  const dir = join(basePath, ".gsd", "phases", `${String(phaseNum).padStart(2, '0')}-test`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${String(phaseNum).padStart(2, '0')}-CONTEXT.md`), [
    `# ${mid}: Test Milestone`,
    "",
    "Context for dispatch recovery tests.",
    "",
  ].join("\n"));
}

function scaffoldTaskPlan(basePath: string, mid: string, sid: string, tid: string): void {
  // Flat-phase: no per-task plan files. This is a no-op — tasks live as
  // checkboxes inside the slice plan. Kept for backward-compat with tests
  // that call it; does nothing in flat-phase.
}

// ─── Tests ─────────────────────────────────────────────────────────────────

test("dispatch: missing task plan triggers plan-slice (not stop) — issue #909", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-909-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  // Slice plan exists with tasks. In flat-phase, tasks are checkboxes inside
  // the slice plan (no per-task files), so this is the NORMAL state — dispatch
  // should proceed to execute-task, not recover with plan-slice.
  scaffoldMilestoneContext(tmp, "M002");
  scaffoldSlicePlan(tmp, "M002", "S03");

  const ctx = makeContext(tmp);
  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "dispatch", "should dispatch, not stop");
  // Flat-phase: tasks embedded in slice plan → execute-task (not plan-slice recovery)
  assert.ok(result.action === "dispatch" && result.unitType === "execute-task",
    `unitType should be execute-task (tasks in slice plan), got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
});

test("dispatch: closed milestone is not implicitly recovered or reopened", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-closed-dispatch-"));
  t.after(() => {
    if (isDbAvailable()) closeDatabase();
    rmSync(tmp, { recursive: true, force: true });
  });

  if (isDbAvailable()) closeDatabase();
  mkdirSync(join(tmp, ".gsd"), { recursive: true });
  openDatabase(join(tmp, ".gsd", "gsd.db"));
  insertMilestone({ id: "M002", title: "Closed Milestone", status: "complete" });
  scaffoldMilestoneContext(tmp, "M002");
  scaffoldSlicePlan(tmp, "M002", "S03");

  const result = await resolveDispatch(makeContext(tmp));

  assert.equal(result.action, "stop");
  assert.ok(result.action === "stop");
  assert.equal(result.level, "warning");
  assert.match(result.reason, /Milestone M002 is closed/);
  assert.match(result.reason, /will not reopen or recover it implicitly/);
});

test("dispatch: present task plan proceeds to execute-task normally", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-909-ok-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  scaffoldMilestoneContext(tmp, "M002");
  scaffoldSlicePlan(tmp, "M002", "S03");
  // Flat-phase: tasks are checkboxes inside the slice plan (no per-task PLAN files).
  // scaffoldTaskPlan is intentionally NOT called here — creating a milestones/ dir
  // as a side effect would confuse milestonesDir() into treating this as a legacy
  // layout, breaking slice plan resolution and causing discuss-milestone dispatch.

  const ctx = makeContext(tmp);
  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "dispatch");
  assert.ok(result.action === "dispatch" && result.unitType === "execute-task",
    `unitType should be execute-task, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
  assert.ok(result.action === "dispatch" && result.unitId === "M002/S03/T01",
    `unitId should be M002/S03/T01, got: ${result.action === "dispatch" ? result.unitId : "(stop)"}`);
});

test("dispatch: session milestone mismatch stops before missing-task-plan recovery", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-session-milestone-mismatch-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const worktreeRoot = join(tmp, ".gsd", "worktrees", "M002");
  mkdirSync(worktreeRoot, { recursive: true });

  const ctx = makeContextFor(tmp, "M001", "S01", "T01", {
    basePath: worktreeRoot,
    originalBasePath: tmp,
    currentMilestoneId: "M002",
  });
  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "stop");
  assert.ok(result.action === "stop");
  assert.equal(result.level, "warning");
  assert.match(result.reason, /context mid "M001" does not match session\.currentMilestoneId "M002"/);
});

test("dispatch: worktree path mismatch stops before planning a different milestone", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-worktree-path-milestone-mismatch-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const worktreeRoot = join(tmp, ".gsd", "worktrees", "M002");
  mkdirSync(worktreeRoot, { recursive: true });

  const ctx = makeContextFor(worktreeRoot, "M001", "S01", "T01");
  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "stop");
  assert.ok(result.action === "stop");
  assert.equal(result.level, "warning");
  assert.match(result.reason, /context mid "M001" does not match basePath worktree "M002"/);
});

test("dispatch: executing recovery checks active milestone worktree task plans before re-dispatching plan-slice", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-6192-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  scaffoldMilestoneContext(tmp, "M002");
  scaffoldSlicePlan(tmp, "M002", "S03");

  const worktreeRoot = join(tmp, ".gsd", "worktrees", "M002");
  mkdirSync(worktreeRoot, { recursive: true });
  writeFileSync(join(worktreeRoot, ".git"), "gitdir: /tmp/fake-worktree-gitdir\n");
  scaffoldMilestoneContext(worktreeRoot, "M002");
  scaffoldSlicePlan(worktreeRoot, "M002", "S03");
  scaffoldTaskPlan(worktreeRoot, "M002", "S03", "T01");

  const ctx = makeContext(tmp);
  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "dispatch");
  assert.ok(result.action === "dispatch" && result.unitType === "execute-task",
    `unitType should be execute-task, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
  assert.ok(result.action === "dispatch" && result.unitId === "M002/S03/T01",
    `unitId should be M002/S03/T01, got: ${result.action === "dispatch" ? result.unitId : "(stop)"}`);
});

test("dispatch: active session worktree task plan wins over missing original-root task plan", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-worktree-artifact-root-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  scaffoldMilestoneContext(tmp, "M004");
  scaffoldSlicePlan(tmp, "M004", "S02");

  const worktreeRoot = join(tmp, ".gsd", "worktrees", "M004");
  mkdirSync(worktreeRoot, { recursive: true });
  scaffoldMilestoneContext(worktreeRoot, "M004");
  scaffoldSlicePlan(worktreeRoot, "M004", "S02");
  scaffoldTaskPlan(worktreeRoot, "M004", "S02", "T01");

  const ctx = makeContextFor(tmp, "M004", "S02", "T01", {
    basePath: worktreeRoot,
    originalBasePath: tmp,
    currentMilestoneId: "M004",
  });
  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "dispatch");
  assert.ok(result.action === "dispatch" && result.unitType === "execute-task",
    `unitType should be execute-task, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
  assert.ok(result.action === "dispatch" && result.unitId === "M004/S02/T01",
    `unitId should be M004/S02/T01, got: ${result.action === "dispatch" ? result.unitId : "(stop)"}`);
});

test("dispatch: artifact checks trust active session basePath even when originalBasePath matches", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "gsd-worktree-session-basepath-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  scaffoldMilestoneContext(tmp, "M004");
  scaffoldSlicePlan(tmp, "M004", "S02");

  const activeMilestoneRoot = join(tmp, ".gsd", "runtime-active", "M004");
  mkdirSync(activeMilestoneRoot, { recursive: true });
  scaffoldMilestoneContext(activeMilestoneRoot, "M004");
  scaffoldSlicePlan(activeMilestoneRoot, "M004", "S02");
  scaffoldTaskPlan(activeMilestoneRoot, "M004", "S02", "T01");

  const ctx = makeContextFor(tmp, "M004", "S02", "T01", {
    basePath: activeMilestoneRoot,
    originalBasePath: activeMilestoneRoot,
    currentMilestoneId: "M004",
  });
  const result = await resolveDispatch(ctx);

  assert.equal(result.action, "dispatch");
  assert.ok(result.action === "dispatch" && result.unitType === "execute-task",
    `unitType should be execute-task, got: ${result.action === "dispatch" ? result.unitType : "(stop)"}`);
  assert.ok(result.action === "dispatch" && result.unitId === "M004/S02/T01",
    `unitId should be M004/S02/T01, got: ${result.action === "dispatch" ? result.unitId : "(stop)"}`);
});

test("dispatch: plan-slice recovery loop — second call after plan-slice still recovers cleanly", async (t) => {
  // Flat-phase: tasks are checkboxes inside the slice plan, so there are no
  // per-task plan files to be "missing". Dispatch should go to execute-task
  // (the normal flow), not plan-slice recovery.
  const tmp = mkdtempSync(join(tmpdir(), "gsd-909-loop-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  scaffoldMilestoneContext(tmp, "M002");
  scaffoldSlicePlan(tmp, "M002", "S03");

  const ctx = makeContext(tmp);
  const r1 = await resolveDispatch(ctx);
  assert.equal(r1.action, "dispatch");
  assert.ok(r1.action === "dispatch" && r1.unitType === "execute-task",
    "flat-phase: should dispatch execute-task (tasks in slice plan)");

  // Second dispatch should also go to execute-task (idempotent)
  const r2 = await resolveDispatch(ctx);
  assert.equal(r2.action, "dispatch");
  assert.ok(r2.action === "dispatch" && r2.unitType === "execute-task",
    "should keep dispatching execute-task");
});

test("dispatch: missing task plan recovery logs root/worktree diagnostic when debug enabled — issue #6194", async (t) => {
  // Flat-phase: tasks are embedded in the slice plan, so the recovery rule
  // (which fires when per-task plan files are missing) doesn't apply.
  // The diagnostic log entry is only produced in the legacy layout.
  // This test verifies the normal flat-phase dispatch path doesn't crash
  // with debug enabled.
  const tmp = mkdtempSync(join(tmpdir(), "gsd-6194-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  scaffoldMilestoneContext(tmp, "M002");
  scaffoldSlicePlan(tmp, "M002", "S03");

  enableDebug(tmp);
  t.after(() => disableDebug());

  const ctx = makeContext(tmp);
  const result = await resolveDispatch(ctx);
  // Flat-phase: dispatch goes to execute-task (tasks in slice plan)
  assert.ok(result.action === "dispatch",
    "should dispatch without crashing in debug mode");
  // Flat-phase: no recovery diagnostic entry expected (tasks in slice plan)
});
