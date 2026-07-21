// Project/App: gsd-pi
// File Purpose: Verified legacy-import backup v1 contract and fail-closed validation tests.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test, type TestContext } from "node:test";

import {
  LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
  type LegacyImportPreviewSource,
  type LegacyImportSha256,
} from "../legacy-import-contract.ts";
import {
  captureCurrentLegacyImportBaseSnapshot,
  LegacyImportBaseSnapshotError,
  type LegacyImportBaseSnapshot,
} from "../legacy-import-preview-base.ts";
import { createDbAdapter, type DbAdapter, type DbStatement } from "../db-adapter.ts";
import {
  createLegacyImportPreview,
  hashLegacyImportBytes,
  hashLegacyImportValue,
  revalidateLegacyImportPreview,
  sealLegacyImportPreview,
  type LegacyImportPreviewArtifact,
} from "../legacy-import-preview.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import {
  _prepareLegacyImportBackupForTest,
  _prepareLegacyImportBackupPreflightForTest,
  createLegacyImportBackupSnapshot,
  isValidLegacyImportVerifiedBackup,
  LegacyImportBackupError,
  prepareLegacyImportBackupPreflight,
  sealLegacyImportVerifiedBackup,
  validateLegacyImportVerifiedBackup,
  verifyLegacyImportBackupSnapshot,
  type LegacyImportBackupPreparationDependencies,
  type LegacyImportVerifiedBackup,
  type LegacyImportVerifiedBackupExpected,
  type LegacyImportVerifiedBackupSealInput,
  type LegacyImportBackupSnapshot,
  type LegacyImportBackupSnapshotDependencies,
} from "../legacy-import-backup.ts";
import * as legacyImportBackup from "../legacy-import-backup.ts";
import {
  validateLegacyImportSourceRoots,
  type LegacyImportSourceRoot,
} from "../legacy-import-preview-source.ts";
import { processStartIdentity } from "../process-start-identity.ts";
import { openSqliteReadOnly, SqliteReadOnlyConfigurationError } from "../sqlite-readonly.ts";

const EMPTY_HASH = hashLegacyImportValue([]);
const BACKUP_HASH = `sha256:${"b".repeat(64)}` as LegacyImportSha256;
const TOP_LEVEL_KEYS = [
  "verified_backup_schema_version",
  "backup_id",
  "preview_id",
  "preview_hash",
  "preview_schema_version",
  "import_kind",
  "importer_version",
  "source_set_hash",
  "source_count",
  "source_fingerprints",
  "project_id",
  "project_root_realpath",
  "backup_database_schema_version",
  "base_project_revision",
  "base_authority_epoch",
  "relevant_rows_hash",
  "backup_ref",
  "backup_sha256",
  "backup_byte_size",
  "quick_check",
  "integrity_check",
  "foreign_key_violations",
  "verified_at",
] as const;
const SOURCE_FINGERPRINT_KEYS = ["source_id", "path", "kind", "byte_size", "sha256"] as const;

function source(sourceId: string, path: string, shaDigit: string): LegacyImportPreviewSource {
  return {
    source_id: hashLegacyImportValue(sourceId),
    path,
    kind: "markdown",
    byte_size: 4,
    sha256: `sha256:${shaDigit.repeat(64)}`,
    parser_id: "planning",
    parser_version: "1",
    encoding: "utf-8",
    outcome: "preserved",
  };
}

function baseSnapshot(projectRootRealpath = "/workspace/project-1"): LegacyImportBaseSnapshot {
  return {
    snapshot_schema_version: 1,
    database_schema_version: LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
    authority: {
      singleton: 1,
      project_id: "project-1",
      project_root_realpath: projectRootRealpath,
      revision: 7,
      authority_epoch: 2,
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-15T00:00:00.000Z",
    },
    rows: [],
    relevant_rows_hash: EMPTY_HASH,
  };
}

function previewArtifact(
  base = baseSnapshot(),
  sources: readonly LegacyImportPreviewSource[] = [
    source("source-a", ".gsd/PROJECT.md", "1"),
    source("source-b", ".gsd/STATE.md", "2"),
  ],
): LegacyImportPreviewArtifact {
  return sealLegacyImportPreview({
    import_kind: "legacy-markdown",
    importer_version: "1",
    base,
    source_set_hash: hashLegacyImportValue(sources),
    change_set_hash: EMPTY_HASH,
    counts: { create: 0, update: 0, delete: 0, preserve: 0, unparsed: 0, unresolved: 0 },
    sources,
    changes: [],
    diagnoses: [],
    resolutions: [],
  });
}

function sealInput(): LegacyImportVerifiedBackupSealInput {
  const base = baseSnapshot();
  return {
    preview: previewArtifact(base),
    base,
    backup_ref: "/backups/project-1/legacy-import-backup.sqlite",
    backup_sha256: BACKUP_HASH,
    backup_byte_size: 4096,
    quick_check: "ok",
    integrity_check: "ok",
    foreign_key_violations: 0,
    verified_at: "2026-07-16T12:34:56.789Z",
  };
}

function sealedFixture(): {
  backup: LegacyImportVerifiedBackup;
  base: LegacyImportBaseSnapshot;
  preview: LegacyImportPreviewArtifact;
} {
  const input = sealInput();
  return {
    backup: sealLegacyImportVerifiedBackup(input),
    base: input.base,
    preview: input.preview,
  };
}

function recomputeBackupId(value: LegacyImportVerifiedBackup): LegacyImportSha256 {
  const {
    backup_id: _backupId,
    backup_ref: _backupRef,
    verified_at: _verifiedAt,
    ...identity
  } = value;
  return hashLegacyImportValue(identity);
}

function expectInvalid(
  value: unknown,
  preview: LegacyImportPreviewArtifact,
  base: LegacyImportBaseSnapshot,
  code: "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID" | "LEGACY_IMPORT_BACKUP_IDENTITY_MISMATCH",
): void {
  assert.throws(
    () => validateLegacyImportVerifiedBackup(value, { preview, base }),
    (error: unknown) => error instanceof LegacyImportBackupError
      && error.stage === "contract"
      && error.code === code
      && !error.retryable
      && Object.isFrozen(error.context),
  );
}

describe("legacy import backup contract", () => {
  test("recognizes only complete self-identical verified backup artifacts", () => {
    const { backup } = sealedFixture();
    const missing = structuredClone(backup) as unknown as Record<string, unknown>;
    delete missing["backup_sha256"];
    const forgedId = structuredClone(backup);
    forgedId.backup_id = `sha256:${"0".repeat(64)}`;
    const nonEnumerableRequiredField = structuredClone(backup);
    Object.defineProperty(nonEnumerableRequiredField, "project_id", {
      value: backup.project_id,
      enumerable: false,
    });
    nonEnumerableRequiredField.backup_id = recomputeBackupId(nonEnumerableRequiredField);
    const relocated = structuredClone(backup);
    relocated.backup_ref = "/relocated/verified.sqlite";
    relocated.verified_at = "2026-07-17T00:00:00.000Z";
    const accessor = structuredClone(backup);
    let accessorReads = 0;
    Object.defineProperty(accessor, "backup_ref", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        return backup.backup_ref;
      },
    });

    assert.equal(isValidLegacyImportVerifiedBackup(backup), true);
    assert.equal(isValidLegacyImportVerifiedBackup(missing), false);
    assert.equal(isValidLegacyImportVerifiedBackup(forgedId), false);
    assert.equal(isValidLegacyImportVerifiedBackup(nonEnumerableRequiredField), false);
    assert.equal(isValidLegacyImportVerifiedBackup(relocated), true);
    assert.equal(isValidLegacyImportVerifiedBackup(accessor), false);
    assert.equal(accessorReads, 0);
  });

  test("seals the exact v1 fields and every required Preview/base/integrity binding", () => {
    const { backup, base, preview } = sealedFixture();

    assert.deepEqual(Object.keys(backup), TOP_LEVEL_KEYS);
    assert.deepEqual(Object.keys(backup.source_fingerprints[0] ?? {}), SOURCE_FINGERPRINT_KEYS);
    assert.equal(backup.verified_backup_schema_version, 1);
    assert.equal(backup.preview_id, preview.preview.preview_id);
    assert.equal(backup.preview_hash, preview.preview_hash);
    assert.equal(backup.preview_schema_version, preview.preview.preview_schema_version);
    assert.equal(backup.import_kind, preview.preview.import_kind);
    assert.equal(backup.importer_version, preview.preview.importer_version);
    assert.equal(backup.source_set_hash, preview.preview.source_set_hash);
    assert.equal(backup.source_count, preview.preview.sources.length);
    assert.deepEqual(
      backup.source_fingerprints,
      preview.preview.sources.map(({ source_id, path, kind, byte_size, sha256 }) => ({
        source_id,
        path,
        kind,
        byte_size,
        sha256,
      })),
    );
    assert.equal(backup.project_id, base.authority.project_id);
    assert.equal(backup.project_root_realpath, base.authority.project_root_realpath);
    assert.equal(backup.backup_database_schema_version, base.database_schema_version);
    assert.equal(backup.base_project_revision, base.authority.revision);
    assert.equal(backup.base_authority_epoch, base.authority.authority_epoch);
    assert.equal(backup.relevant_rows_hash, base.relevant_rows_hash);
    assert.equal(backup.backup_ref, "/backups/project-1/legacy-import-backup.sqlite");
    assert.equal(backup.backup_sha256, BACKUP_HASH);
    assert.equal(backup.backup_byte_size, 4096);
    assert.equal(backup.quick_check, "ok");
    assert.equal(backup.integrity_check, "ok");
    assert.equal(backup.foreign_key_violations, 0);
    assert.equal(backup.verified_at, "2026-07-16T12:34:56.789Z");
    assert.match(backup.backup_id, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(backup.backup_id, recomputeBackupId(backup));
    assert.deepEqual(validateLegacyImportVerifiedBackup(backup, { preview, base }), backup);
  });

  test("derives stable content and approval-lineage identity without time or backup location", () => {
    const input = sealInput();
    const original = sealLegacyImportVerifiedBackup(input);
    const later = sealLegacyImportVerifiedBackup({
      ...input,
      backup_ref: "/backups/project-1/moved-after-restart.sqlite",
      verified_at: "2026-07-17T00:00:00.000Z",
    });
    assert.equal(later.backup_id, original.backup_id);

    const changedBytes = sealLegacyImportVerifiedBackup({
      ...input,
      backup_sha256: `sha256:${"c".repeat(64)}`,
    });
    const changedSize = sealLegacyImportVerifiedBackup({ ...input, backup_byte_size: 8192 });
    const changedBase = {
      ...input.base,
      authority: { ...input.base.authority, project_id: "project-2" },
    };
    const changedProject = sealLegacyImportVerifiedBackup({
      ...input,
      base: changedBase,
      preview: previewArtifact(changedBase),
    });
    const changedSources = [
      source("source-a", ".gsd/PROJECT.md", "1"),
      source("source-b", ".gsd/STATE.md", "9"),
    ];
    const changedSourceSet = sealLegacyImportVerifiedBackup({
      ...input,
      preview: previewArtifact(input.base, changedSources),
    });

    assert.notEqual(changedBytes.backup_id, original.backup_id);
    assert.notEqual(changedSize.backup_id, original.backup_id);
    assert.notEqual(changedProject.backup_id, original.backup_id);
    assert.notEqual(changedSourceSet.backup_id, original.backup_id);
  });

  test("returns a detached, recursively frozen artifact and leaves caller input mutable", () => {
    const input = sealInput();
    const backup = sealLegacyImportVerifiedBackup(input);

    assert.equal(Object.isFrozen(backup), true);
    assert.equal(Object.isFrozen(backup.source_fingerprints), true);
    assert.equal(Object.isFrozen(backup.source_fingerprints[0]), true);
    input.backup_ref = "changed-after-seal.sqlite";
    input.preview = previewArtifact(input.base);
    assert.equal(backup.backup_ref, "/backups/project-1/legacy-import-backup.sqlite");

    const serialized = structuredClone(backup);
    const validated = validateLegacyImportVerifiedBackup(serialized, {
      preview: previewArtifact(input.base),
      base: input.base,
    });
    assert.notEqual(validated, serialized);
    assert.equal(Object.isFrozen(validated), true);
    assert.equal(Object.isFrozen(validated.source_fingerprints), true);
    serialized.backup_ref = "mutated-after-validation.sqlite";
    assert.equal(validated.backup_ref, backup.backup_ref);
  });

  test("snapshots expected Preview lineage once before validation", () => {
    const { backup, base, preview } = sealedFixture();
    const forged = structuredClone(preview);
    Object.assign(forged, { unexpected: true });
    let previewReads = 0;
    const expected = {
      base,
      get preview() {
        return ++previewReads === 1 ? preview : forged;
      },
    } as LegacyImportVerifiedBackupExpected;

    assert.deepEqual(validateLegacyImportVerifiedBackup(backup, expected), backup);
    assert.equal(previewReads, 1);
  });
});

