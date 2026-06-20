// Quality gate dispatch + state derivation tests
// Verifies the evaluating-gates phase and dispatch rule behavior.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  upsertSlicePlanning,
  upsertTaskPlanning,
  insertGateRow,
  saveGateResult,
  markAllGatesOmitted,
  getPendingSliceGateCount,
  getGateResults,
} from "../gsd-db.ts";
import { deriveState, invalidateStateCache } from "../state.ts";
import { renderPlanFromDb } from "../markdown-renderer.ts";
import { invalidateAllCaches } from "../cache.ts";
import { DISPATCH_RULES } from "../auto-dispatch.ts";

function setupTestProject(): { tmpDir: string; dbPath: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), "gate-dispatch-"));
  const dbPath = join(tmpDir, ".gsd", "gsd.db");
  mkdirSync(join(tmpDir, ".gsd"), { recursive: true });
  openDatabase(dbPath);

  // Create milestone
  insertMilestone({
    id: "M001",
    title: "Test Milestone",
    status: "active",
  });

  // Create slice
  insertSlice({
    milestoneId: "M001",
    id: "S01",
    title: "Test Slice",
    status: "pending",
    risk: "medium",
    depends: [],
  });

  // Write roadmap file (required for deriveState)
  const milestoneDir = join(tmpDir, ".gsd", "milestones", "M001");
  mkdirSync(milestoneDir, { recursive: true });
  writeFileSync(
    join(milestoneDir, "M001-ROADMAP.md"),
    [
      "# M001: Test Milestone",
      "",
      "## Vision",
      "Test milestone vision.",
      "",
      "## Success Criteria",
      "- Test criteria",
      "",
      "## Delivery Sequence",
      "- [ ] **S01: Test Slice** `risk:medium`",
      "  After this: test demo",
      "",
    ].join("\n"),
  );

  return { tmpDir, dbPath };
}

function planSlice(tmpDir: string) {
  upsertSlicePlanning("M001", "S01", {
    goal: "Test goal",
    successCriteria: "Test criteria",
    proofLevel: "contract",
    integrationClosure: "",
    observabilityImpact: "Run tests",
  });
  insertTask({
    id: "T01",
    sliceId: "S01",
    milestoneId: "M001",
    title: "Test Task",
    status: "pending",
  });
  upsertTaskPlanning("M001", "S01", "T01", {
    title: "Test Task",
    description: "Implement test",
    estimate: "1h",
    files: ["src/test.ts"],
    verify: "npm test",
    inputs: [],
    expectedOutput: ["src/test.ts"],
    observabilityImpact: "",
    fullPlanMd: "",
  });
}

