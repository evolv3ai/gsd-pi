// gsd-pi — ADR-032 Unit Closeout module tests (Interactive Closeout adapter path).
//
// All git/preference/notification effects go through the injected deps seam —
// no real repos, no notification store state.

import test from "node:test";
import assert from "node:assert/strict";

import {
  closeUnit,
  isUnitCloseoutTool,
  runInteractiveUnitCloseout,
  type UnitCloseoutDeps,
} from "../unit-closeout.ts";

interface DepsLog {
  commits: Array<{ unitType: string; unitId: string }>;
  notices: Array<{ message: string; severity: string }>;
}

function makeDeps(overrides: {
  isolation?: "none" | "worktree" | "branch";
  branch?: string | null;
  commitResult?: string | null | (() => string | null);
} = {}): { deps: UnitCloseoutDeps; log: DepsLog } {
  const log: DepsLog = { commits: [], notices: [] };
  const deps: UnitCloseoutDeps = {
    isolationMode: () => overrides.isolation ?? "none",
    currentBranch: () => (overrides.branch === undefined ? "main" : overrides.branch),
    commit: (_basePath, unitType, unitId) => {
      log.commits.push({ unitType, unitId });
      const result = overrides.commitResult;
      if (typeof result === "function") return result();
      return result === undefined ? "chore(gsd): closeout" : result;
    },
    notify: (message, severity) => {
      log.notices.push({ message, severity });
    },
  };
  return { deps, log };
}

const BASE = "/tmp/closeout-test-project";

test("task boundary commits and stays quiet", () => {
  const { deps, log } = makeDeps({ isolation: "worktree" });
  const result = closeUnit(
    { basePath: BASE, unitType: "execute-task", unitId: "M001/S01/T01", boundary: "task", outcome: "complete" },
    deps,
  );
  assert.equal(result.gitVerdict, "committed");
  assert.equal(result.notice, undefined);
  assert.deepEqual(log.commits, [{ unitType: "execute-task", unitId: "M001/S01/T01" }]);
  assert.equal(log.notices.length, 0);
});

test("milestone boundary under isolation none commits without a notice", () => {
  const { deps, log } = makeDeps({ isolation: "none" });
  const result = closeUnit(
    { basePath: BASE, unitType: "complete-milestone", unitId: "M001", boundary: "milestone", outcome: "complete" },
    deps,
  );
  assert.equal(result.gitVerdict, "committed");
  assert.equal(log.notices.length, 0);
});

test("milestone boundary off-worktree under isolation worktree fails closed loudly", () => {
  const { deps, log } = makeDeps({ isolation: "worktree", branch: "main" });
  const result = closeUnit(
    { basePath: BASE, unitType: "complete-milestone", unitId: "M001", boundary: "milestone", outcome: "complete" },
    deps,
  );
  assert.equal(result.gitVerdict, "isolation-bypassed");
  assert.equal(log.notices.length, 1);
  assert.equal(log.notices[0].severity, "warning");
  assert.match(log.notices[0].message, /isolation preference was not honoured/);
  assert.match(log.notices[0].message, /git\.isolation is "worktree"/);
  assert.match(log.notices[0].message, /committed directly on "main"/);
});

test("milestone boundary on a milestone branch defers the merge to worktree tooling", () => {
  const { deps, log } = makeDeps({ isolation: "worktree", branch: "milestone/M001" });
  const result = closeUnit(
    { basePath: BASE, unitType: "complete-milestone", unitId: "M001", boundary: "milestone", outcome: "complete" },
    deps,
  );
  assert.equal(result.gitVerdict, "milestone-branch");
  assert.equal(log.notices.length, 1);
  assert.equal(log.notices[0].severity, "info");
  assert.match(log.notices[0].message, /worktree merge/);
});

test("clean tree records nothing-to-commit, and the bypass notice says so", () => {
  const { deps, log } = makeDeps({ isolation: "branch", branch: "main", commitResult: null });
  const result = closeUnit(
    { basePath: BASE, unitType: "complete-milestone", unitId: "M001", boundary: "milestone", outcome: "complete" },
    deps,
  );
  assert.equal(result.gitVerdict, "isolation-bypassed");
  assert.equal(result.commitMessage, null);
  assert.match(log.notices[0].message, /nothing left to commit/);
});