describe("legacy import backup failure", () => {
  test("rejects missing, extra, non-plain, sparse, and malformed nested contract values", () => {
    const { backup, base, preview } = sealedFixture();
    const missing = structuredClone(backup) as unknown as Record<string, unknown>;
    delete missing["backup_sha256"];
    const extra = { ...structuredClone(backup), unexpected: true };
    const extraSource = structuredClone(backup);
    Object.assign(extraSource.source_fingerprints[0]!, { unexpected: true });
    const symbolKey = structuredClone(backup);
    Object.assign(symbolKey, { [Symbol("unexpected")]: true });
    const changingRef = structuredClone(backup);
    let refReads = 0;
    Object.defineProperty(changingRef, "backup_ref", {
      enumerable: true,
      get: () => (++refReads === 1 ? backup.backup_ref : " "),
    });
    const sparseSources = structuredClone(backup);
    delete sparseSources.source_fingerprints[0];

    for (const malformed of [
      null,
      [],
      new Date(),
      missing,
      extra,
      extraSource,
      symbolKey,
      changingRef,
      sparseSources,
    ]) {
      expectInvalid(malformed, preview, base, "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID");
    }
  });

  test("rejects malformed hashes, counts, refs, integrity results, and non-canonical time", () => {
    const { backup, base, preview } = sealedFixture();
    const mutations: readonly ((value: LegacyImportVerifiedBackup) => void)[] = [
      (value) => { value.backup_id = "sha256:ABC" as LegacyImportSha256; },
      (value) => { value.preview_hash = "sha256:not-hex" as LegacyImportSha256; },
      (value) => { value.source_set_hash = `sha256:${"A".repeat(64)}` as LegacyImportSha256; },
      (value) => { value.relevant_rows_hash = "" as LegacyImportSha256; },
      (value) => { value.backup_sha256 = `sha256:${"1".repeat(63)}` as LegacyImportSha256; },
      (value) => { value.source_count += 1; },
      (value) => { value.backup_byte_size = 0; },
      (value) => { value.backup_ref = " "; },
      (value) => { (value as { quick_check: string }).quick_check = "OK"; },
      (value) => { (value as { integrity_check: string }).integrity_check = "database is corrupt"; },
      (value) => { (value as { foreign_key_violations: number }).foreign_key_violations = 1; },
      (value) => { value.verified_at = "2026-07-16 12:34:56"; },
      (value) => { value.verified_at = "2026-07-16T07:34:56.789-05:00"; },
      (value) => { value.verified_at = "2026-02-30T00:00:00.000Z"; },
    ];

    for (const mutate of mutations) {
      const malformed = structuredClone(backup);
      mutate(malformed);
      expectInvalid(malformed, preview, base, "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID");
    }
  });

  test("rejects reordered or forged source fingerprints even with a recomputed backup_id", () => {
    const { backup, base, preview } = sealedFixture();
    const reordered = structuredClone(backup);
    reordered.source_fingerprints.reverse();
    reordered.backup_id = recomputeBackupId(reordered);
    expectInvalid(reordered, preview, base, "LEGACY_IMPORT_BACKUP_IDENTITY_MISMATCH");

    const forged = structuredClone(backup);
    forged.source_fingerprints[0]!.sha256 = `sha256:${"9".repeat(64)}`;
    forged.backup_id = recomputeBackupId(forged);
    expectInvalid(forged, preview, base, "LEGACY_IMPORT_BACKUP_IDENTITY_MISMATCH");
  });

  test("rejects forged Preview and base lineage even after backup_id is recomputed", () => {
    const { backup, base, preview } = sealedFixture();
    const forgeries = [
      (value: LegacyImportVerifiedBackup) => { value.preview_id = `sha256:${"9".repeat(64)}`; },
      (value: LegacyImportVerifiedBackup) => { value.preview_hash = `sha256:${"8".repeat(64)}`; },
      (value: LegacyImportVerifiedBackup) => { value.base_project_revision += 1; },
      (value: LegacyImportVerifiedBackup) => { value.base_authority_epoch += 1; },
      (value: LegacyImportVerifiedBackup) => { value.project_id = "project-forged"; },
      (value: LegacyImportVerifiedBackup) => { value.relevant_rows_hash = `sha256:${"7".repeat(64)}`; },
    ];

    for (const forge of forgeries) {
      const forged = structuredClone(backup);
      forge(forged);
      forged.backup_id = recomputeBackupId(forged);
      expectInvalid(forged, preview, base, "LEGACY_IMPORT_BACKUP_IDENTITY_MISMATCH");
    }
  });

  test("rejects a forged backup_id while accepting a later canonical verified_at", () => {
    const { backup, base, preview } = sealedFixture();
    const forged = structuredClone(backup);
    forged.backup_id = `sha256:${"0".repeat(64)}`;
    expectInvalid(forged, preview, base, "LEGACY_IMPORT_BACKUP_IDENTITY_MISMATCH");

    const later = structuredClone(backup);
    later.verified_at = "2026-07-17T00:00:00.000Z";
    assert.equal(
      validateLegacyImportVerifiedBackup(later, { preview, base }).backup_id,
      backup.backup_id,
    );
  });
});

interface FakeBackupDbOptions {
  checkpointResults?: readonly unknown[];
  dataVersion?: unknown;
  databaseListPath: string;
}

function fakeBackupDb(options: FakeBackupDbOptions): {
  db: DbAdapter;
  calls: { checkpoint: number; dataVersion: number; databaseList: number; exec: number };
} {
  const checkpointResults = [...(options.checkpointResults ?? [{ busy: 0, log: 4, checkpointed: 4 }])];
  const calls = { checkpoint: 0, dataVersion: 0, databaseList: 0, exec: 0 };

  function checkpointRows(): Record<string, unknown>[] {
    calls.checkpoint += 1;
    const result = checkpointResults.shift();
    if (result instanceof Error) throw result;
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    return [result as Record<string, unknown>];
  }

  const db: DbAdapter = {
    exec() {
      calls.exec += 1;
      throw new Error("backup preflight must not execute write-capable SQL");
    },
    prepare(sql): DbStatement {
      const normalized = sql.toLowerCase();
      if (normalized.includes("wal_checkpoint")) {
        return {
          run: () => checkpointRows(),
          get: () => checkpointRows()[0],
          all: () => checkpointRows(),
        };
      }
      if (normalized.includes("database_list")) {
        return {
          run: () => undefined,
          get: () => {
            calls.databaseList += 1;
            return { seq: 0, name: "main", file: options.databaseListPath };
          },
          all: () => {
            calls.databaseList += 1;
            return [{ seq: 0, name: "main", file: options.databaseListPath }];
          },
        };
      }
      if (normalized.includes("data_version")) {
        return {
          run: () => undefined,
          get: () => {
            calls.dataVersion += 1;
            return options.dataVersion === undefined
              ? { data_version: 9 }
              : options.dataVersion as Record<string, unknown>;
          },
          all: () => {
            calls.dataVersion += 1;
            return [options.dataVersion === undefined
              ? { data_version: 9 }
              : options.dataVersion as Record<string, unknown>];
          },
        };
      }
      throw new Error(`unexpected preflight SQL: ${sql}`);
    },
    close() {},
  };
  return { db, calls };
}