describe("evaluating-gates phase", () => {
  let tmpDir: string;

  beforeEach(() => {
    const setup = setupTestProject();
    tmpDir = setup.tmpDir;
  });

  afterEach(() => {
    invalidateAllCaches();
    invalidateStateCache();
    closeDatabase();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("state returns evaluating-gates when slice gates are pending", async () => {
    planSlice(tmpDir);
    await renderPlanFromDb(tmpDir, "M001", "S01");

    // Seed gates as pending
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", scope: "slice" });

    invalidateStateCache();
    const state = await deriveState(tmpDir);
    assert.equal(state.phase, "evaluating-gates");
    assert.ok(state.nextAction.includes("quality gate"));
  });

  test("state returns executing when all gates are resolved", async () => {
    planSlice(tmpDir);
    await renderPlanFromDb(tmpDir, "M001", "S01");

    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", scope: "slice" });

    saveGateResult({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", verdict: "pass", rationale: "OK", findings: "" });
    saveGateResult({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", verdict: "omitted", rationale: "N/A", findings: "" });

    invalidateStateCache();
    const state = await deriveState(tmpDir);
    assert.equal(state.phase, "executing");
  });

  test("state returns executing when no gates exist (backward compat)", async () => {
    planSlice(tmpDir);
    await renderPlanFromDb(tmpDir, "M001", "S01");

    // No gates seeded at all
    invalidateStateCache();
    const state = await deriveState(tmpDir);
    assert.equal(state.phase, "executing");
  });

  test("markAllGatesOmitted clears evaluating-gates phase", async () => {
    planSlice(tmpDir);
    await renderPlanFromDb(tmpDir, "M001", "S01");

    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", scope: "slice" });

    invalidateStateCache();
    assert.equal((await deriveState(tmpDir)).phase, "evaluating-gates");

    markAllGatesOmitted("M001", "S01");
    invalidateStateCache();
    assert.equal((await deriveState(tmpDir)).phase, "executing");
  });

  test("task-scoped gates do not block evaluating-gates phase", async () => {
    planSlice(tmpDir);
    await renderPlanFromDb(tmpDir, "M001", "S01");

    // Only task-scoped gates — no slice-scoped gates
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q5", scope: "task", taskId: "T01" });

    invalidateStateCache();
    const state = await deriveState(tmpDir);
    // Should be executing, not evaluating-gates, because Q5 is task-scoped
    assert.equal(state.phase, "executing");
  });

  test("getPendingSliceGateCount ignores task-scoped gates", () => {
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q5", scope: "task", taskId: "T01" });
    assert.equal(getPendingSliceGateCount("M001", "S01"), 1);
  });

  test("Q8 (owned by complete-slice) does not block evaluating-gates phase", async () => {
    // Regression: Q8 is stored with scope:"slice" but owned by the
    // complete-slice turn. Before the gate registry landed, deriveState
    // counted Q8 as a blocker for evaluating-gates while the gate-evaluate
    // prompt silently dropped Q8 — an unrecoverable stall. After the
    // registry change, deriveState filters by owner turn, so Q8 never
    // blocks evaluating-gates.
    planSlice(tmpDir);
    await renderPlanFromDb(tmpDir, "M001", "S01");

    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q8", scope: "slice" });

    saveGateResult({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", verdict: "pass", rationale: "OK", findings: "" });
    saveGateResult({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", verdict: "omitted", rationale: "N/A", findings: "" });
    // Q8 deliberately left pending — it's complete-slice's problem.

    invalidateStateCache();
    const state = await deriveState(tmpDir);
    assert.equal(
      state.phase,
      "executing",
      `pending Q8 must not stall evaluating-gates — got phase=${state.phase}`,
    );
  });

  test("gate-evaluate dispatch id includes only gate-evaluate-owned gates", async () => {
    planSlice(tmpDir);
    await renderPlanFromDb(tmpDir, "M001", "S01");

    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q8", scope: "slice" });

    invalidateStateCache();
    const state = await deriveState(tmpDir);
    assert.equal(state.phase, "evaluating-gates");

    const rule = DISPATCH_RULES.find((candidate) => candidate.name === "evaluating-gates → gate-evaluate");
    assert.ok(rule, "gate-evaluate dispatch rule must exist");

    const result = await rule.match({
      basePath: tmpDir,
      mid: "M001",
      midTitle: "Test Milestone",
      state,
      prefs: { gate_evaluation: { enabled: true } },
    });

    assert.ok(result);
    assert.equal(result.action, "dispatch");
    if (result.action !== "dispatch") throw new Error("expected gate-evaluate dispatch");
    assert.equal(result.unitId, "M001/S01/gates+Q3,Q4");
    assert.doesNotMatch(result.prompt, /\*\*Q8\*\*/);
  });

  test("disabled gate evaluation only omits gate-evaluate-owned gates", async () => {
    planSlice(tmpDir);
    await renderPlanFromDb(tmpDir, "M001", "S01");

    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q3", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q4", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q8", scope: "slice" });
    insertGateRow({ milestoneId: "M001", sliceId: "S01", gateId: "Q5", scope: "task", taskId: "T01" });

    invalidateStateCache();
    const state = await deriveState(tmpDir);
    assert.equal(state.phase, "evaluating-gates");

    const rule = DISPATCH_RULES.find((candidate) => candidate.name === "evaluating-gates → gate-evaluate");
    assert.ok(rule, "gate-evaluate dispatch rule must exist");

    const result = await rule.match({
      basePath: tmpDir,
      mid: "M001",
      midTitle: "Test Milestone",
      state,
      prefs: { gate_evaluation: { enabled: false } },
    });

    assert.equal(result?.action, "skip");
    const byId = new Map(getGateResults("M001", "S01").map((gate) => [gate.gate_id, gate]));
    assert.equal(byId.get("Q3")?.verdict, "omitted");
    assert.equal(byId.get("Q4")?.verdict, "omitted");
    assert.equal(byId.get("Q8")?.status, "pending");
    assert.equal(byId.get("Q5")?.status, "pending");
  });
});
