// Project/App: gsd-pi
// File Purpose: Isolated, fresh-process restore rehearsal for verified legacy-import backups.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";

import {
  _verifyLegacyImportBackupArtifactForTest,
  LegacyImportBackupError,
  prepareLegacyImportBackup,
  type LegacyImportVerifiedBackup,
} from "../legacy-import-backup.ts";
import { captureCurrentLegacyImportBaseSnapshot, type LegacyImportBaseSnapshot } from "../legacy-import-preview-base.ts";
import { createLegacyImportPreview, type LegacyImportPreviewArtifact } from "../legacy-import-preview.ts";
import type { LegacyImportSourceRoot } from "../legacy-import-preview-source.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import * as restoreDrill from "../legacy-import-restore-drill.ts";
import { openSqliteReadOnly } from "../sqlite-readonly.ts";

interface DrillInput {
  backup: LegacyImportVerifiedBackup;
  preview: LegacyImportPreviewArtifact;
  base: LegacyImportBaseSnapshot;
}

interface Fixture {
  workspace: string;
  databasePath: string;
  backup: LegacyImportVerifiedBackup;
  input: DrillInput;
  drillParent: string;
  nonce: string;
}

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function lineage(): Record<string, unknown> {
  const db = _getAdapter();
  assert.ok(db);
  const row = db.prepare(`
    SELECT
      (SELECT revision FROM project_authority WHERE singleton = 1) AS revision,
      (SELECT authority_epoch FROM project_authority WHERE singleton = 1) AS authority_epoch,
      (SELECT count(*) FROM milestones) AS milestones,
      (SELECT count(*) FROM slices) AS slices,
      (SELECT count(*) FROM tasks) AS tasks,
      (SELECT count(*) FROM workflow_domain_events) AS events,
      (SELECT count(*) FROM workflow_outbox) AS outbox,
      (SELECT count(*) FROM workflow_projection_work) AS projections,
      (SELECT count(*) FROM workflow_import_applications) AS import_applications,
      total_changes() AS total_changes
  `).get();
  assert.ok(row);
  return row;
}

function fixture(t: TestContext): Fixture {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "gsd-legacy-restore-drill-test-")));
  t.after(() => {
    closeDatabase();
    rmSync(workspace, { recursive: true, force: true });
  });
  const sourceRoot = join(workspace, "legacy", ".gsd");
  const destination = join(workspace, "backups");
  const drillParent = join(workspace, "drills");
  const databasePath = join(workspace, "live.sqlite");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(destination);
  mkdirSync(drillParent);
  writeFileSync(join(sourceRoot, "STATE.md"), "# State\n\nApproved legacy narrative.\n");
  assert.equal(openDatabase(databasePath), true);
  const db = _getAdapter();
  assert.ok(db);
  const nonce = `restore-${process.pid}-${Date.now()}`;
  db.prepare("INSERT INTO milestones(id, title, sequence) VALUES (?, ?, 1)").run("M900", nonce);
  db.prepare("INSERT INTO slices(milestone_id, id, title, sequence) VALUES ('M900', 'S01', ?, 1)").run(nonce);
  db.prepare("INSERT INTO tasks(milestone_id, slice_id, id, title, sequence) VALUES ('M900', 'S01', 'T01', ?, 1)").run(nonce);
  const roots: readonly LegacyImportSourceRoot[] = [{
    id: "legacy-project-gsd",
    kind: "project",
    physical_path: sourceRoot,
    logical_path: ".gsd",
    presence: "required",
  }];
  const base = captureCurrentLegacyImportBaseSnapshot();
  const preview = createLegacyImportPreview({ roots });
  const backup = prepareLegacyImportBackup({
    preview,
    base,
    roots,
    destination_directory: destination,
    label: "before-import",
  });
  return {
    workspace,
    databasePath,
    backup,
    input: { backup, preview, base },
    drillParent,
    nonce,
  };
}