function preflightFixture(
  t: TestContext,
  options: Partial<FakeBackupDbOptions> & {
    currentBase?: LegacyImportBaseSnapshot | ((base: LegacyImportBaseSnapshot) => LegacyImportBaseSnapshot);
  } = {},
) {
  const workspace = mkdtempSync(join(tmpdir(), "gsd-legacy-backup-preflight-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const projectRoot = join(workspace, "project");
  const databasePath = join(projectRoot, ".gsd", "gsd.db");
  const sourceRoot = join(projectRoot, ".planning");
  const destinationDirectory = join(projectRoot, ".gsd-backups");
  mkdirSync(dirname(databasePath), { recursive: true });
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(destinationDirectory, { recursive: true });
  writeFileSync(databasePath, "sqlite-placeholder");

  const canonicalProjectRoot = realpathSync(projectRoot);
  const base = baseSnapshot(canonicalProjectRoot);
  const roots: readonly LegacyImportSourceRoot[] = [{
    id: "planning-root",
    kind: "project",
    physical_path: sourceRoot,
    logical_path: ".gsd",
    presence: "required",
  }];
  const preview = previewArtifact(base);
  const approvedRootSetHash = hashLegacyImportValue(validateLegacyImportSourceRoots(roots));
  const fake = fakeBackupDb({
    checkpointResults: options.checkpointResults,
    dataVersion: options.dataVersion,
    databaseListPath: options.databaseListPath ?? databasePath,
  });
  let captureBaseCalls = 0;
  const currentBase = typeof options.currentBase === "function"
    ? options.currentBase(base)
    : options.currentBase ?? base;
  const input = {
    preview,
    base,
    roots,
    destination_directory: destinationDirectory,
    label: "before-legacy-import",
  };
  const dependencies = {
    db: fake.db,
    database_path: databasePath,
    revalidatePreview: (
      observedInput: { roots: readonly LegacyImportSourceRoot[] },
      expected: LegacyImportPreviewArtifact,
    ) => {
      const observedRootSetHash = hashLegacyImportValue(
        validateLegacyImportSourceRoots(observedInput.roots),
      );
      if (observedRootSetHash !== approvedRootSetHash) {
        throw new Error("source roots do not match the approved Preview roots");
      }
      return expected;
    },
    captureBase: () => {
      captureBaseCalls += 1;
      return structuredClone(currentBase);
    },
  };
  return {
    workspace,
    projectRoot,
    databasePath,
    sourceRoot,
    destinationDirectory,
    base,
    preview,
    input,
    dependencies,
    calls: fake.calls,
    captureBaseCalls: () => captureBaseCalls,
  };
}

function expectPreflightError(
  fn: () => unknown,
  expected: {
    stage: string;
    code: string;
    retryable: boolean;
    context?: Readonly<Record<string, unknown>>;
  },
): LegacyImportBackupError {
  let observed: LegacyImportBackupError | undefined;
  assert.throws(fn, (error: unknown) => {
    if (!(error instanceof LegacyImportBackupError)) return false;
    observed = error;
    assert.equal(error.stage, expected.stage);
    assert.equal(error.code, expected.code);
    assert.equal(error.retryable, expected.retryable);
    assert.equal(Object.isFrozen(error.context), true);
    if (expected.context !== undefined) assert.deepEqual(error.context, expected.context);
    return true;
  });
  assert.ok(observed);
  return observed;
}

describe("legacy import backup destination", () => {
  test("returns canonical database/destination identity and detached immutable preflight evidence", (t) => {
    const fixture = preflightFixture(t);
    assert.equal(typeof prepareLegacyImportBackupPreflight, "function");

    const result = _prepareLegacyImportBackupPreflightForTest(fixture.input, fixture.dependencies);
    const databaseStat = statSync(fixture.databasePath);
    const destinationStat = statSync(fixture.destinationDirectory);
    assert.equal(result.database_path, realpathSync(fixture.databasePath));
    assert.deepEqual(result.database_identity, {
      dev: String(databaseStat.dev),
      ino: String(databaseStat.ino),
    });
    assert.equal(result.destination_directory, realpathSync(fixture.destinationDirectory));
    assert.deepEqual(result.destination_directory_identity, {
      dev: String(destinationStat.dev),
      ino: String(destinationStat.ino),
    });
    assert.equal(
      result.destination_path,
      join(realpathSync(fixture.destinationDirectory), "before-legacy-import.sqlite"),
    );
    assert.equal(result.label, "before-legacy-import");
    assert.equal(result.root_set_hash, hashLegacyImportValue(fixture.input.roots));
    assert.deepEqual(result.checkpoint, {
      mode: "wal",
      busy: 0,
      log: 4,
      checkpointed: 4,
      attempts: 1,
    });
    assert.equal(result.data_version, 9);
    assert.deepEqual(result.current_base, fixture.base);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.database_identity), true);
    assert.equal(Object.isFrozen(result.destination_directory_identity), true);
    assert.equal(Object.isFrozen(result.checkpoint), true);
    assert.equal(Object.isFrozen(result.current_base), true);
    assert.equal(fixture.calls.exec, 0);
    fixture.input.label = "changed-after-preflight";
    assert.equal(result.label, "before-legacy-import");
  });

  test("rejects noncanonical, duplicate, empty, or Preview-incomplete root sets before checkpoint", (t) => {
    const fixture = preflightFixture(t);
    const root = fixture.input.roots[0]!;
    const invalidRootSets: readonly (readonly LegacyImportSourceRoot[])[] = [
      [],
      [{ ...root, id: "Not-Canonical" }],
      [{ ...root, physical_path: `${fixture.sourceRoot}/../.planning` }],
      [{ ...root, logical_path: ".gsd/../.gsd" }],
      [root, { ...root }],
      [root, { ...root, id: "other-root", logical_path: ".gsd/nested" }],
      [{ ...root, logical_path: ".planning" }],
    ];

    for (const roots of invalidRootSets) {
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest({ ...fixture.input, roots }, fixture.dependencies),
        {
          stage: "contract",
          code: "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
          retryable: false,
        },
      );
    }
    assert.equal(fixture.calls.checkpoint, 0);
    assert.equal(fixture.captureBaseCalls(), 0);
  });

  test("rejects non-exact or accessor-backed top-level input before checkpoint", (t) => {
    const fixture = preflightFixture(t);
    const missing = { ...fixture.input } as Record<string, unknown>;
    delete missing["label"];
    const extra = { ...fixture.input, extra: true };
    const symbol = { ...fixture.input, [Symbol("extra")]: true };
    let labelReads = 0;
    const changing = { ...fixture.input } as Record<string, unknown>;
    Object.defineProperty(changing, "label", {
      enumerable: true,
      get: () => (++labelReads === 1 ? fixture.input.label : "changed-label"),
    });

    for (const input of [missing, extra, symbol, changing]) {
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(input as never, fixture.dependencies),
        {
          stage: "contract",
          code: "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
          retryable: false,
        },
      );
    }
    assert.equal(fixture.calls.checkpoint, 0);
    assert.equal(fixture.captureBaseCalls(), 0);
  });

  test("rejects unsafe labels before checkpoint or base capture", (t) => {
    const fixture = preflightFixture(t);
    const invalidLabels = [
      "",
      " ",
      ".",
      "..",
      ".hidden",
      "backup.v1",
      "backup/child",
      "backup\\child",
      "back up",
      "UPPERCASE",
      "bäckup",
      "a".repeat(65),
      "backup\0name",
    ];

    for (const label of invalidLabels) {
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(
          { ...fixture.input, label },
          fixture.dependencies,
        ),
        {
          stage: "destination",
          code: "LEGACY_IMPORT_BACKUP_DESTINATION_INVALID",
          retryable: false,
        },
      );
    }
    assert.equal(fixture.calls.checkpoint, 0);
    assert.equal(fixture.captureBaseCalls(), 0);
  });

  test("rejects an existing final file, directory, symlink, dangling symlink, or database hardlink", (t) => {
    const fixture = preflightFixture(t);
    const cases = ["file", "directory", "symlink", "dangling", "hardlink"] as const;

    for (const label of cases) {
      const finalPath = join(fixture.destinationDirectory, `${label}.sqlite`);
      if (label === "file") writeFileSync(finalPath, "existing");
      if (label === "directory") mkdirSync(finalPath);
      if (label === "symlink") symlinkSync(fixture.databasePath, finalPath, "file");
      if (label === "dangling") symlinkSync(join(fixture.workspace, "missing.db"), finalPath, "file");
      if (label === "hardlink") linkSync(fixture.databasePath, finalPath);

      assert.equal(lstatSync(finalPath).isFile(), label === "file" || label === "hardlink");
      const expectedCode = label === "symlink" || label === "hardlink"
        ? "LEGACY_IMPORT_BACKUP_DESTINATION_ALIASES_DATABASE"
        : "LEGACY_IMPORT_BACKUP_DESTINATION_EXISTS";
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(
          { ...fixture.input, label },
          fixture.dependencies,
        ),
        { stage: "destination", code: expectedCode, retryable: false },
      );
    }
  });

  test("rejects source overlap in either direction and through a symlinked parent", (t) => {
    const fixture = preflightFixture(t);
    const insideSource = join(fixture.sourceRoot, "backups");
    mkdirSync(insideSource);
    const containingSource = fixture.projectRoot;
    const sourceChild = join(fixture.sourceRoot, "through-link");
    mkdirSync(sourceChild);
    const linkedParent = join(fixture.workspace, "source-alias");
    symlinkSync(fixture.sourceRoot, linkedParent, process.platform === "win32" ? "junction" : "dir");

    for (const destination_directory of [insideSource, containingSource, join(linkedParent, "through-link")]) {
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(
          { ...fixture.input, destination_directory },
          fixture.dependencies,
        ),
        {
          stage: "destination",
          code: "LEGACY_IMPORT_BACKUP_SOURCE_OVERLAP",
          retryable: false,
        },
      );
    }
  });

  test("rejects an unrelated physical root even when its logical path could hide source overlap", (t) => {
    const fixture = preflightFixture(t);
    const approvedDestination = join(fixture.sourceRoot, "backups");
    const unrelatedRoot = join(fixture.workspace, "unrelated", ".planning");
    mkdirSync(approvedDestination);
    mkdirSync(unrelatedRoot, { recursive: true });

    const roots: readonly LegacyImportSourceRoot[] = [{
      ...fixture.input.roots[0]!,
      physical_path: unrelatedRoot,
    }];
    expectPreflightError(
      () => _prepareLegacyImportBackupPreflightForTest({
        ...fixture.input,
        roots,
        destination_directory: approvedDestination,
      }, fixture.dependencies),
      {
        stage: "contract",
        code: "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
        retryable: false,
      },
    );
    assert.equal(fixture.calls.checkpoint, 0);
    assert.equal(fixture.captureBaseCalls(), 0);
  });

  test("allows a prefix-only source sibling", (t) => {
    const fixture = preflightFixture(t);
    const prefixSibling = `${fixture.sourceRoot}-backups`;
    mkdirSync(prefixSibling);
    const result = _prepareLegacyImportBackupPreflightForTest(
      { ...fixture.input, destination_directory: prefixSibling },
      fixture.dependencies,
    );

    assert.equal(result.destination_directory, realpathSync(prefixSibling));
    assert.equal(result.destination_path, join(realpathSync(prefixSibling), "before-legacy-import.sqlite"));
  });

  test("rejects absent, memory, missing, non-file, and database_list-mismatched databases", (t) => {
    const fixture = preflightFixture(t);
    const missingPath = join(fixture.workspace, "missing.db");
    const directoryPath = join(fixture.workspace, "not-a-database-file");
    mkdirSync(directoryPath);
    const cases = [
      {
        db: null,
        database_path: fixture.databasePath,
        code: "LEGACY_IMPORT_BACKUP_DATABASE_UNAVAILABLE",
      },
      {
        db: fixture.dependencies.db,
        database_path: null,
        code: "LEGACY_IMPORT_BACKUP_DATABASE_UNAVAILABLE",
      },
      {
        db: fixture.dependencies.db,
        database_path: ":memory:",
        code: "LEGACY_IMPORT_BACKUP_DATABASE_UNAVAILABLE",
      },
      {
        db: fixture.dependencies.db,
        database_path: "",
        code: "LEGACY_IMPORT_BACKUP_DATABASE_UNAVAILABLE",
      },
      {
        db: fixture.dependencies.db,
        database_path: missingPath,
        code: "LEGACY_IMPORT_BACKUP_DATABASE_INVALID",
      },
      {
        db: fixture.dependencies.db,
        database_path: directoryPath,
        code: "LEGACY_IMPORT_BACKUP_DATABASE_INVALID",
      },
    ];
    for (const { code, ...dependencies } of cases) {
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(fixture.input, {
          ...fixture.dependencies,
          ...dependencies,
        }),
        { stage: "database", code, retryable: false },
      );
    }

    const mismatch = fakeBackupDb({
      databaseListPath: join(fixture.workspace, "different.db"),
    });
    expectPreflightError(
      () => _prepareLegacyImportBackupPreflightForTest(fixture.input, {
        ...fixture.dependencies,
        db: mismatch.db,
      }),
      {
        stage: "database",
        code: "LEGACY_IMPORT_BACKUP_DATABASE_INVALID",
        retryable: false,
      },
    );
  });

  test("accepts a live database leaf symlink when database_list resolves the same target", (t) => {
    const fixture = preflightFixture(t);
    const target = join(dirname(fixture.databasePath), "live-target.db");
    renameSync(fixture.databasePath, target);
    symlinkSync(target, fixture.databasePath, "file");
    const fake = fakeBackupDb({ databaseListPath: target });

    const result = _prepareLegacyImportBackupPreflightForTest(fixture.input, {
      ...fixture.dependencies,
      db: fake.db,
    });
    const targetStat = statSync(target);
    assert.equal(result.database_path, realpathSync(target));
    assert.deepEqual(result.database_identity, {
      dev: String(targetStat.dev),
      ino: String(targetStat.ino),
    });
  });

  test("rejects destination directory swaps and final-leaf creation during base capture", (t) => {
    const mutations: ReadonlyArray<{
      mutate(fixture: ReturnType<typeof preflightFixture>): void;
      expected: { stage: string; code: string; retryable: boolean };
    }> = [
      {
        mutate(fixture) {
          renameSync(fixture.destinationDirectory, `${fixture.destinationDirectory}.moved`);
          mkdirSync(fixture.destinationDirectory);
        },
        expected: {
          stage: "destination",
          code: "LEGACY_IMPORT_BACKUP_DESTINATION_INVALID",
          retryable: true,
        },
      },
      {
        mutate(fixture) {
          renameSync(fixture.destinationDirectory, `${fixture.destinationDirectory}.moved`);
          symlinkSync(
            fixture.sourceRoot,
            fixture.destinationDirectory,
            process.platform === "win32" ? "junction" : "dir",
          );
        },
        expected: {
          stage: "destination",
          code: "LEGACY_IMPORT_BACKUP_DESTINATION_INVALID",
          retryable: true,
        },
      },
      {
        mutate(fixture) {
          writeFileSync(join(fixture.destinationDirectory, `${fixture.input.label}.sqlite`), "raced");
        },
        expected: {
          stage: "destination",
          code: "LEGACY_IMPORT_BACKUP_DESTINATION_EXISTS",
          retryable: false,
        },
      },
    ];

    for (const { mutate, expected } of mutations) {
      const fixture = preflightFixture(t);
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(fixture.input, {
          ...fixture.dependencies,
          captureBase: () => {
            mutate(fixture);
            return structuredClone(fixture.base);
          },
        }),
        expected,
      );
    }
  });
});