test("commit failure is surfaced, never thrown", () => {
  const { deps, log } = makeDeps({
    commitResult: () => {
      throw new Error("index.lock exists");
    },
  });
  const result = closeUnit(
    { basePath: BASE, unitType: "complete-milestone", unitId: "M001", boundary: "milestone", outcome: "complete" },
    deps,
  );
  assert.equal(result.gitVerdict, "commit-failed");
  assert.equal(log.notices[0].severity, "error");
  assert.match(log.notices[0].message, /index\.lock/);
});

test("re-entrancy is safe: a re-fire over an already-clean tree is nothing-to-commit", () => {
  // No result cache — re-entrancy is absorbed by git itself. The second fire
  // sees a clean tree (commit returns null) and records nothing-to-commit.
  let firstFire = true;
  const { deps, log } = makeDeps({
    isolation: "worktree",
    branch: "main",
    commitResult: () => {
      const committed = firstFire;
      firstFire = false;
      return committed ? "chore(gsd): closeout" : null;
    },
  });
  const request = {
    basePath: BASE,
    unitType: "complete-milestone",
    unitId: "M001",
    boundary: "milestone" as const,
    outcome: "complete" as const,
  };
  const first = closeUnit(request, deps);
  const second = closeUnit(request, deps);
  assert.equal(first.gitVerdict, "isolation-bypassed");
  assert.equal(first.commitMessage, "chore(gsd): closeout");
  assert.equal(second.gitVerdict, "isolation-bypassed");
  assert.equal(second.commitMessage, null);
  assert.match(second.notice ?? "", /nothing left to commit/);
  assert.equal(log.commits.length, 2);
});

// ─── Interactive adapter mapping ──────────────────────────────────────────

test("isUnitCloseoutTool recognizes exactly the closeout tools", () => {
  assert.equal(isUnitCloseoutTool("gsd_complete_milestone"), true);
  assert.equal(isUnitCloseoutTool("gsd_save_gate_result"), false);
  assert.equal(isUnitCloseoutTool("read"), false);
});

test("interactive adapter is scoped to milestone boundaries — task/slice tools do not commit", () => {
  const { deps, log } = makeDeps();
  assert.equal(isUnitCloseoutTool("gsd_task_complete"), false);
  assert.equal(isUnitCloseoutTool("gsd_slice_complete"), false);
  assert.equal(
    runInteractiveUnitCloseout(
      { basePath: BASE, canonicalToolName: "gsd_task_complete", input: { milestoneId: "M001", sliceId: "S02", taskId: "T03" } },
      deps,
    ),
    null,
  );
  assert.equal(
    runInteractiveUnitCloseout(
      { basePath: BASE, canonicalToolName: "gsd_slice_complete", input: { milestoneId: "M001", sliceId: "S02" } },
      deps,
    ),
    null,
  );
  assert.equal(log.commits.length, 0);
});

test("interactive adapter maps milestone tool input to canonical unit type", () => {
  const { deps, log } = makeDeps();
  const result = runInteractiveUnitCloseout(
    { basePath: BASE, canonicalToolName: "gsd_complete_milestone", input: { milestoneId: "M001" } },
    deps,
  );
  assert.equal(result?.gitVerdict, "committed");
  assert.deepEqual(log.commits, [{ unitType: "complete-milestone", unitId: "M001" }]);
});

test("interactive adapter accepts snake_case ids and milestone-only input", () => {
  const { deps, log } = makeDeps();
  const result = runInteractiveUnitCloseout(
    { basePath: BASE, canonicalToolName: "gsd_complete_milestone", input: { milestone_id: "M007" } },
    deps,
  );
  assert.equal(result?.gitVerdict, "committed");
  assert.deepEqual(log.commits, [{ unitType: "complete-milestone", unitId: "M007" }]);
});

test("interactive adapter declines unidentifiable input instead of guessing", () => {
  const { deps, log } = makeDeps();
  assert.equal(
    runInteractiveUnitCloseout({ basePath: BASE, canonicalToolName: "gsd_complete_milestone", input: {} }, deps),
    null,
  );
  assert.equal(
    runInteractiveUnitCloseout({ basePath: BASE, canonicalToolName: "not_a_closeout_tool", input: { milestoneId: "M001" } }, deps),
    null,
  );
  assert.equal(log.commits.length, 0);
});
