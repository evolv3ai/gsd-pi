import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { _getAdapter, closeDatabase, insertMilestone, insertSlice, insertTask, openDatabase } from "../gsd-db.ts";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { filterDoctorIssues } from "../doctor-format.ts";
import { checkEngineHealth } from "../doctor-engine-checks.ts";
import { appendEvent } from "../workflow-events.ts";
import { renderPlanFromDb, renderRoadmapFromDb } from "../markdown-renderer.ts";

afterEach(() => {
  closeDatabase();
});

test("filterDoctorIssues keeps project and environment issues in scoped reports", () => {
  const issues = [
    { severity: "error", code: "env_dependencies", scope: "project", unitId: "environment", message: "node_modules missing", fixable: false },
    { severity: "warning", code: "db_unavailable", scope: "project", unitId: "project", message: "DB unavailable", fixable: false },
    { severity: "warning", code: "state_file_missing", scope: "slice", unitId: "M016/S01", message: "slice warning", fixable: false },
  ] as const;

  const filtered = filterDoctorIssues([...issues], { scope: "M016", includeWarnings: true });
  assert.deepEqual(
    filtered.map((issue) => issue.unitId),
    ["environment", "project", "M016/S01"],
  );
});

test("filterDoctorIssues keeps invalid_preferences issues regardless of preferences file scope", () => {
  // Both global and project preference diagnostics should survive scope filtering.
  // doctor.ts uses unitId: "project" for all invalid_preferences issues so they
  // pass through the scope filter the same way other project-level issues do.
  const issues = [
    { severity: "error", code: "invalid_preferences", scope: "project", unitId: "project", message: "global PREFERENCES.md parse error", fixable: false },
    { severity: "error", code: "invalid_preferences", scope: "project", unitId: "project", message: "project PREFERENCES.md parse error", fixable: false },
    { severity: "error", code: "invalid_preferences", scope: "project", unitId: "global", message: "stale unitId — should be filtered out", fixable: false },
  ] as const;

  const filtered = filterDoctorIssues([...issues], { scope: "M016", includeWarnings: true });
  assert.deepEqual(
    filtered.map((issue) => issue.message),
    ["global PREFERENCES.md parse error", "project PREFERENCES.md parse error"],
    "invalid_preferences issues with unitId: project survive scope filtering; unitId: global is dropped",
  );
});

test("checkEngineHealth reports db_unavailable when gsd.db exists but the DB is closed", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-db-unavailable-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  writeFileSync(join(gsdDir, "gsd.db"), "");

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  const dbIssue = issues.find((issue) => issue.code === "db_unavailable");
  assert.ok(dbIssue, "doctor should surface degraded DB mode when a DB file exists");
  assert.equal(dbIssue.unitId, "project");
  assert.equal(dbIssue.file, ".gsd/gsd.db");
});

test("checkEngineHealth reports checkbox divergence against DB status", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-checkbox-drift-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  openDatabase(join(gsdDir, "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending", risk: "low", depends: [], sequence: 1 });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Task", status: "complete", sequence: 1 });

  const roadmap = await renderRoadmapFromDb(base, "M001");
  if ("skipped" in roadmap) assert.fail("planned milestone should render a roadmap");
  const plan = await renderPlanFromDb(base, "M001", "S01");

  writeFileSync(roadmap.roadmapPath, readFileSync(roadmap.roadmapPath, "utf-8").replace("- [ ] **S01:", "- [x] **S01:"), "utf-8");
  writeFileSync(plan.planPath, readFileSync(plan.planPath, "utf-8").replace("- [x] **T01**:", "- [ ] **T01**:"), "utf-8");

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  const divergences = issues.filter((issue) => issue.code === "checkbox_db_status_divergence");
  assert.deepEqual(
    divergences.map((issue) => issue.unitId).sort(),
    ["M001/S01", "M001/S01/T01"],
  );
});

test("checkEngineHealth reads canonical reopen events from worktree bases", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-reopen-worktree-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  const worktree = join(gsdDir, "worktrees", "M001");
  mkdirSync(join(worktree, ".gsd"), { recursive: true });
  writeFileSync(join(worktree, ".git"), "gitdir: ../../../../.git/worktrees/M001\n", "utf-8");

  openDatabase(join(gsdDir, "gsd.db"));
  insertMilestone({ id: "M001", title: "Reopened", status: "active" });
  const db = _getAdapter()!;
  db.prepare(
    `INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status, project_root_realpath
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("worker-1", "localhost", 1, "2026-01-01T00:00:00.000Z", "test", "2026-01-01T00:00:00.000Z", "stopped", base);
  db.prepare(
    `INSERT INTO unit_dispatches (
      trace_id, worker_id, milestone_lease_token, milestone_id,
      unit_type, unit_id, status, attempt_n, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "trace-1",
    "worker-1",
    1,
    "M001",
    "complete-milestone",
    "M001",
    "completed",
    1,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:01.000Z",
  );
  appendEvent(base, {
    cmd: "reopen-milestone",
    params: { milestoneId: "M001" },
    ts: "2026-01-01T00:00:02.000Z",
    actor: "agent",
  });

  const issues: any[] = [];
  await checkEngineHealth(worktree, issues, []);

  assert.equal(
    issues.some((issue) => issue.code === "completed_milestone_reopened"),
    false,
    "canonical reopen event should exempt the reopened milestone from doctor drift errors",
  );
});

test("checkEngineHealth treats explicit reopen as authoritative when dispatch timestamps are missing", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "gsd-doctor-reopen-no-dispatch-time-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const gsdDir = join(base, ".gsd");
  mkdirSync(gsdDir, { recursive: true });

  openDatabase(join(gsdDir, "gsd.db"));
  insertMilestone({ id: "M001", title: "Reopened", status: "active" });
  const db = _getAdapter()!;
  db.prepare(
    `INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status, project_root_realpath
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("worker-1", "localhost", 1, "2026-01-01T00:00:00.000Z", "test", "2026-01-01T00:00:00.000Z", "stopped", base);
  db.prepare(
    `INSERT INTO unit_dispatches (
      trace_id, worker_id, milestone_lease_token, milestone_id,
      unit_type, unit_id, status, attempt_n, started_at, ended_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run("trace-1", "worker-1", 1, "M001", "complete-milestone", "M001", "completed", 1, "", "");
  appendEvent(base, {
    cmd: "reopen-milestone",
    params: { milestoneId: "M001" },
    ts: "2026-01-01T00:00:02.000Z",
    actor: "agent",
  });

  const issues: any[] = [];
  await checkEngineHealth(base, issues, []);

  assert.equal(
    issues.some((issue) => issue.code === "completed_milestone_reopened"),
    false,
    "explicit reopen should exempt reopened milestone even when completion dispatch timestamps are absent",
  );
});