describe("legacy import backup checkpoint", () => {
  test("normalizes accessor-backed database_list, checkpoint, and data_version rows to typed errors", (t) => {
    let checkpointReads = 0;
    const changingCheckpoint = {
      get busy() { return ++checkpointReads === 1 ? 0 : 2; },
      log: 4,
      checkpointed: 4,
    };
    const cases = [
      {
        pragma: "database_list",
        row: { get seq() { throw new Error("database_list getter changed"); }, name: "main", file: "/tmp/db" },
        expected: { stage: "database", code: "LEGACY_IMPORT_BACKUP_DATABASE_INVALID", retryable: false },
      },
      {
        pragma: "wal_checkpoint",
        row: { get busy() { throw new Error("checkpoint getter changed"); }, log: 4, checkpointed: 4 },
        expected: { stage: "checkpoint", code: "LEGACY_IMPORT_BACKUP_CHECKPOINT_INVALID", retryable: false },
      },
      {
        pragma: "wal_checkpoint",
        row: changingCheckpoint,
        expected: { stage: "checkpoint", code: "LEGACY_IMPORT_BACKUP_CHECKPOINT_INVALID", retryable: false },
      },
      {
        pragma: "data_version",
        row: { get data_version() { throw new Error("data_version getter changed"); } },
        expected: { stage: "checkpoint", code: "LEGACY_IMPORT_BACKUP_DATA_VERSION_INVALID", retryable: false },
      },
    ] as const;

    for (const { pragma, row, expected } of cases) {
      const fixture = preflightFixture(t);
      const original = fixture.dependencies.db;
      assert.ok(original);
      const db: DbAdapter = {
        exec: original.exec.bind(original),
        prepare(sql): DbStatement {
          if (!sql.toLowerCase().includes(pragma)) return original.prepare(sql);
          return { run: () => undefined, get: () => row, all: () => [row] } as DbStatement;
        },
        close: original.close.bind(original),
      };
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(fixture.input, { ...fixture.dependencies, db }),
        expected,
      );
    }
  });

  test("accepts exact WAL and rollback-journal success tuples", (t) => {
    const wal = preflightFixture(t, { checkpointResults: [{ busy: 0, log: 7, checkpointed: 7 }] });
    assert.deepEqual(
      _prepareLegacyImportBackupPreflightForTest(wal.input, wal.dependencies).checkpoint,
      { mode: "wal", busy: 0, log: 7, checkpointed: 7, attempts: 1 },
    );

    const rollback = preflightFixture(t, { checkpointResults: [{ busy: 0, log: -1, checkpointed: -1 }] });
    assert.deepEqual(
      _prepareLegacyImportBackupPreflightForTest(rollback.input, rollback.dependencies).checkpoint,
      { mode: "rollback", busy: 0, log: -1, checkpointed: -1, attempts: 1 },
    );
  });

  test("retries only checkpoint busy and never exceeds three attempts", (t) => {
    const succeeds = preflightFixture(t, {
      checkpointResults: [
        { busy: 1, log: 5, checkpointed: 2 },
        { busy: 1, log: 5, checkpointed: 4 },
        { busy: 0, log: 5, checkpointed: 5 },
      ],
    });
    assert.deepEqual(
      _prepareLegacyImportBackupPreflightForTest(succeeds.input, succeeds.dependencies).checkpoint,
      { mode: "wal", busy: 0, log: 5, checkpointed: 5, attempts: 3 },
    );
    assert.equal(succeeds.calls.checkpoint, 3);

    const exhausted = preflightFixture(t, {
      checkpointResults: [
        { busy: 1, log: 5, checkpointed: 2 },
        { busy: 1, log: 5, checkpointed: 3 },
        { busy: 1, log: 5, checkpointed: 4 },
        { busy: 0, log: 5, checkpointed: 5 },
      ],
    });
    expectPreflightError(
      () => _prepareLegacyImportBackupPreflightForTest(exhausted.input, exhausted.dependencies),
      {
        stage: "checkpoint",
        code: "LEGACY_IMPORT_BACKUP_CHECKPOINT_BUSY",
        retryable: true,
        context: { attempts: 3, busy: 1, log: 5, checkpointed: 4 },
      },
    );
    assert.equal(exhausted.calls.checkpoint, 3);
    assert.equal(exhausted.captureBaseCalls(), 0);
  });

  test("fails malformed, coercible, incomplete, and thrown checkpoint results without retry or base capture", (t) => {
    const invalidResults: readonly unknown[] = [
      {},
      { busy: "0", log: "4", checkpointed: "4" },
      { busy: 0.5, log: 4, checkpointed: 4 },
      { busy: 0, log: -2, checkpointed: -2 },
      { busy: 2, log: 4, checkpointed: 4 },
      { busy: 0, log: 4, checkpointed: 3 },
      new Error("checkpoint failed"),
    ];

    for (const checkpointResult of invalidResults) {
      const fixture = preflightFixture(t, { checkpointResults: [checkpointResult] });
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(fixture.input, fixture.dependencies),
        {
          stage: "checkpoint",
          code: "LEGACY_IMPORT_BACKUP_CHECKPOINT_INVALID",
          retryable: false,
        },
      );
      assert.equal(fixture.calls.checkpoint, 1);
      assert.equal(fixture.captureBaseCalls(), 0);
    }
  });

  test("requires a strict non-negative integer data_version", (t) => {
    for (const dataVersion of [
      {},
      { data_version: "9" },
      { data_version: 9.5 },
      { data_version: -1 },
    ]) {
      const fixture = preflightFixture(t, { dataVersion });
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(fixture.input, fixture.dependencies),
        {
          stage: "checkpoint",
          code: "LEGACY_IMPORT_BACKUP_DATA_VERSION_INVALID",
          retryable: false,
        },
      );
      assert.equal(fixture.calls.checkpoint, 1);
      assert.equal(fixture.calls.dataVersion, 1);
      assert.equal(fixture.captureBaseCalls(), 0);
    }
  });

  test("rejects database replacement during checkpoint preflight", (t) => {
    const fixture = preflightFixture(t);
    const originalDb = fixture.dependencies.db;
    assert.ok(originalDb);
    const replacingDb: DbAdapter = {
      exec: originalDb.exec.bind(originalDb),
      prepare(sql): DbStatement {
        const statement = originalDb.prepare(sql);
        if (!sql.toLowerCase().includes("wal_checkpoint")) return statement;
        return {
          run: statement.run.bind(statement),
          all: statement.all.bind(statement),
          get(...params): Record<string, unknown> | undefined {
            const row = statement.get(...params);
            renameSync(fixture.databasePath, `${fixture.databasePath}.moved`);
            writeFileSync(fixture.databasePath, "replacement");
            return row;
          },
        };
      },
      close: originalDb.close.bind(originalDb),
    };

    expectPreflightError(
      () => _prepareLegacyImportBackupPreflightForTest(fixture.input, {
        ...fixture.dependencies,
        db: replacingDb,
      }),
      {
        stage: "database",
        code: "LEGACY_IMPORT_BACKUP_DATABASE_IDENTITY_CHANGED",
        retryable: true,
      },
    );
    assert.equal(fixture.calls.checkpoint, 1);
    assert.equal(fixture.captureBaseCalls(), 1);
  });

  test("treats permanent and unknown base capture failures as non-retryable", (t) => {
    const captures: ReadonlyArray<{
      captureBase(): LegacyImportBaseSnapshot;
      context: Readonly<Record<string, unknown>>;
    }> = [
      {
        captureBase() {
          throw new LegacyImportBaseSnapshotError(
            "LEGACY_IMPORT_BASE_UNSUPPORTED_SCHEMA",
            "unsupported schema",
            { observed_schema_version: 99 },
          );
        },
        context: { capture_error_code: "LEGACY_IMPORT_BASE_UNSUPPORTED_SCHEMA" },
      },
      {
        captureBase() { throw new Error("base capture failed"); },
        context: {},
      },
      {
        captureBase: () => (
          { ...baseSnapshot(), unclonable: () => undefined }
        ) as unknown as LegacyImportBaseSnapshot,
        context: {},
      },
    ];

    for (const { captureBase, context } of captures) {
      const fixture = preflightFixture(t);
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(fixture.input, {
          ...fixture.dependencies,
          captureBase,
        }),
        {
          stage: "base",
          code: "LEGACY_IMPORT_BACKUP_BASE_CAPTURE_FAILED",
          retryable: false,
          context,
        },
      );
    }
  });

  test("rejects every current-base approval drift, including row changes without revision movement", (t) => {
    const changedRows = [{
      row_set: "decisions" as const,
      identity: "D001",
      value: { id: "D001", decision: "drift without authority advance" },
    }];
    const drifts: readonly ((base: LegacyImportBaseSnapshot) => LegacyImportBaseSnapshot)[] = [
      (base) => ({ ...base, snapshot_schema_version: 2 as 1 }),
      (base) => ({
        ...base,
        database_schema_version: 44 as typeof LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION,
      }),
      (base) => ({ ...base, authority: { ...base.authority, project_id: "other-project" } }),
      (base) => ({ ...base, authority: { ...base.authority, project_root_realpath: `${base.authority.project_root_realpath}-moved` } }),
      (base) => ({ ...base, authority: { ...base.authority, revision: base.authority.revision + 1 } }),
      (base) => ({ ...base, authority: { ...base.authority, authority_epoch: base.authority.authority_epoch + 1 } }),
      (base) => ({
        ...base,
        rows: changedRows,
        relevant_rows_hash: hashLegacyImportValue(changedRows),
      }),
    ];

    for (const currentBase of drifts) {
      const fixture = preflightFixture(t, { currentBase });
      expectPreflightError(
        () => _prepareLegacyImportBackupPreflightForTest(fixture.input, fixture.dependencies),
        {
          stage: "base",
          code: "LEGACY_IMPORT_BACKUP_BASE_CHANGED",
          retryable: true,
        },
      );
      assert.equal(fixture.captureBaseCalls(), 1);
    }

    const rowDrift = drifts.at(-1)!(baseSnapshot());
    assert.equal(rowDrift.authority.revision, baseSnapshot().authority.revision);
    assert.equal(rowDrift.authority.authority_epoch, baseSnapshot().authority.authority_epoch);
    assert.notEqual(rowDrift.relevant_rows_hash, baseSnapshot().relevant_rows_hash);
  });
});

type LegacyImportBackupPreflightForTest = ReturnType<
  typeof _prepareLegacyImportBackupPreflightForTest
>;

function createBackupSnapshotForTest(
  preflight: LegacyImportBackupPreflightForTest,
  dependencies: LegacyImportBackupSnapshotDependencies,
): LegacyImportBackupSnapshot {
  const boundary = (
    legacyImportBackup as unknown as {
      _createLegacyImportBackupSnapshotForTest?: (
        input: LegacyImportBackupPreflightForTest,
        dependencies: LegacyImportBackupSnapshotDependencies,
      ) => LegacyImportBackupSnapshot;
    }
  )._createLegacyImportBackupSnapshotForTest;
  assert.ok(boundary, "legacy backup snapshot test boundary must be implemented");
  return boundary(preflight, dependencies);
}