function api(): (input: DrillInput) => Readonly<Record<string, unknown>> {
  const boundary = (restoreDrill as unknown as {
    drillLegacyImportBackupRestore?: (input: DrillInput) => Readonly<Record<string, unknown>>;
  }).drillLegacyImportBackupRestore;
  assert.ok(boundary, "legacy import backup restore drill boundary must be implemented");
  return boundary;
}

function testApi(): (
  input: DrillInput,
  dependencies: Record<string, unknown>,
) => Readonly<Record<string, unknown>> {
  const boundary = (restoreDrill as unknown as {
    _drillLegacyImportBackupRestoreForTest?: (
      input: DrillInput,
      dependencies: Record<string, unknown>,
    ) => Readonly<Record<string, unknown>>;
  })._drillLegacyImportBackupRestoreForTest;
  assert.ok(boundary, "legacy import backup restore drill test seam must be implemented");
  return boundary;
}

function makeDrillDirectory(parent: string): string {
  const path = realpathSync(mkdtempSync(join(parent, ".restore-drill-")));
  chmodSync(path, 0o700);
  return path;
}

function expectedResult(fixture: Fixture): Readonly<Record<string, unknown>> {
  return {
    backup_id: fixture.backup.backup_id,
    backup_sha256: fixture.backup.backup_sha256,
    backup_byte_size: fixture.backup.backup_byte_size,
    quick_check: "ok",
    integrity_check: "ok",
    foreign_key_violations: 0,
    representative_queries: "ok",
  };
}

