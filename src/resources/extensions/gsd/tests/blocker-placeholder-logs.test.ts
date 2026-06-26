// gsd-pi — Blocker-placeholder recovery log coverage.
//
// writeBlockerPlaceholder (auto-recovery.ts:782) writes a placeholder artifact
// so the pipeline can advance past a stuck unit, then marks the task/slice
// complete in the DB and appends a workflow event so reconciliation can replay
// the recovery. Each of those side-effects is individually best-effort and logs
// a recovery warning on failure (auto-recovery.ts:837/840/843/844/853/854). No
// test asserted any of them. We trigger each by breaking the specific sink
// (drop the relevant DB table, or block the events-file append) and assert the
// warning lands.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { writeBlockerPlaceholder } from "../auto-recovery.ts";
import { writeReactiveExecuteBlocker } from "../auto-recovery.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  _getAdapter,
} from "../gsd-db.ts";
import {
  drainLogs,
  setStderrLoggingEnabled,
  _resetLogs,
  type LogEntry,
} from "../workflow-logger.ts";

function makeBase(prefix = "gsd-blocker-logs-"): string {
  const base = mkdtempSync(join(tmpdir(), prefix));
  // Slice projection dirs so the placeholder path resolves.
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  return base;
}

function captureLogs<T>(fn: () => T): { result: T; logs: LogEntry[] } {
  const previous = setStderrLoggingEnabled(false);
  _resetLogs();
  try {
    const result = fn();
    return { result, logs: drainLogs() };
  } finally {
    _resetLogs();
    setStderrLoggingEnabled(previous);
  }
}

function recoveryWarnings(logs: readonly LogEntry[]): LogEntry[] {
  return logs.filter((e) => e.component === "recovery" && e.severity === "warn");
}