function sha256Bytes(bytes: Uint8Array): LegacyImportSha256 {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

interface FakeSnapshotDbOptions {
  databasePath: string;
  dataVersions?: readonly number[];
  snapshot?(path: string): void;
}

function fakeSnapshotDb(options: FakeSnapshotDbOptions): {
  db: DbAdapter;
  calls: {
    exec: number;
    databaseList: number;
    dataVersion: number;
    vacuum: number;
    vacuumSql: string[];
    vacuumParams: unknown[][];
  };
} {
  const dataVersions = [...(options.dataVersions ?? [9])];
  const calls = {
    exec: 0,
    databaseList: 0,
    dataVersion: 0,
    vacuum: 0,
    vacuumSql: [] as string[],
    vacuumParams: [] as unknown[][],
  };
  const db: DbAdapter = {
    exec() {
      calls.exec += 1;
      throw new Error("backup snapshot must not use exec");
    },
    prepare(sql): DbStatement {
      const normalized = sql.trim().toLowerCase();
      if (normalized === "vacuum into ?") {
        calls.vacuumSql.push(sql);
        return {
          run(...params: unknown[]): unknown {
            calls.vacuum += 1;
            calls.vacuumParams.push(params);
            assert.equal(params.length, 1);
            assert.equal(typeof params[0], "string");
            (options.snapshot ?? ((path: string) => writeFileSync(path, "sqlite-snapshot")))(
              params[0] as string,
            );
            return undefined;
          },
          get: () => undefined,
          all: () => [],
        };
      }
      if (normalized.includes("database_list")) {
        return {
          run: () => undefined,
          get: () => {
            calls.databaseList += 1;
            return { seq: 0, name: "main", file: options.databasePath };
          },
          all: () => [],
        };
      }
      if (normalized.includes("data_version")) {
        return {
          run: () => undefined,
          get: () => {
            calls.dataVersion += 1;
            return { data_version: dataVersions.shift() ?? 9 };
          },
          all: () => [],
        };
      }
      throw new Error(`unexpected snapshot SQL: ${sql}`);
    },
    close() {},
  };
  return { db, calls };
}

function snapshotFixture(
  t: TestContext,
  options: {
    dataVersions?: readonly number[];
    snapshot?(path: string): void;
  } = {},
) {
  const preflightSource = preflightFixture(t);
  const preflight = _prepareLegacyImportBackupPreflightForTest(
    preflightSource.input,
    preflightSource.dependencies,
  );
  const fake = fakeSnapshotDb({
    databasePath: preflightSource.databasePath,
    dataVersions: options.dataVersions,
    snapshot: options.snapshot,
  });
  const dependencies: LegacyImportBackupSnapshotDependencies = {
    db: fake.db,
    database_path: preflightSource.databasePath,
    captureBase: () => structuredClone(preflight.current_base),
    isInTransaction: () => false,
  };
  return { ...preflightSource, preflight, snapshotDb: fake, snapshotDependencies: dependencies };
}

function expectSnapshotError(
  fn: () => unknown,
  expected: {
    stage: string;
    code: string;
    retryable: boolean;
    context?: Readonly<Record<string, unknown>>;
  },
): LegacyImportBackupError {
  return expectPreflightError(fn, expected);
}

function assertNoStagingOrPublish(fixture: ReturnType<typeof snapshotFixture>): void {
  assert.equal(existsSync(fixture.preflight.destination_path), false);
  assert.deepEqual(readdirSync(fixture.destinationDirectory), []);
}

describe("legacy import backup snapshot", () => {
  test("uses one parameter-bound VACUUM INTO and returns one private fixed-child snapshot", (t) => {
    const fixture = snapshotFixture(t);
    const liveBytes = readFileSync(fixture.databasePath);
    assert.equal(typeof createLegacyImportBackupSnapshot, "function");
    const result = createBackupSnapshotForTest(fixture.preflight, fixture.snapshotDependencies);
    const stagingStat = lstatSync(result.staging_path, { bigint: true });
    const stagingDirectoryStat = statSync(result.staging_directory);
    const stagingDirectoryBigStat = lstatSync(result.staging_directory, { bigint: true });

    assert.deepEqual(fixture.snapshotDb.calls.vacuumSql, ["VACUUM INTO ?"]);
    assert.deepEqual(fixture.snapshotDb.calls.vacuumParams, [[result.staging_path]]);
    assert.equal(fixture.snapshotDb.calls.vacuum, 1);
    assert.equal(fixture.snapshotDb.calls.exec, 0);
    assert.equal(basename(result.staging_directory).startsWith("."), true);
    assert.equal(basename(result.staging_path), "snapshot.sqlite");
    assert.equal(dirname(result.staging_path), result.staging_directory);
    assert.notEqual(result.staging_path, fixture.preflight.destination_path);
    assert.deepEqual(readdirSync(result.staging_directory), ["snapshot.sqlite"]);
    assert.equal(stagingDirectoryStat.isDirectory(), true);
    assert.equal(stagingDirectoryStat.mode & 0o077, 0, "private staging directory permissions");
    assert.deepEqual(result.staging_directory_identity, {
      dev: stagingDirectoryBigStat.dev.toString(),
      ino: stagingDirectoryBigStat.ino.toString(),
    });
    assert.equal(stagingStat.isFile(), true);
    assert.equal(stagingStat.isSymbolicLink(), false);
    assert.equal(stagingStat.size > 0n, true);
    assert.deepEqual(result.staging_identity, {
      dev: stagingStat.dev.toString(),
      ino: stagingStat.ino.toString(),
    });
    assert.equal(result.backup_byte_size, Number(stagingStat.size));
    assert.equal(result.backup_sha256, sha256Bytes(readFileSync(result.staging_path)));
    assert.deepEqual(Object.keys(result).sort(), [
      "backup_byte_size",
      "backup_sha256",
      "staging_directory",
      "staging_directory_identity",
      "staging_identity",
      "staging_path",
    ]);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.staging_directory_identity), true);
    assert.equal(Object.isFrozen(result.staging_identity), true);
    assert.equal(existsSync(fixture.preflight.destination_path), false);
    assert.deepEqual(readFileSync(fixture.databasePath), liveBytes);
  });

  test("creates unique unpublished staging directories on independent fresh preflights", (t) => {
    const first = snapshotFixture(t);
    const second = snapshotFixture(t);

    const firstResult = createBackupSnapshotForTest(first.preflight, first.snapshotDependencies);
    const secondResult = createBackupSnapshotForTest(second.preflight, second.snapshotDependencies);

    assert.notEqual(firstResult.staging_directory, secondResult.staging_directory);
    assert.equal(existsSync(first.preflight.destination_path), false);
    assert.equal(existsSync(second.preflight.destination_path), false);
  });

  test("rejects stale database, destination, final leaf, or active transaction before VACUUM", (t) => {
    const cases: ReadonlyArray<{
      mutate(fixture: ReturnType<typeof snapshotFixture>): void;
      dependencies?(fixture: ReturnType<typeof snapshotFixture>): Partial<LegacyImportBackupSnapshotDependencies>;
      expected: { stage: string; code: string; retryable: boolean };
    }> = [
      {
        mutate(fixture) {
          renameSync(fixture.databasePath, `${fixture.databasePath}.moved`);
          writeFileSync(fixture.databasePath, "replacement");
        },
        expected: {
          stage: "database",
          code: "LEGACY_IMPORT_BACKUP_DATABASE_IDENTITY_CHANGED",
          retryable: true,
        },
      },
      {
        mutate(fixture) {
          renameSync(fixture.destinationDirectory, `${fixture.destinationDirectory}.moved`);
          mkdirSync(fixture.destinationDirectory);
        },
        expected: {
          stage: "destination",
          code: "LEGACY_IMPORT_BACKUP_DESTINATION_INVALID",
          retryable: true,
        },
      },
      {
        mutate(fixture) {
          writeFileSync(fixture.preflight.destination_path, "already published");
        },
        expected: {
          stage: "destination",
          code: "LEGACY_IMPORT_BACKUP_DESTINATION_EXISTS",
          retryable: false,
        },
      },
      {
        mutate() {},
        dependencies: () => ({ isInTransaction: () => true }),
        expected: {
          stage: "snapshot",
          code: "LEGACY_IMPORT_BACKUP_SNAPSHOT_TRANSACTION_ACTIVE",
          retryable: false,
        },
      },
    ];

    for (const testCase of cases) {
      const fixture = snapshotFixture(t);
      testCase.mutate(fixture);
      expectSnapshotError(
        () => createBackupSnapshotForTest(fixture.preflight, {
          ...fixture.snapshotDependencies,
          ...testCase.dependencies?.(fixture),
        }),
        testCase.expected,
      );
      assert.equal(fixture.snapshotDb.calls.vacuum, 0);
      assert.equal(
        readdirSync(fixture.destinationDirectory).filter((name) => name.startsWith(".")).length,
        0,
      );
    }
  });

  test("rechecks private staging immediately before VACUUM and cleans injected children", (t) => {
    const fixture = snapshotFixture(t);
    let stagingDirectoryReads = 0;
    fixture.snapshotDependencies.lstat = (path) => {
      const stat = lstatSync(path, { bigint: true });
      if (
        stat.isDirectory()
        && basename(path).includes(".staging-")
      ) {
        stagingDirectoryReads += 1;
        if (stagingDirectoryReads === 2) {
          writeFileSync(join(path, "snapshot.sqlite"), "injected before VACUUM");
        }
      }
      return stat;
    };

    expectSnapshotError(
      () => createBackupSnapshotForTest(fixture.preflight, fixture.snapshotDependencies),
      {
        stage: "snapshot",
        code: "LEGACY_IMPORT_BACKUP_SNAPSHOT_INVALID",
        retryable: false,
      },
    );
    assert.equal(fixture.snapshotDb.calls.vacuum, 0);
    assertNoStagingOrPublish(fixture);
  });

  test("rejects pre-existing or concurrent data/base drift and removes staging", (t) => {
    const preDataDrift = snapshotFixture(t, { dataVersions: [10, 10] });
    expectSnapshotError(
      () => createBackupSnapshotForTest(preDataDrift.preflight, preDataDrift.snapshotDependencies),
      {
        stage: "snapshot",
        code: "LEGACY_IMPORT_BACKUP_SNAPSHOT_CHANGED",
        retryable: true,
        context: { expected_data_version: 9, observed_data_version: 10 },
      },
    );
    assert.equal(preDataDrift.snapshotDb.calls.dataVersion, 2);
    assert.equal(preDataDrift.snapshotDb.calls.vacuum, 0);
    assertNoStagingOrPublish(preDataDrift);

    const preBaseDrift = snapshotFixture(t);
    preBaseDrift.snapshotDependencies.captureBase = () => ({
      ...structuredClone(preBaseDrift.preflight.current_base),
      authority: {
        ...structuredClone(preBaseDrift.preflight.current_base.authority),
        revision: preBaseDrift.preflight.current_base.authority.revision + 1,
      },
    });
    expectSnapshotError(
      () => createBackupSnapshotForTest(preBaseDrift.preflight, preBaseDrift.snapshotDependencies),
      {
        stage: "base",
        code: "LEGACY_IMPORT_BACKUP_BASE_CHANGED",
        retryable: true,
      },
    );
    assert.equal(preBaseDrift.snapshotDb.calls.vacuum, 0);
    assertNoStagingOrPublish(preBaseDrift);

    for (const dataVersions of [[9, 9, 10, 10], [9, 9, 9, 10]] as const) {
      const concurrentDataDrift = snapshotFixture(t, { dataVersions });
      expectSnapshotError(
        () => createBackupSnapshotForTest(
          concurrentDataDrift.preflight,
          concurrentDataDrift.snapshotDependencies,
        ),
        {
          stage: "snapshot",
          code: "LEGACY_IMPORT_BACKUP_SNAPSHOT_CHANGED",
          retryable: true,
          context: { expected_data_version: 9, observed_data_version: 10 },
        },
      );
      assert.equal(concurrentDataDrift.snapshotDb.calls.dataVersion, 4);
      assert.equal(concurrentDataDrift.snapshotDb.calls.vacuum, 1);
      assertNoStagingOrPublish(concurrentDataDrift);
    }

    const postBaseDrift = snapshotFixture(t);
    let captures = 0;
    postBaseDrift.snapshotDependencies.captureBase = () => {
      captures += 1;
      if (captures === 1) return structuredClone(postBaseDrift.preflight.current_base);
      return {
        ...structuredClone(postBaseDrift.preflight.current_base),
        authority: {
          ...structuredClone(postBaseDrift.preflight.current_base.authority),
          revision: postBaseDrift.preflight.current_base.authority.revision + 1,
        },
      };
    };
    expectSnapshotError(
      () => createBackupSnapshotForTest(postBaseDrift.preflight, postBaseDrift.snapshotDependencies),
      {
        stage: "base",
        code: "LEGACY_IMPORT_BACKUP_BASE_CHANGED",
        retryable: true,
      },
    );
    assert.equal(postBaseDrift.snapshotDb.calls.vacuum, 1);
    assertNoStagingOrPublish(postBaseDrift);
  });

  test("cleans partial staging after snapshot, sync, read, or hash failure without retry", (t) => {
    const cases: ReadonlyArray<{
      configure(fixture: ReturnType<typeof snapshotFixture>): void;
      stage: string;
      code: string;
    }> = [
      {
        configure(fixture) {
          const prepare = fixture.snapshotDb.db.prepare.bind(fixture.snapshotDb.db);
          fixture.snapshotDb.db.prepare = (sql: string): DbStatement => {
            if (sql.trim().toLowerCase() !== "vacuum into ?") return prepare(sql);
            return {
              run(path: unknown) {
                fixture.snapshotDb.calls.vacuum += 1;
                writeFileSync(path as string, "partial");
                throw new Error("snapshot failed after partial output");
              },
              get: () => undefined,
              all: () => [],
            };
          };
        },
        stage: "snapshot",
        code: "LEGACY_IMPORT_BACKUP_SNAPSHOT_FAILED",
      },
      {
        configure(fixture) {
          fixture.snapshotDependencies.fsync = () => { throw new Error("sync failed"); };
        },
        stage: "sync",
        code: "LEGACY_IMPORT_BACKUP_SYNC_FAILED",
      },
      {
        configure(fixture) {
          fixture.snapshotDependencies.read = () => { throw new Error("read failed"); };
        },
        stage: "read",
        code: "LEGACY_IMPORT_BACKUP_READ_FAILED",
      },
      {
        configure(fixture) {
          fixture.snapshotDependencies.createHash = () => { throw new Error("hash failed"); };
        },
        stage: "hash",
        code: "LEGACY_IMPORT_BACKUP_HASH_FAILED",
      },
    ];

    for (const testCase of cases) {
      const fixture = snapshotFixture(t);
      testCase.configure(fixture);
      expectSnapshotError(
        () => createBackupSnapshotForTest(fixture.preflight, fixture.snapshotDependencies),
        {
          stage: testCase.stage,
          code: testCase.code,
          retryable: false,
        },
      );
      assert.equal(fixture.snapshotDb.calls.vacuum, 1, "snapshot is never retried internally");
      assertNoStagingOrPublish(fixture);
    }
  });

  test("does not retry a busy VACUUM internally and requires a fresh preflight", (t) => {
    const fixture = snapshotFixture(t, {
      snapshot() {
        const error = new Error("database is locked") as Error & { code: string };
        error.code = "SQLITE_BUSY";
        throw error;
      },
    });

    expectSnapshotError(
      () => createBackupSnapshotForTest(fixture.preflight, fixture.snapshotDependencies),
      {
        stage: "snapshot",
        code: "LEGACY_IMPORT_BACKUP_SNAPSHOT_FAILED",
        retryable: true,
      },
    );
    assert.equal(fixture.snapshotDb.calls.vacuum, 1);
    assertNoStagingOrPublish(fixture);
  });

  test("rejects zero, symlink, mutation, or replacement staging output and cleans it", (t) => {
    const target = join(tmpdir(), `gsd-legacy-snapshot-target-${process.pid}`);
    rmSync(target, { force: true });
    t.after(() => rmSync(target, { force: true }));
    const snapshots: ReadonlyArray<(path: string) => void> = [
      (path) => writeFileSync(path, Buffer.alloc(0)),
      (path) => {
        writeFileSync(target, "symlink target");
        symlinkSync(target, path, "file");
      },
      ...["-wal", "-shm", "-journal"].map((suffix) => (path: string) => {
        writeFileSync(path, "sqlite-snapshot");
        writeFileSync(`${path}${suffix}`, "unexpected sidecar");
      }),
    ];

    for (const snapshot of snapshots) {
      const fixture = snapshotFixture(t, { snapshot });
      expectSnapshotError(
        () => createBackupSnapshotForTest(fixture.preflight, fixture.snapshotDependencies),
        {
          stage: "snapshot",
          code: "LEGACY_IMPORT_BACKUP_SNAPSHOT_INVALID",
          retryable: false,
        },
      );
      assertNoStagingOrPublish(fixture);
    }

    const oversized = snapshotFixture(t);
    oversized.snapshotDependencies.lstat = (path) => {
      const stat = lstatSync(path, { bigint: true });
      if (basename(path) === "snapshot.sqlite") {
        Object.defineProperty(stat, "size", {
          configurable: true,
          value: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        });
      }
      return stat;
    };
    expectSnapshotError(
      () => createBackupSnapshotForTest(oversized.preflight, oversized.snapshotDependencies),
      {
        stage: "snapshot",
        code: "LEGACY_IMPORT_BACKUP_SNAPSHOT_INVALID",
        retryable: false,
      },
    );
    assertNoStagingOrPublish(oversized);

    const mutation = snapshotFixture(t);
    let mutated = false;
    mutation.snapshotDependencies.read = (fd, buffer, offset, length) => {
      const bytesRead = readSync(fd, buffer, offset, length, null);
      if (!mutated && bytesRead > 0) {
        mutated = true;
        const [stagingName] = readdirSync(mutation.destinationDirectory);
        assert.ok(stagingName);
        const snapshotPath = join(mutation.destinationDirectory, stagingName, "snapshot.sqlite");
        const original = readFileSync(snapshotPath);
        writeFileSync(snapshotPath, Buffer.alloc(original.byteLength, 0x78));
      }
      return bytesRead;
    };
    expectSnapshotError(
      () => createBackupSnapshotForTest(mutation.preflight, mutation.snapshotDependencies),
      {
        stage: "snapshot",
        code: "LEGACY_IMPORT_BACKUP_SNAPSHOT_INVALID",
        retryable: false,
      },
    );
    assertNoStagingOrPublish(mutation);

    const replacement = snapshotFixture(t);
    let replaced = false;
    replacement.snapshotDependencies.read = (fd, buffer, offset, length) => {
      const bytesRead = readSync(fd, buffer, offset, length, null);
      if (!replaced && bytesRead > 0) {
        replaced = true;
        const [stagingName] = readdirSync(replacement.destinationDirectory);
        assert.ok(stagingName);
        const path = join(replacement.destinationDirectory, stagingName, "snapshot.sqlite");
        const bytes = readFileSync(path);
        renameSync(path, `${path}.replaced`);
        writeFileSync(path, bytes);
      }
      return bytesRead;
    };
    expectSnapshotError(
      () => createBackupSnapshotForTest(replacement.preflight, replacement.snapshotDependencies),
      {
        stage: "snapshot",
        code: "LEGACY_IMPORT_BACKUP_SNAPSHOT_INVALID",
        retryable: false,
      },
    );
    assertNoStagingOrPublish(replacement);
  });

  function realProviderSnapshotTest(
    provider: string,
    openRaw: (path: string) => unknown,
    t: TestContext,
  ): void {
    const workspace = mkdtempSync(join(tmpdir(), `gsd snapshot ${provider} '路径'-`));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const databasePath = join(workspace, "live db 'α'.sqlite");
    const destinationDirectory = join(workspace, "backup space 'β'");
    mkdirSync(destinationDirectory);
    const adapter = createDbAdapter(openRaw(databasePath));
    t.after(() => adapter.close());
    adapter.exec("PRAGMA journal_mode=WAL");
    adapter.exec("CREATE TABLE wal_sentinel (value TEXT NOT NULL)");
    adapter.prepare("INSERT INTO wal_sentinel (value) VALUES (?)").run("committed only in WAL");
    assert.equal(existsSync(`${databasePath}-wal`), true);
    assert.equal(statSync(`${databasePath}-wal`).size > 0, true);

    const databaseStat = statSync(databasePath, { bigint: true });
    const destinationStat = statSync(destinationDirectory, { bigint: true });
    const base = baseSnapshot(workspace);
    const dataVersion = adapter.prepare("PRAGMA data_version").get()?.["data_version"];
    assert.equal(typeof dataVersion, "number");
    const preflight: LegacyImportBackupPreflightForTest = Object.freeze({
      database_path: realpathSync(databasePath),
      database_identity: Object.freeze({
        dev: databaseStat.dev.toString(),
        ino: databaseStat.ino.toString(),
      }),
      destination_directory: realpathSync(destinationDirectory),
      destination_directory_identity: Object.freeze({
        dev: destinationStat.dev.toString(),
        ino: destinationStat.ino.toString(),
      }),
      destination_path: join(realpathSync(destinationDirectory), "before-import.sqlite"),
      label: "before-import",
      root_set_hash: EMPTY_HASH,
      checkpoint: Object.freeze({ mode: "wal", busy: 0, log: 0, checkpointed: 0, attempts: 1 }),
      data_version: dataVersion as number,
      current_base: Object.freeze(base),
    });
    const result = createBackupSnapshotForTest(preflight, {
      db: adapter,
      database_path: databasePath,
      captureBase: () => structuredClone(base),
      isInTransaction: () => false,
    });
    const copied = createDbAdapter(openRaw(result.staging_path));
    try {
      assert.equal(
        copied.prepare("SELECT value FROM wal_sentinel").get()?.["value"],
        "committed only in WAL",
      );
    } finally {
      copied.close();
    }
    assert.equal(existsSync(preflight.destination_path), false);
  }

  test("includes committed WAL content with node:sqlite across quoted Unicode paths", (t) => {
    realProviderSnapshotTest("node-sqlite", (path) => new DatabaseSync(path), t);
  });

});

