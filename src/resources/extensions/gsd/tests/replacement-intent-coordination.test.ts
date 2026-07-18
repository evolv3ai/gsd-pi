import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  _setDatabaseOpenAfterIntentCheckForTest,
  _setProbeAfterIntentCheckForTest,
  openIsolatedDatabase,
  probeDbWritable,
} from "../db/engine.ts";
import {
  _setBeforeMilestoneStatusObservationWriteForTest,
  beginMilestoneStatusObservationTurn,
} from "../milestone-status-observation-context.ts";

import {
  _getAdapter,
  closeDatabase,
  copyWorktreeDb,
  getDatabaseReplacementPaths,
  getDecisionById,
  insertDecision,
  insertMilestone,
  insertSlice,
  openDatabase,
  reconcileWorktreeDb,
} from "../gsd-db.ts";
import {
  getAutoWorker,
  heartbeatAutoWorker,
  registerAutoWorker,
} from "../db/auto-workers.ts";
import {
  claimNextCommand,
  completeCommand,
  enqueueCommand,
  getCommand,
} from "../db/command-queue.ts";
import {
  claimMilestoneLease,
  getMilestoneLease,
  refreshMilestoneLease,
} from "../db/milestone-leases.ts";
import {
  deleteRuntimeKv,
  getRuntimeKv,
  setRuntimeKv,
} from "../db/runtime-kv.ts";
import {
  getLatestForUnit,
  markCanceled,
  markPaused,
  markRunning,
  recordDispatchClaim,
} from "../db/unit-dispatches.ts";

function makeDatabasePath(prefix: string): { base: string; databasePath: string } {
  const base = mkdtempSync(join(tmpdir(), prefix));
  const databasePath = join(base, ".gsd", "gsd.db");
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return { base, databasePath };
}

function createReplacementIntent(databasePath: string): void {
  const paths = getDatabaseReplacementPaths(databasePath);
  mkdirSync(paths.recoveryDirectory, { recursive: true });
  writeFileSync(paths.activeIntentPath, "{}", { mode: 0o600 });
}

function cleanup(...bases: string[]): void {
  _setDatabaseOpenAfterIntentCheckForTest(null);
  _setProbeAfterIntentCheckForTest(null);
  _setBeforeMilestoneStatusObservationWriteForTest(null);
  try {
    closeDatabase();
  } catch {
    // best effort
  }
  for (const base of bases) {
    rmSync(base, { recursive: true, force: true });
  }
}

