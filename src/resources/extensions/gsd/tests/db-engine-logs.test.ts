// gsd-pi — DB engine failure-branch log coverage.
//
// `checkpointDatabase` / `closeDatabase` / `vacuumDatabase` in db/engine.ts are
// the highest-frequency runtime paths (called every turn and at closeout).
// Each wraps its destructive PRAGMA in a try/catch that emits a `db` warning so
// a failed checkpoint/vacuum/close never breaks orchestration but is still
// observable. The existing gsd-db tests only assert the *happy* path (WAL gets
// truncated); no test exercises any of these catch branches, so a regression
// that drops or misroutes the warning would pass silently.
//
// This file pins the log output for the three checkpoint/vacuum/close failure
// branches by stubbing the live adapter's `exec`/`close` to throw on demand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync as fsChmodSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { checkpointDatabase, closeDatabase, openDatabase, vacuumDatabase, _getAdapter } from "../gsd-db.ts";
import { backupDatabaseSnapshot, readTransaction } from "../db/engine.ts";
import {
  drainLogs,
  peekLogs,
  setStderrLoggingEnabled,
  _resetLogs,
  type LogEntry,
} from "../workflow-logger.ts";
import type { DbAdapter } from "../db-adapter.ts";

function makeBase(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-db-engine-logs-"));
  mkdirSync(join(dir, ".gsd"), { recursive: true });
  return dir;
}

/** Capture log entries emitted while running fn. Stderr is suppressed. */
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

/**
 * Wrap the live adapter's `exec` so it throws for SQL matching `needle`,
 * delegating everything else to the original. Returns a restore function.
 */
function breakExecOn(adapter: DbAdapter, needle: string): () => void {
  const origExec = adapter.exec.bind(adapter);
  adapter.exec = (sql: string): void => {
    if (sql.includes(needle)) throw new Error(`forced failure for: ${needle}`);
    return origExec(sql);
  };
  return () => {
    adapter.exec = origExec;
  };
}

test("checkpointDatabase logs a `db` warning when the WAL checkpoint throws", () => {
  const base = makeBase();
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  try {
    const adapter = _getAdapter();
    assert.ok(adapter, "an adapter must be open");
    const restore = breakExecOn(adapter!, "wal_checkpoint");

    const { logs } = captureLogs(() => checkpointDatabase());
    restore();

    const dbWarn = logs.find((e) => e.component === "db" && e.severity === "warn");
    assert.ok(dbWarn, "a db warning must be logged on checkpoint failure");
    assert.match(dbWarn!.message, /WAL checkpoint failed/u);
    assert.match(dbWarn!.message, /forced failure for: wal_checkpoint/u);
    // checkpointDatabase must not rethrow — orchestration continues.
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("vacuumDatabase logs a `db` warning when VACUUM throws", () => {
  const base = makeBase();
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  try {
    const adapter = _getAdapter();
    assert.ok(adapter);
    const restore = breakExecOn(adapter!, "VACUUM");

    const { logs } = captureLogs(() => vacuumDatabase());
    restore();

    const dbWarn = logs.find((e) => e.component === "db" && e.severity === "warn");
    assert.ok(dbWarn, "a db warning must be logged on VACUUM failure");
    assert.match(dbWarn!.message, /VACUUM failed/u);
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("closeDatabase logs `db` warnings when WAL checkpoint and close throw on teardown", () => {
  const base = makeBase();
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  const adapter = _getAdapter();
  assert.ok(adapter);
  // Break both the WAL checkpoint and the final close. The incremental_vacuum
  // pragma is left intact so we can assert the checkpoint/close warnings land
  // without the teardown itself exploding mid-way.
  const restoreExec = breakExecOn(adapter!, "wal_checkpoint");
  const origClose = adapter!.close.bind(adapter!);
  adapter!.close = (): void => {
    throw new Error("forced close failure");
  };

  const { logs } = captureLogs(() => closeDatabase());
  restoreExec();
  adapter!.close = origClose;

  try {
    const messages = logs.filter((e) => e.component === "db").map((e) => e.message);
    assert.ok(
      messages.some((m) => /WAL checkpoint failed/u.test(m)),
      "WAL checkpoint failure must be logged during close",
    );
    assert.ok(
      messages.some((m) => /database close failed/u.test(m)),
      "close failure must be logged during close",
    );
    // closeDatabase must fully reset engine state even when teardown steps throw.
    assert.equal(_getAdapter(), null, "engine must release the adapter after a broken close");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});

test("checkpointDatabase and vacuumDatabase are no-ops (and log nothing) when no DB is open", () => {
  _resetLogs();
  const previous = setStderrLoggingEnabled(false);
  try {
    checkpointDatabase();
    vacuumDatabase();
    assert.equal(peekLogs().length, 0, "no-db paths must not emit any logs");
  } finally {
    setStderrLoggingEnabled(previous);
    _resetLogs();
  }
});

test("readTransaction logs a db error when ROLLBACK fails after a read error (split-brain signal)", () => {
  const base = makeBase();
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  const adapter = _getAdapter();
  assert.ok(adapter);
  // Make ROLLBACK throw so the read-failure path invokes the rollback-error
  // callback (engine.ts:768-775), which logs the split-brain error.
  const restore = breakExecOn(adapter!, "ROLLBACK");

  const { logs } = captureLogs(() => {
    assert.throws(
      () => readTransaction(() => {
        throw new Error("read body failed");
      }),
      /read body failed/u,
      "the original read error must still propagate",
    );
  });
  restore();
  closeDatabase();
  try {
    const err = logs.find((e) => e.component === "db" && e.severity === "error");
    assert.ok(err, "a db error must be logged when ROLLBACK fails");
    assert.equal(err!.message, "snapshotState ROLLBACK failed");
    assert.match(err!.context?.error ?? "", /forced failure for: ROLLBACK/u);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("backupDatabaseSnapshot logs a db warning when the snapshot copy fails", () => {
  const base = makeBase();
  const dbPath = join(base, ".gsd", "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  // Make the snapshot destination's parent dir read-only so the copy step
  // inside backupDatabaseSnapshot (mkdirSync(backups) + copyFileSync) fails —
  // exercising the outer catch (engine.ts:726-728). The DB handle stays open,
  // so currentPath is set and the read-only parent only blocks the new copy.
  fsChmodSync(join(base, ".gsd"), 0o555);

  const { result, logs } = captureLogs(() => backupDatabaseSnapshot("test-label"));
  closeDatabase();
  try {
    assert.equal(result, null, "a failed snapshot must return null");
    const warn = logs.find((e) => e.component === "db" && e.severity === "warn");
    assert.ok(warn, "a db warning must be logged on snapshot failure");
    assert.match(warn!.message, /database snapshot failed/u);
  } finally {
    fsChmodSync(join(base, ".gsd"), 0o755);
    rmSync(base, { recursive: true, force: true });
  }
});