interface LegacyImportBackupPreparationInputForTest {
  preview: LegacyImportPreviewArtifact;
  base: LegacyImportBaseSnapshot;
  roots: readonly LegacyImportSourceRoot[];
  bundledDefinitionNames?: readonly string[];
  destination_directory: string;
  label: string;
}

function prepareBackupApi(): (
  input: LegacyImportBackupPreparationInputForTest,
) => LegacyImportVerifiedBackup {
  const boundary = (
    legacyImportBackup as unknown as {
      prepareLegacyImportBackup?: (input: LegacyImportBackupPreparationInputForTest) => LegacyImportVerifiedBackup;
    }
  ).prepareLegacyImportBackup;
  assert.ok(boundary, "legacy backup preparation boundary must be implemented");
  return boundary;
}

function preparationLineage(database: DbAdapter): Record<string, unknown> | undefined {
  return database.prepare(`
    SELECT
      (SELECT count(*) FROM workflow_operations) AS operations,
      (SELECT count(*) FROM workflow_domain_events) AS events,
      (SELECT count(*) FROM workflow_outbox) AS outbox,
      (SELECT count(*) FROM workflow_projection_work) AS projections,
      (SELECT count(*) FROM workflow_import_applications) AS import_applications,
      (SELECT count(*) FROM workflow_settlement_receipts) AS settlement_receipts,
      total_changes() AS total_changes
  `).get();
}

function preparationFixture(t: TestContext): {
  workspace: string;
  sourcePath: string;
  destinationDirectory: string;
  databasePath: string;
  database: DbAdapter;
  input: LegacyImportBackupPreparationInputForTest;
} {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "gsd-legacy-backup-prepare-")));
  t.after(() => {
    closeDatabase();
    rmSync(workspace, { recursive: true, force: true });
  });
  const sourceRoot = join(workspace, "legacy", ".gsd");
  const sourcePath = join(sourceRoot, "STATE.md");
  const destinationDirectory = join(workspace, "backups");
  const databasePath = join(workspace, "canonical.sqlite");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(destinationDirectory);
  writeFileSync(sourcePath, "# State\n\nApproved legacy narrative.\n");
  assert.equal(openDatabase(databasePath), true);
  const database = _getAdapter();
  assert.ok(database);
  const roots: readonly LegacyImportSourceRoot[] = [{
    id: "legacy-project-gsd",
    kind: "project",
    physical_path: sourceRoot,
    logical_path: ".gsd",
    presence: "required",
  }];
  const base = captureCurrentLegacyImportBaseSnapshot();
  const preview = createLegacyImportPreview({ roots });
  return {
    workspace,
    sourcePath,
    destinationDirectory,
    databasePath,
    database,
    input: {
      preview,
      base,
      roots,
      destination_directory: destinationDirectory,
      label: "before-import",
    },
  };
}

function expectedPreparedPath(
  fixture: ReturnType<typeof preparationFixture>,
  result: LegacyImportVerifiedBackup,
): string {
  return join(
    realpathSync(fixture.destinationDirectory),
    `before-import-${result.backup_id.slice("sha256:".length)}.sqlite`,
  );
}