test("startup rechecks replacement intent after acquiring its writer lock", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-startup-race-");
  t.after(() => cleanup(base));
  const seed = new DatabaseSync(databasePath);
  seed.exec("PRAGMA journal_mode=DELETE; CREATE TABLE startup_sentinel (value TEXT NOT NULL)");
  seed.close();

  _setDatabaseOpenAfterIntentCheckForTest(() => createReplacementIntent(databasePath));
  assert.throws(
    () => openDatabase(databasePath),
    /Database writes are fenced while replacement intent exists/,
  );

  const observed = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(observed.prepare("PRAGMA journal_mode").get()?.["journal_mode"], "delete");
  assert.equal(observed.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master WHERE name = 'schema_version'
  `).get()?.["count"], 0);
  observed.close();
});

test("schema-current startup remains mutation-free while another writer holds the lock", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-startup-contention-");
  t.after(() => cleanup(base));
  assert.equal(openDatabase(databasePath), true);
  closeDatabase();

  const blocker = new DatabaseSync(databasePath);
  let lockHeld = true;
  blocker.exec("BEGIN IMMEDIATE");
  t.after(() => {
    if (lockHeld) blocker.exec("ROLLBACK");
    blocker.close();
  });

  assert.equal(openDatabase(databasePath), true);
  assert.equal(_getAdapter()!.prepare("SELECT 1 AS value").get()?.["value"], 1);
  blocker.exec("ROLLBACK");
  lockHeld = false;
});

test("writability probe rechecks replacement intent after acquiring its writer lock", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-probe-race-");
  t.after(() => cleanup(base));
  assert.equal(openDatabase(databasePath), true);

  _setProbeAfterIntentCheckForTest(() => createReplacementIntent(databasePath));
  const result = probeDbWritable();
  assert.equal(result.ok, false);
  assert.match(result.detail ?? "", /Database writes are fenced while replacement intent exists/);
});

test("isolated observation handles reject writes", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-read-only-observer-");
  t.after(() => cleanup(base));
  assert.equal(openDatabase(databasePath), true);
  const observer = openIsolatedDatabase(databasePath);
  assert.ok(observer);
  t.after(() => observer.close());

  assert.equal(observer.prepare("PRAGMA query_only").get()?.["query_only"], 1);
  assert.throws(() => observer.prepare(`
    INSERT INTO runtime_kv (scope, scope_id, key, value_json, updated_at)
    VALUES ('global', '', 'isolated-write', '{}', '2026-07-18T00:00:00.000Z')
  `).run(), /read.?only|readonly/iu);
  assert.equal(
    _getAdapter()!.prepare("SELECT COUNT(*) AS count FROM runtime_kv WHERE key = 'isolated-write'").get()?.["count"],
    0,
  );
});

test("observation soft-state writes use the fenced canonical writer", (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-observation-writer-");
  t.after(() => cleanup(base));
  assert.equal(openDatabase(databasePath), true);
  let injected = false;
  _setBeforeMilestoneStatusObservationWriteForTest(() => {
    if (injected) return;
    injected = true;
    createReplacementIntent(databasePath);
  });

  assert.equal(beginMilestoneStatusObservationTurn(base, {
    mode: "guided",
    sourceRevision: "sha256:startup-race",
  }, { token: "fence" }), null);
  assert.equal(injected, true);
  assert.equal(
    _getAdapter()!.prepare(`
      SELECT COUNT(*) AS count FROM runtime_kv
      WHERE key = 'milestone-status-observation-turn:fence'
    `).get()?.["count"],
    0,
  );
});

function insertTestDecision(id: string): void {
  insertDecision({
    id,
    when_context: "2026-07-18",
    scope: "project",
    decision: `Decision ${id}`,
    choice: id,
    rationale: "replacement fence regression",
    revisable: "yes",
    made_by: "agent",
    superseded_by: null,
  });
}

test("active replacement intent fences coordination mutations before they change rows", async (t) => {
  const { base, databasePath } = makeDatabasePath("gsd-replacement-coordination-");
  t.after(() => cleanup(base));
  openDatabase(databasePath);

  insertMilestone({ id: "M001", title: "Fence", status: "active" });
  for (const sliceId of ["S01", "S02", "S03"]) {
    insertSlice({ id: sliceId, milestoneId: "M001", title: sliceId });
  }
  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) return;

  const commandId = enqueueCommand({ targetWorker: workerId, command: "pause" });
  assert.ok(claimNextCommand(workerId));
  setRuntimeKv("worker", workerId, "cursor", { line: 7 });

  const dispatchIds = ["S01", "S02", "S03"].map((sliceId) => {
    const claim = recordDispatchClaim({
      traceId: `trace-${sliceId}`,
      workerId,
      milestoneLeaseToken: lease.token,
      milestoneId: "M001",
      sliceId,
      unitType: "plan-slice",
      unitId: `M001/${sliceId}`,
    });
    assert.equal(claim.ok, true);
    if (!claim.ok) throw new Error("expected dispatch claim");
    return claim.dispatchId;
  });

  const heartbeatBefore = getAutoWorker(workerId)!.last_heartbeat_at;
  const leaseExpiryBefore = getMilestoneLease("M001")!.expires_at;
  await new Promise((resolve) => setTimeout(resolve, 10));
  createReplacementIntent(databasePath);

  const fenced = /Database writes are fenced while replacement intent exists/;
  assert.throws(() => heartbeatAutoWorker(workerId), fenced);
  assert.throws(() => completeCommand(commandId, workerId, { acknowledged: true }), fenced);
  assert.throws(
    () => refreshMilestoneLease(workerId, "M001", lease.token),
    fenced,
  );
  assert.throws(() => deleteRuntimeKv("worker", workerId, "cursor"), fenced);
  assert.throws(() => markRunning(dispatchIds[0]!), fenced);
  assert.throws(() => markPaused(dispatchIds[1]!), fenced);
  assert.throws(() => markCanceled(dispatchIds[2]!, "replacement"), fenced);

  assert.equal(getAutoWorker(workerId)!.last_heartbeat_at, heartbeatBefore);
  assert.equal(getCommand(commandId)!.completed_at, null);
  assert.equal(getMilestoneLease("M001")!.expires_at, leaseExpiryBefore);
  assert.deepEqual(getRuntimeKv("worker", workerId, "cursor"), { line: 7 });
  for (const sliceId of ["S01", "S02", "S03"]) {
    assert.equal(getLatestForUnit(`M001/${sliceId}`)!.status, "claimed");
  }
});

test("active replacement intent prevents worktree reconciliation from mutating main", (t) => {
  const main = makeDatabasePath("gsd-replacement-reconcile-main-");
  const worktree = makeDatabasePath("gsd-replacement-reconcile-wt-");
  t.after(() => cleanup(main.base, worktree.base));

  openDatabase(main.databasePath);
  insertTestDecision("D001");
  closeDatabase();
  assert.equal(copyWorktreeDb(main.databasePath, worktree.databasePath), true);

  openDatabase(worktree.databasePath);
  insertTestDecision("D002");
  closeDatabase();

  openDatabase(main.databasePath);
  createReplacementIntent(main.databasePath);
  const result = reconcileWorktreeDb(main.databasePath, worktree.databasePath);

  assert.deepEqual(result, {
    decisions: 0,
    requirements: 0,
    artifacts: 0,
    milestones: 0,
    slices: 0,
    tasks: 0,
    memories: 0,
    replan_history: 0,
    assessments: 0,
    quality_gates: 0,
    slice_dependencies: 0,
    verification_evidence: 0,
    gate_runs: 0,
    milestone_commit_attributions: 0,
    conflicts: [],
  });
  assert.equal(getDecisionById("D002"), null);
  assert.deepEqual(
    _getAdapter()!.prepare("PRAGMA database_list").all().map((row) => row["name"]),
    ["main"],
    "worktree database is detached after the fenced transaction",
  );
});