describe("legacy import backup restore drill", () => {
  test("restores distinct bytes, verifies them in a fresh process, cleans state, and leaves live authority untouched", (t) => {
    const state = fixture(t);
    const liveHash = sha256(state.databasePath);
    const backupHash = sha256(state.backup.backup_ref);
    const before = lineage();
    let childEvidence: Record<string, unknown> | undefined;

    const result = testApi()(state.input, {
      makeDrillDirectory: () => makeDrillDirectory(state.drillParent),
      boundary(name: string, detail?: Record<string, unknown>) {
        if (name === "after-fresh-process-verification") childEvidence = detail;
      },
    });

    assert.deepEqual(result, expectedResult(state));
    assert.equal(Object.isFrozen(result), true);
    assert.ok(childEvidence);
    assert.equal(typeof childEvidence["pid"], "number");
    assert.notEqual(childEvidence["pid"], process.pid);
    assert.equal(childEvidence["opened_path"], childEvidence["isolated_path"]);
    assert.equal(childEvidence["representative_queries"], "ok");
    assert.deepEqual(readdirSync(state.drillParent), []);
    assert.equal(sha256(state.databasePath), liveHash);
    assert.equal(sha256(state.backup.backup_ref), backupHash);
    assert.deepEqual(lineage(), before);
  });

  test("rejects forged, corrupt, and sidecar-contaminated artifacts before staging", (t) => {
    const state = fixture(t);
    let drillCreates = 0;
    const dependencies = {
      makeDrillDirectory() {
        drillCreates += 1;
        return makeDrillDirectory(state.drillParent);
      },
    };
    assert.throws(
      () => testApi()({
        ...state.input,
        backup: { ...state.backup, backup_id: `sha256:${"0".repeat(64)}` },
      }, dependencies),
      LegacyImportBackupError,
    );
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = `${state.backup.backup_ref}${suffix}`;
      writeFileSync(sidecar, "not SQLite state");
      assert.throws(() => testApi()(state.input, dependencies), LegacyImportBackupError);
      unlinkSync(sidecar);
    }
    writeFileSync(state.backup.backup_ref, "corrupt backup bytes");
    assert.throws(() => testApi()(state.input, dependencies), LegacyImportBackupError);
    assert.equal(drillCreates, 0);
    assert.deepEqual(readdirSync(state.drillParent), []);
  });

  test("verifies the isolated restored database rather than reopening the source backup", (t) => {
    const state = fixture(t);
    const backupHash = sha256(state.backup.backup_ref);
    assert.throws(
      () => testApi()(state.input, {
        makeDrillDirectory: () => makeDrillDirectory(state.drillParent),
        boundary(name: string, detail?: Record<string, unknown>) {
          if (name !== "after-publish") return;
          const path = detail?.["isolated_path"];
          assert.equal(typeof path, "string");
          const bytes = readFileSync(path as string);
          const offset = bytes.indexOf(state.nonce);
          assert.notEqual(offset, -1);
          bytes.fill("x".charCodeAt(0), offset, offset + Buffer.byteLength(state.nonce));
          writeFileSync(path as string, bytes);
        },
      }),
      LegacyImportBackupError,
    );
    assert.deepEqual(readdirSync(state.drillParent), []);
    assert.equal(sha256(state.backup.backup_ref), backupHash);

    for (const suffix of ["-wal", "-shm", "-journal"]) {
      assert.throws(
        () => testApi()(state.input, {
          makeDrillDirectory: () => makeDrillDirectory(state.drillParent),
          boundary(name: string, detail?: Record<string, unknown>) {
            if (name !== "after-fresh-process-verification") return;
            assert.equal(typeof detail?.["isolated_path"], "string");
            writeFileSync(`${detail!["isolated_path"]}${suffix}`, "injected sidecar");
          },
        }),
        LegacyImportBackupError,
      );
      assert.deepEqual(readdirSync(state.drillParent), []);
    }
  });

  test("fresh artifact verification observes the opened path and executes canonical row queries", (t) => {
    const state = fixture(t);
    const queries: string[] = [];
    const verification = _verifyLegacyImportBackupArtifactForTest(state.input, {
      openReadOnly(path) {
        const connection = openSqliteReadOnly(path);
        return {
          ...connection,
          db: {
            exec: (sql) => connection.db.exec(sql),
            prepare(sql) {
              queries.push(sql);
              return connection.db.prepare(sql);
            },
            close: () => connection.db.close(),
          },
        };
      },
    });
    assert.equal(verification.opened_path, state.backup.backup_ref);
    assert.ok(queries.some((sql) => sql === "PRAGMA database_list"));
    for (const table of ["milestones", "slices", "tasks"]) {
      assert.ok(queries.some((sql) => sql.includes(`FROM ${table}`)), `missing observed ${table} query`);
    }
  });

  test("fails loud and cleans catchable stage and cleanup failures", (t) => {
    const state = fixture(t);
    assert.throws(
      () => testApi()(state.input, {
        makeDrillDirectory: () => makeDrillDirectory(state.drillParent),
        boundary(name: string) {
          if (name === "after-stage") throw new Error("injected stage failure");
        },
      }),
      /injected stage failure/,
    );
    assert.deepEqual(readdirSync(state.drillParent), []);

    assert.throws(
      () => testApi()(state.input, {
        makeDrillDirectory: () => makeDrillDirectory(state.drillParent),
        boundary(name: string, detail?: Record<string, unknown>) {
          if (name !== "after-flush") return;
          const stagingPath = detail?.["staging_path"];
          assert.equal(typeof stagingPath, "string");
          unlinkSync(stagingPath as string);
          linkSync(state.backup.backup_ref, stagingPath as string);
        },
      }),
      LegacyImportBackupError,
    );
    assert.deepEqual(readdirSync(state.drillParent), []);

    // The drill body failure stays primary; the cleanup failure must be
    // chained as its cause rather than silently discarding the original.
    assert.throws(
      () => testApi()(state.input, {
        makeDrillDirectory: () => makeDrillDirectory(state.drillParent),
        boundary(name: string) {
          if (name === "after-stage") throw new Error("original failure");
        },
        removeDrillDirectory() {
          throw new Error("injected cleanup failure");
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /original failure/);
        const cleanupCause = error.cause;
        assert.ok(cleanupCause instanceof LegacyImportBackupError);
        assert.equal(
          (cleanupCause as LegacyImportBackupError).code,
          "LEGACY_IMPORT_BACKUP_STAGING_CLEANUP_FAILED",
        );
        assert.equal((cleanupCause as LegacyImportBackupError).stage, "cleanup");
        return true;
      },
    );

    assert.throws(
      () => testApi()(state.input, {
        makeDrillDirectory: () => makeDrillDirectory(state.drillParent),
        removeDrillDirectory() {
          throw new Error("injected cleanup failure");
        },
      }),
      (error: unknown) => error instanceof LegacyImportBackupError
        && error.code === "LEGACY_IMPORT_BACKUP_STAGING_CLEANUP_FAILED",
    );
  });

  test("drill start sweeps only stale exact-prefix residue directories", (t) => {
    const state = fixture(t);
    const sweep = (restoreDrill as unknown as {
      _sweepStaleRestoreDrillDirectoriesForTest?: (root: string, nowMs: number) => void;
    })._sweepStaleRestoreDrillDirectoriesForTest;
    assert.ok(sweep, "restore drill residue janitor test seam must be implemented");

    const now = Date.now();
    const staleTime = new Date(now - 25 * 60 * 60 * 1000);
    const staleDir = join(state.drillParent, "gsd-legacy-import-restore-drill-stale");
    const freshDir = join(state.drillParent, "gsd-legacy-import-restore-drill-fresh");
    const foreignDir = join(state.drillParent, "unrelated-residue");
    const prefixFile = join(state.drillParent, "gsd-legacy-import-restore-drill-file");
    mkdirSync(staleDir);
    writeFileSync(join(staleDir, "restore-stage.sqlite"), "crashed drill residue");
    mkdirSync(freshDir);
    mkdirSync(foreignDir);
    writeFileSync(prefixFile, "not a directory");
    utimesSync(staleDir, staleTime, staleTime);
    utimesSync(prefixFile, staleTime, staleTime);

    sweep(state.drillParent, now);

    assert.equal(existsSync(staleDir), false, "stale drill residue must be swept");
    assert.equal(existsSync(freshDir), true, "a live drill directory must survive");
    assert.equal(existsSync(foreignDir), true, "foreign entries must survive");
    assert.equal(existsSync(prefixFile), true, "a non-directory entry must survive");

    if (process.platform !== "win32") {
      const prefixLink = join(state.drillParent, "gsd-legacy-import-restore-drill-link");
      symlinkSync(foreignDir, prefixLink, "dir");
      sweep(state.drillParent, now);
      assert.equal(existsSync(prefixLink), true, "a symbolic link must never be swept");
      unlinkSync(prefixLink);
    }
  });

  test("real SIGKILL leaves at most private residue and a fresh invocation still converges", {
    concurrency: false,
  }, (t) => {
    const state = fixture(t);
    const worker = join(
      process.cwd(),
      "src/resources/extensions/gsd/tests/fixtures/legacy-import-restore-drill-worker.ts",
    );
    const resolver = join(process.cwd(), "src/resources/extensions/gsd/tests/resolve-ts.mjs");
    const backupHash = sha256(state.backup.backup_ref);
    const liveHash = sha256(state.databasePath);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;

    for (const boundary of [
      "after-stage",
      "after-flush",
      "after-publish",
      "after-fresh-process-verification",
      "after-cleanup",
    ]) {
      const child = spawnSync(process.execPath, [
        "--import",
        resolver,
        "--experimental-strip-types",
        worker,
      ], {
        cwd: process.cwd(),
        env,
        input: JSON.stringify({ input: state.input, drillParent: state.drillParent, boundary }),
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(child.status, null, child.stderr || child.stdout);
      assert.equal(child.signal, "SIGKILL", child.stderr || child.stdout);
      const residue = readdirSync(state.drillParent);
      for (const entry of residue) {
        assert.match(entry, /^\.restore-drill-/);
      }
      assert.deepEqual(api()(state.input), expectedResult(state));
      assert.deepEqual(readdirSync(state.drillParent), residue);
      assert.equal(sha256(state.backup.backup_ref), backupHash);
      assert.equal(sha256(state.databasePath), liveHash);
    }
    assert.equal(existsSync(state.backup.backup_ref), true);
  });
});