test("writeBlockerPlaceholder logs a recovery warning when updateTaskStatus throws (auto-recovery.ts:837)", () => {
  const base = makeBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    // Drop tasks so updateTaskStatus throws inside the execute-task DB block.
    _getAdapter()!.exec("DROP TABLE tasks");

    const { logs } = captureLogs(() =>
      writeBlockerPlaceholder("execute-task", "M001/S01/T01", base, "exhausted retries"),
    );

    const warn = recoveryWarnings(logs).find((w) => /updateTaskStatus failed during context exhaustion/u.test(w.message));
    assert.ok(warn, "a recovery warning must be logged when updateTaskStatus throws");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeBlockerPlaceholder logs a recovery warning when updateSliceStatus throws (auto-recovery.ts:843)", () => {
  const base = makeBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    // Drop slices so updateSliceStatus throws inside the complete-slice DB block.
    _getAdapter()!.exec("DROP TABLE slices");

    const { logs } = captureLogs(() =>
      writeBlockerPlaceholder("complete-slice", "M001/S01", base, "exhausted retries"),
    );

    const warn = recoveryWarnings(logs).find((w) => /updateSliceStatus failed during context exhaustion/u.test(w.message));
    assert.ok(warn, "a recovery warning must be logged when updateSliceStatus throws");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeBlockerPlaceholder logs a recovery warning when the plan-milestone insertSlice throws (auto-recovery.ts:853)", () => {
  const base = makeBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    // Drop slices so the S00-blocker insertSlice throws inside the
    // plan-milestone placeholder branch.
    _getAdapter()!.exec("DROP TABLE slices");

    const { logs } = captureLogs(() =>
      writeBlockerPlaceholder("plan-milestone", "M001", base, "exhausted retries"),
    );

    const warn = recoveryWarnings(logs).find((w) =>
      /insertSlice placeholder failed for plan-milestone recovery/u.test(w.message),
    );
    assert.ok(warn, "a recovery warning must be logged when the blocker slice insert throws");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeBlockerPlaceholder logs a recovery warning when the workflow-event append throws (auto-recovery.ts:840)", () => {
  const base = makeBase();
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    // Block the workflow-events append by turning its target into a directory
    // (appendFileSync on a directory throws EISDIR). The placeholder write still
    // succeeds because it targets a different path under milestones/.
    mkdirSync(join(base, ".gsd", "event-log.jsonl"), { recursive: true });

    const { logs } = captureLogs(() =>
      writeBlockerPlaceholder("execute-task", "M001/S01/T01", base, "exhausted retries"),
    );

    const warn = recoveryWarnings(logs).find((w) => /appendEvent failed for task recovery/u.test(w.message));
    assert.ok(warn, "a recovery warning must be logged when the recovery event append fails");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeBlockerPlaceholder logs a recovery warning when the complete-slice appendEvent throws (auto-recovery.ts:898)", () => {
  const base = makeBase("gsd-blocker-logs-cs-");
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    // Slices table intact so updateSliceStatus (:897) succeeds; block the
    // workflow-event append so the complete-slice appendEvent (:898) throws.
    mkdirSync(join(base, ".gsd", "event-log.jsonl"), { recursive: true });

    const { logs } = captureLogs(() =>
      writeBlockerPlaceholder("complete-slice", "M001/S01", base, "exhausted retries"),
    );

    const warn = recoveryWarnings(logs).find((w) => /appendEvent failed for slice recovery/u.test(w.message));
    assert.ok(warn, "a recovery warning must be logged when the complete-slice appendEvent throws");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("writeBlockerPlaceholder logs a recovery warning when the plan-milestone appendEvent throws (auto-recovery.ts:908)", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-blocker-logs-pm-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001"), { recursive: true });
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    // Slices table intact so the S00-blocker insertSlice (:907) succeeds;
    // block the workflow-event append so the plan-milestone appendEvent (:908) throws.
    mkdirSync(join(base, ".gsd", "event-log.jsonl"), { recursive: true });

    const { logs } = captureLogs(() =>
      writeBlockerPlaceholder("plan-milestone", "M001", base, "exhausted retries"),
    );

    const warn = recoveryWarnings(logs).find((w) => /appendEvent failed for plan-milestone recovery/u.test(w.message));
    assert.ok(warn, "a recovery warning must be logged when the plan-milestone appendEvent throws");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

// ── writeReactiveExecuteBlocker append-event warnings (:755 / :768) ────────
// These fire after the reactive batch recovery transaction commits, when the
// per-task workflow-event append throws. We seed a real slice with two tasks,
// plant the event-log target as a directory (appendFileSync → EISDIR), and call
// writeReactiveExecuteBlocker; both the complete-task and skip-task appends fail.

test("writeReactiveExecuteBlocker logs recovery warnings when the post-recovery event appends throw (auto-recovery.ts:755/:768)", () => {
  const base = mkdtempSync(join(tmpdir(), "gsd-blocker-logs-reactive-"));
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  try {
    openDatabase(join(base, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "M", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "S", status: "active", risk: "low", depends: [], demo: "", sequence: 1 });
    insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "T1", status: "active" });
    insertTask({ id: "T02", sliceId: "S01", milestoneId: "M001", title: "T2", status: "active" });
    // T01 has a summary (→ complete recovery path → :755), T02 does not
    // (→ skip recovery path → :768).
    writeFileSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01-SUMMARY.md"), "# T01\n", "utf-8");
    // Block the workflow-event append (event-log.jsonl is the real ledger file).
    mkdirSync(join(base, ".gsd", "event-log.jsonl"), { recursive: true });

    const { logs } = captureLogs(() =>
      writeReactiveExecuteBlocker("M001/S01/reactive+T01,T02", base, "batch exhausted"),
    );

    const warnings = recoveryWarnings(logs).map((w) => w.message);
    assert.ok(
      warnings.some((m) => /appendEvent failed for reactive complete recovery/u.test(m)),
      "the complete-task append warning must be logged (:755)",
    );
    assert.ok(
      warnings.some((m) => /appendEvent failed for reactive skip recovery/u.test(m)),
      "the skip-task append warning must be logged (:768)",
    );
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