function preparationDependencies(
  overrides: Partial<LegacyImportBackupPreparationDependencies> = {},
): LegacyImportBackupPreparationDependencies {
  return {
    preparePreflight: prepareLegacyImportBackupPreflight,
    createSnapshot: createLegacyImportBackupSnapshot,
    verifySnapshot: verifyLegacyImportBackupSnapshot,
    revalidatePreview: revalidateLegacyImportPreview,
    openReadOnly: openSqliteReadOnly,
    now: () => "2026-07-16T12:34:56.789Z",
    ...overrides,
  };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function visibleBackupPaths(destinationDirectory: string): string[] {
  return readdirSync(destinationDirectory)
    .filter((name) => !name.startsWith("."))
    .map((name) => join(destinationDirectory, name));
}

function stagingDirectoryPaths(destinationDirectory: string): string[] {
  return readdirSync(destinationDirectory)
    .filter((name) => name.startsWith("."))
    .map((name) => join(destinationDirectory, name));
}

function assertIndependentlyValidFinal(path: string): void {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF");
    assert.deepEqual({ ...database.prepare("PRAGMA quick_check").get() }, { quick_check: "ok" });
    assert.deepEqual({ ...database.prepare("PRAGMA integrity_check").get() }, { integrity_check: "ok" });
    assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  } finally {
    database.close();
  }
}

describe("legacy import backup preparation", () => {
  test("publishes one deeply frozen backup at its full backup-id-addressed name without authority writes", (t) => {
    const prepare = prepareBackupApi();
    const fixture = preparationFixture(t);
    const authorityBefore = fixture.database.prepare(`
      SELECT * FROM project_authority WHERE singleton = 1
    `).get();
    const lineageBefore = preparationLineage(fixture.database);

    const result = prepare(fixture.input);

    const expectedPath = expectedPreparedPath(fixture, result);
    const expectedName = basename(expectedPath);
    assert.equal(result.backup_ref, expectedPath);
    assert.deepEqual(readdirSync(fixture.destinationDirectory), [expectedName]);
    assert.equal(result.backup_sha256, hashLegacyImportBytes(readFileSync(expectedPath)));
    assert.equal(result.backup_byte_size, statSync(expectedPath).size);
    assert.deepEqual(validateLegacyImportVerifiedBackup(result, {
      preview: fixture.input.preview,
      base: fixture.input.base,
    }), result);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.source_fingerprints), true);
    assert.equal(Object.isFrozen(result.source_fingerprints[0]), true);

    assertIndependentlyValidFinal(expectedPath);
    assert.deepEqual(
      fixture.database.prepare("SELECT * FROM project_authority WHERE singleton = 1").get(),
      authorityBefore,
    );
    assert.deepEqual(preparationLineage(fixture.database), lineageBefore);
  });

  test("reuses one exact final backup without replacing its inode or changing its mtime", (t) => {
    const prepare = prepareBackupApi();
    const fixture = preparationFixture(t);
    const first = prepare(fixture.input);
    const path = expectedPreparedPath(fixture, first);
    const before = statSync(path, { bigint: true });
    const bytesBefore = readFileSync(path);

    const replay = prepare(fixture.input);
    const after = statSync(path, { bigint: true });

    assert.equal(replay.backup_id, first.backup_id);
    assert.equal(replay.backup_ref, first.backup_ref);
    assert.equal(replay.backup_sha256, first.backup_sha256);
    assert.equal(replay.backup_byte_size, first.backup_byte_size);
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.deepEqual(readFileSync(path), bytesBefore);
    assert.deepEqual(readdirSync(fixture.destinationDirectory), [basename(path)]);
    assert.equal(Object.isFrozen(replay), true);
  });

  test("rejects a corrupt exact-name collision without overwriting or deleting it", (t) => {
    const prepare = prepareBackupApi();
    const fixture = preparationFixture(t);
    const first = prepare(fixture.input);
    const path = expectedPreparedPath(fixture, first);
    const corrupt = Buffer.from("not a complete SQLite backup");
    writeFileSync(path, corrupt);
    const before = statSync(path, { bigint: true });

    assert.throws(
      () => prepare(fixture.input),
      (error: unknown) => error instanceof LegacyImportBackupError && !error.retryable,
    );

    const after = statSync(path, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.deepEqual(readFileSync(path), corrupt);
    assert.deepEqual(readdirSync(fixture.destinationDirectory), [basename(path)]);
  });

  test("rejects source or base drift before publication and creates no backup leaf", (t) => {
    const prepare = prepareBackupApi();

    const sourceDrift = preparationFixture(t);
    writeFileSync(sourceDrift.sourcePath, "# State\n\nChanged after approval.\n");
    assert.throws(
      () => prepare(sourceDrift.input),
      (error: unknown) => error instanceof LegacyImportBackupError
        && error.code === "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID"
        && error.stage === "contract"
        && !error.retryable,
    );
    assert.deepEqual(readdirSync(sourceDrift.destinationDirectory), []);

    closeDatabase();
    const baseDrift = preparationFixture(t);
    baseDrift.database.prepare(`
      INSERT INTO decisions (id, decision) VALUES ('D-PREPARE-DRIFT', 'Changed after approval')
    `).run();
    const changesAfterFixtureMutation = preparationLineage(baseDrift.database)?.["total_changes"];
    // Base drift changes the sealed Preview hash, so it is rejected at preview
    // revalidation (contract stage) before the base capture boundary is reached.
    assert.throws(
      () => prepare(baseDrift.input),
      (error: unknown) => error instanceof LegacyImportBackupError
        && error.code === "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID"
        && error.stage === "contract"
        && !error.retryable,
    );
    assert.deepEqual(readdirSync(baseDrift.destinationDirectory), []);
    assert.equal(preparationLineage(baseDrift.database)?.["total_changes"], changesAfterFixtureMutation);
  });

  test("retries a fresh preflight or snapshot exactly three times but never retries a nonretryable failure", (t) => {
    const fixture = preparationFixture(t);
    let preflightAttempts = 0;
    const retried = _prepareLegacyImportBackupForTest(fixture.input, preparationDependencies({
      preparePreflight(input) {
        preflightAttempts += 1;
        if (preflightAttempts < 3) {
          throw new LegacyImportBackupError(
            "LEGACY_IMPORT_BACKUP_CHECKPOINT_BUSY",
            "injected transient checkpoint",
            {},
            "checkpoint",
            true,
          );
        }
        return prepareLegacyImportBackupPreflight(input);
      },
    }));
    assert.equal(preflightAttempts, 3);
    assert.equal(visibleBackupPaths(fixture.destinationDirectory).length, 1);
    assert.equal(retried.backup_ref, visibleBackupPaths(fixture.destinationDirectory)[0]);

    closeDatabase();
    const snapshotFixture = preparationFixture(t);
    let snapshotAttempts = 0;
    const snapshotRetried = _prepareLegacyImportBackupForTest(
      snapshotFixture.input,
      preparationDependencies({
        createSnapshot(preflight) {
          snapshotAttempts += 1;
          if (snapshotAttempts < 3) {
            throw new LegacyImportBackupError(
              "LEGACY_IMPORT_BACKUP_SNAPSHOT_FAILED",
              "injected transient snapshot",
              {},
              "snapshot",
              true,
            );
          }
          return createLegacyImportBackupSnapshot(preflight);
        },
      }),
    );
    assert.equal(snapshotAttempts, 3);
    assert.equal(snapshotRetried.backup_ref, visibleBackupPaths(snapshotFixture.destinationDirectory)[0]);

    closeDatabase();
    const permanentFixture = preparationFixture(t);
    let permanentAttempts = 0;
    assert.throws(
      () => _prepareLegacyImportBackupForTest(
        permanentFixture.input,
        preparationDependencies({
          preparePreflight() {
            permanentAttempts += 1;
            throw new LegacyImportBackupError(
              "LEGACY_IMPORT_BACKUP_CHECKPOINT_INVALID",
              "injected permanent checkpoint",
              {},
              "checkpoint",
              false,
            );
          },
        }),
      ),
      (error: unknown) => error instanceof LegacyImportBackupError
        && error.code === "LEGACY_IMPORT_BACKUP_CHECKPOINT_INVALID"
        && !error.retryable,
    );
    assert.equal(permanentAttempts, 1);
    assert.deepEqual(readdirSync(permanentFixture.destinationDirectory), []);
  });

  test("fails a non-collision link once and cleanup failure has final precedence", (t) => {
    const fixture = preparationFixture(t);
    let linkAttempts = 0;
    assert.throws(
      () => _prepareLegacyImportBackupForTest(fixture.input, preparationDependencies({
        link() {
          linkAttempts += 1;
          throw errno("EPERM");
        },
      })),
      (error: unknown) => error instanceof LegacyImportBackupError
        && error.code === "LEGACY_IMPORT_BACKUP_PUBLICATION_FAILED"
        && error.stage === "publication"
        && !error.retryable,
    );
    assert.equal(linkAttempts, 1);
    assert.deepEqual(readdirSync(fixture.destinationDirectory), []);

    closeDatabase();
    const cleanupFixture = preparationFixture(t);
    let cleanupAttempts = 0;
    assert.throws(
      () => _prepareLegacyImportBackupForTest(cleanupFixture.input, preparationDependencies({
        link() { throw errno("EPERM"); },
        removeStagingDirectory() {
          cleanupAttempts += 1;
          throw errno("EACCES");
        },
      })),
      (error: unknown) => error instanceof LegacyImportBackupError
        && error.code === "LEGACY_IMPORT_BACKUP_STAGING_CLEANUP_FAILED"
        && error.stage === "cleanup"
        && !error.retryable,
    );
    assert.equal(cleanupAttempts, 1);
    assert.deepEqual(visibleBackupPaths(cleanupFixture.destinationDirectory), []);
  });

  test("file or directory sync failure never retries and leaves only a complete final backup", (t) => {
    const cases = ["file", "directory"] as const;
    for (const kind of cases) {
      const fixture = preparationFixture(t);
      let syncAttempts = 0;
      const dependencies = kind === "file"
        ? preparationDependencies({
          fsync() {
            syncAttempts += 1;
            throw errno("EIO");
          },
        })
        : preparationDependencies({
          syncDirectory() {
            syncAttempts += 1;
            throw errno("EIO");
          },
        });
      assert.throws(
        () => _prepareLegacyImportBackupForTest(fixture.input, dependencies),
        (error: unknown) => error instanceof LegacyImportBackupError
          && error.code === "LEGACY_IMPORT_BACKUP_SYNC_FAILED"
          && error.stage === "sync"
          && !error.retryable,
      );
      assert.equal(syncAttempts, 1, `${kind} sync failure is not retried`);
      const finals = visibleBackupPaths(fixture.destinationDirectory);
      assert.equal(finals.length, 1);
      assertIndependentlyValidFinal(finals[0]!);
      const recovered = prepareBackupApi()(fixture.input);
      assert.equal(recovered.backup_ref, finals[0]);
      closeDatabase();
    }
  });

  test("unsupported directory durability fails publication closed", (t) => {
    const fixture = preparationFixture(t);
    assert.throws(
      () => _prepareLegacyImportBackupForTest(fixture.input, preparationDependencies({
        syncDirectory: () => "unsupported",
      })),
      (error: unknown) => error instanceof LegacyImportBackupError
        && error.code === "LEGACY_IMPORT_BACKUP_SYNC_FAILED"
        && error.stage === "sync",
    );
  });

  test("metadata or post-snapshot source failure creates no published final", (t) => {
    const metadataFixture = preparationFixture(t);
    let clockReads = 0;
    assert.throws(
      () => _prepareLegacyImportBackupForTest(metadataFixture.input, preparationDependencies({
        now() {
          clockReads += 1;
          throw new Error("clock unavailable");
        },
      })),
      (error: unknown) => error instanceof LegacyImportBackupError
        && error.code === "LEGACY_IMPORT_BACKUP_METADATA_INVALID"
        && error.stage === "metadata",
    );
    assert.equal(clockReads, 1);
    assert.deepEqual(readdirSync(metadataFixture.destinationDirectory), []);

    closeDatabase();
    const sourceFixture = preparationFixture(t);
    let revalidations = 0;
    assert.throws(
      () => _prepareLegacyImportBackupForTest(sourceFixture.input, preparationDependencies({
        revalidatePreview(input, expected) {
          revalidations += 1;
          writeFileSync(sourceFixture.sourcePath, "# State\n\nChanged after snapshot.\n");
          return revalidateLegacyImportPreview(input, expected);
        },
      })),
      (error: unknown) => error instanceof LegacyImportBackupError
        && error.code === "LEGACY_IMPORT_BACKUP_SOURCE_CHANGED"
        && error.stage === "source"
        && !error.retryable,
    );
    assert.equal(revalidations, 1);
    assert.deepEqual(readdirSync(sourceFixture.destinationDirectory), []);
  });

  test("backup revalidation preserves the complete normalized Preview input", (t) => {
    const fixture = preparationFixture(t);
    const input = { ...fixture.input, bundledDefinitionNames: [] };
    let revalidations = 0;
    const backup = _prepareLegacyImportBackupForTest(input, preparationDependencies({
      revalidatePreview(observed, expected) {
        revalidations += 1;
        assert.deepEqual(observed.bundledDefinitionNames, []);
        return revalidateLegacyImportPreview(observed, expected);
      },
    }));

    assert.equal(revalidations, 1);
    assert.equal(backup.preview_hash, input.preview.preview_hash);
  });

  test("an EEXIST race preserves a valid wrong final and rejects it as a nonretryable collision", (t) => {
    const fixture = preparationFixture(t);
    let racedPath = "";
    assert.throws(
      () => _prepareLegacyImportBackupForTest(fixture.input, preparationDependencies({
        link(_stagingPath, finalPath) {
          racedPath = finalPath;
          const wrong = new DatabaseSync(finalPath);
          try {
            wrong.exec("CREATE TABLE wrong_backup (value TEXT NOT NULL)");
          } finally {
            wrong.close();
          }
          throw errno("EEXIST");
        },
      })),
      (error: unknown) => error instanceof LegacyImportBackupError
        && error.code === "LEGACY_IMPORT_BACKUP_PUBLICATION_COLLISION"
        && error.stage === "publication"
        && !error.retryable,
    );
    assert.ok(racedPath);
    const wrong = new DatabaseSync(racedPath, { readOnly: true });
    try {
      assert.equal(
        wrong.prepare("SELECT count(*) AS count FROM wrong_backup").get()?.count,
        0,
      );
    } finally {
      wrong.close();
    }
    assert.deepEqual(visibleBackupPaths(fixture.destinationDirectory), [racedPath]);
  });

  test("exact EEXIST reuse independently opens and revalidates the final with both directory syncs", (t) => {
    const fixture = preparationFixture(t);
    const first = prepareBackupApi()(fixture.input);
    let opens = 0;
    let revalidations = 0;
    let fileSyncs = 0;
    let directorySyncs = 0;
    const replay = _prepareLegacyImportBackupForTest(fixture.input, preparationDependencies({
      openReadOnly(path) {
        opens += 1;
        return openSqliteReadOnly(path);
      },
      revalidatePreview(input, expected) {
        revalidations += 1;
        return revalidateLegacyImportPreview(input, expected);
      },
      fsync() {
        fileSyncs += 1;
      },
      syncDirectory() {
        directorySyncs += 1;
        return "synced";
      },
    }));

    assert.equal(replay.backup_id, first.backup_id);
    assert.equal(opens, 1, "collision reuse independently opens the existing final once");
    assert.equal(revalidations, 2, "reuse revalidates before and after collision verification");
    assert.equal(fileSyncs, 3, "reuse fences existing bytes before, after, and after staging cleanup");
    assert.equal(directorySyncs, 2, "publication and cleanup each synchronize the directory");
  });

  test("a vanishing EEXIST candidate retries exactly three fresh attempts and can then converge", (t) => {
    const exhaustedFixture = preparationFixture(t);
    let exhaustedLinks = 0;
    let exhaustedPreflights = 0;
    assert.throws(
      () => _prepareLegacyImportBackupForTest(
        exhaustedFixture.input,
        preparationDependencies({
          preparePreflight(input) {
            exhaustedPreflights += 1;
            return prepareLegacyImportBackupPreflight(input);
          },
          link() {
            exhaustedLinks += 1;
            throw errno("EEXIST");
          },
        }),
      ),
      (error: unknown) => error instanceof LegacyImportBackupError
        && error.code === "LEGACY_IMPORT_BACKUP_PUBLICATION_RACE"
        && error.stage === "publication"
        && error.retryable,
    );
    assert.equal(exhaustedLinks, 3);
    assert.equal(exhaustedPreflights, 3);
    assert.deepEqual(readdirSync(exhaustedFixture.destinationDirectory), []);

    closeDatabase();
    const convergedFixture = preparationFixture(t);
    let convergedLinks = 0;
    let convergedPreflights = 0;
    const converged = _prepareLegacyImportBackupForTest(
      convergedFixture.input,
      preparationDependencies({
        preparePreflight(input) {
          convergedPreflights += 1;
          return prepareLegacyImportBackupPreflight(input);
        },
        link(stagingPath, finalPath) {
          convergedLinks += 1;
          if (convergedLinks < 3) throw errno("EEXIST");
          linkSync(stagingPath, finalPath);
        },
      }),
    );
    assert.equal(convergedLinks, 3);
    assert.equal(convergedPreflights, 3);
    assert.equal(converged.backup_ref, visibleBackupPaths(convergedFixture.destinationDirectory)[0]);
    assertIndependentlyValidFinal(converged.backup_ref);
  });

  test("destination replacement after snapshot is rejected before link publication", (t) => {
    const fixture = preparationFixture(t);
    const originalDestination = `${fixture.destinationDirectory}.original`;
    let destinationReads = 0;
    let links = 0;
    assert.throws(
      () => _prepareLegacyImportBackupForTest(fixture.input, preparationDependencies({
        lstat(path) {
          if (path === fixture.destinationDirectory) {
            destinationReads += 1;
            if (destinationReads === 1) {
              renameSync(fixture.destinationDirectory, originalDestination);
              mkdirSync(fixture.destinationDirectory);
            }
          }
          return lstatSync(path, { bigint: true });
        },
        link() { links += 1; },
      })),
      (error: unknown) => error instanceof LegacyImportBackupError
        && error.code === "LEGACY_IMPORT_BACKUP_FINAL_CHANGED"
        && error.stage === "publication"
        && !error.retryable,
    );
    assert.equal(links, 0);
    assert.deepEqual(readdirSync(fixture.destinationDirectory), []);
  });

  test("preserves private staging owned by an active preparation process", (t) => {
    const fixture = preparationFixture(t);
    const preflight = prepareLegacyImportBackupPreflight(fixture.input);
    const activeSnapshot = createLegacyImportBackupSnapshot(preflight);

    const result = prepareBackupApi()(fixture.input);

    assert.equal(existsSync(activeSnapshot.staging_directory), true);
    assert.deepEqual(visibleBackupPaths(fixture.destinationDirectory), [result.backup_ref]);
    assertIndependentlyValidFinal(result.backup_ref);
  });

  test("sweeps stale private staging directories from a terminated run before publication", (t) => {
    const fixture = preparationFixture(t);
    const currentIdentity = processStartIdentity(process.pid);
    assert.ok(currentIdentity);
    const stale = join(
      fixture.destinationDirectory,
      `.${fixture.input.label}.staging-${process.pid}-${"0".repeat(64)}-${randomUUID()}`,
    );
    mkdirSync(stale);
    writeFileSync(join(stale, "snapshot.sqlite"), "stale bytes");
    const otherLabel = join(fixture.destinationDirectory, `.other-label.staging-${randomUUID()}`);
    mkdirSync(otherLabel);
    const nonUuid = join(fixture.destinationDirectory, `.${fixture.input.label}.staging-not-a-uuid`);
    mkdirSync(nonUuid);

    const result = prepareBackupApi()(fixture.input);

    assert.equal(existsSync(stale), false, "stale staging directory for this label is swept");
    assert.equal(lstatSync(otherLabel).isDirectory(), true, "staging directories of other labels are kept");
    assert.equal(lstatSync(nonUuid).isDirectory(), true, "non-uuid staging names are kept");
    assert.deepEqual(visibleBackupPaths(fixture.destinationDirectory), [result.backup_ref]);
    assertIndependentlyValidFinal(result.backup_ref);
  });

  test("rejects a published name that hardlinks the live database instead of reusing it", (t) => {
    const fixture = preparationFixture(t);
    const first = prepareBackupApi()(fixture.input);
    rmSync(first.backup_ref);
    linkSync(fixture.databasePath, first.backup_ref);

    assert.throws(
      () => prepareBackupApi()(fixture.input),
      (error: unknown) => error instanceof LegacyImportBackupError
        && error.code === "LEGACY_IMPORT_BACKUP_DESTINATION_ALIASES_DATABASE"
        && error.stage === "publication"
        && !error.retryable,
    );
    assert.equal(lstatSync(first.backup_ref).isFile(), true, "the aliasing final is left untouched");
  });

  test("maps an existing final's read-only configuration failure to the verification code", (t) => {
    const fixture = preparationFixture(t);
    const first = prepareBackupApi()(fixture.input);
    let opens = 0;
    assert.throws(
      () => _prepareLegacyImportBackupForTest(fixture.input, preparationDependencies({
        openReadOnly() {
          opens += 1;
          throw new SqliteReadOnlyConfigurationError();
        },
      })),
      (error: unknown) => error instanceof LegacyImportBackupError
        && error.code === "LEGACY_IMPORT_BACKUP_READ_ONLY_CONFIGURATION_FAILED"
        && error.stage === "verification"
        && !error.retryable,
    );
    assert.equal(opens, 1);
    assert.deepEqual(visibleBackupPaths(fixture.destinationDirectory), [first.backup_ref]);
  });

  test("legacy import backup restart converges after true termination before or after publication", {
    concurrency: false,
  }, (t) => {
    const workerPath = join(
      process.cwd(),
      "src/resources/extensions/gsd/tests/fixtures/legacy-import-backup-prepare-worker.ts",
    );
    const resolverPath = join(
      process.cwd(),
      "src/resources/extensions/gsd/tests/resolve-ts.mjs",
    );
    const boundaries = ["after-verification", "after-publish"] as const;

    for (const boundary of boundaries) {
      const fixture = preparationFixture(t);
      const lineageBefore = preparationLineage(fixture.database);
      assert.ok(lineageBefore);
      const { total_changes: _priorConnectionChanges, ...canonicalBefore } = lineageBefore;
      closeDatabase();
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const child = spawnSync(process.execPath, [
        "--import",
        resolverPath,
        "--experimental-strip-types",
        workerPath,
        JSON.stringify({
          databasePath: fixture.databasePath,
          preparationInput: fixture.input,
          boundary,
        }),
      ], {
        cwd: process.cwd(),
        env,
        encoding: "utf8",
        timeout: 30_000,
      });

      assert.equal(child.status, null, child.stderr || child.stdout);
      assert.equal(child.signal, "SIGKILL", child.stderr || child.stdout);
      const afterTermination = visibleBackupPaths(fixture.destinationDirectory);
      assert.equal(afterTermination.length, boundary === "after-publish" ? 1 : 0);
      if (afterTermination[0] !== undefined) assertIndependentlyValidFinal(afterTermination[0]);
      const staleAfterTermination = stagingDirectoryPaths(fixture.destinationDirectory);
      assert.equal(
        staleAfterTermination.length,
        1,
        "true termination must visibly leak one private staging directory",
      );

      assert.equal(openDatabase(fixture.databasePath), true);
      const restartedDatabase = _getAdapter();
      assert.ok(restartedDatabase);
      const restartedBefore = preparationLineage(restartedDatabase);
      assert.ok(restartedBefore);
      const { total_changes: restartedTotalChanges, ...restartedCanonical } = restartedBefore;
      assert.deepEqual(restartedCanonical, canonicalBefore);
      const restarted = prepareBackupApi()(fixture.input);
      const converged = visibleBackupPaths(fixture.destinationDirectory);
      assert.deepEqual(converged, [restarted.backup_ref]);
      assert.deepEqual(
        stagingDirectoryPaths(fixture.destinationDirectory),
        [],
        "preparation sweeps the staging directory leaked by true termination",
      );
      assertIndependentlyValidFinal(restarted.backup_ref);
      if (afterTermination[0] !== undefined) {
        assert.equal(restarted.backup_ref, afterTermination[0]);
      }
      assert.equal(preparationLineage(restartedDatabase)?.["total_changes"], restartedTotalChanges);
      closeDatabase();
    }
  });
});
