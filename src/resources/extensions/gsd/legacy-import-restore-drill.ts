// Project/App: gsd-pi
// File Purpose: Disposable fresh-process restore rehearsal for verified legacy-import backups.

import { deepFreeze } from "./legacy-import-utils.js";

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { LegacyImportSha256, LegacyImportValue } from "./legacy-import-contract.js";
import {
  LegacyImportBackupError,
  verifyLegacyImportBackupArtifact,
  type LegacyImportVerifiedBackup,
} from "./legacy-import-backup.js";
import type { LegacyImportBaseSnapshot } from "./legacy-import-preview-base.js";
import {
  hashLegacyImportValue,
  type LegacyImportPreviewArtifact,
} from "./legacy-import-preview.js";

const STAGING_NAME = "restore-stage.sqlite";
const ISOLATED_NAME = "gsd.db";
const WORKER_ARGUMENT = "--legacy-import-restore-drill-worker";
const INPUT_KEYS = ["backup", "preview", "base"] as const;
const CHILD_KEYS = [
  "pid",
  "opened_path",
  "quick_check",
  "integrity_check",
  "foreign_key_violations",
  "relevant_rows_hash",
  "representative_query_hash",
  "representative_query_count",
  "representative_queries",
] as const;

export interface LegacyImportBackupRestoreDrillInput {
  backup: LegacyImportVerifiedBackup;
  preview: LegacyImportPreviewArtifact;
  base: LegacyImportBaseSnapshot;
}

export interface LegacyImportBackupRestoreDrillResult {
  backup_id: LegacyImportSha256;
  backup_sha256: LegacyImportSha256;
  backup_byte_size: number;
  quick_check: "ok";
  integrity_check: "ok";
  foreign_key_violations: 0;
  representative_queries: "ok";
}

type LegacyImportBackupRestoreDrillBoundary =
  | "after-source-verification"
  | "after-stage"
  | "after-flush"
  | "after-publish"
  | "after-fresh-process-verification"
  | "after-cleanup";

interface FileIdentity {
  dev: string;
  ino: string;
}

interface OwnedDrillDirectory {
  path: string;
  identity: FileIdentity;
}

interface FreshProcessInput extends LegacyImportBackupRestoreDrillInput {
  isolatedPath: string;
}

interface FreshProcessEvidence {
  pid: number;
  opened_path: string;
  quick_check: "ok";
  integrity_check: "ok";
  foreign_key_violations: 0;
  relevant_rows_hash: LegacyImportSha256;
  representative_query_hash: LegacyImportSha256;
  representative_query_count: number;
  representative_queries: "ok";
}

interface LegacyImportBackupRestoreDrillDependencies {
  makeDrillDirectory(): string;
  verifyInFreshProcess(input: FreshProcessInput): FreshProcessEvidence;
  boundary?(
    name: LegacyImportBackupRestoreDrillBoundary,
    detail?: Readonly<Record<string, unknown>>,
  ): void;
  copyFile(source: string, destination: string): void;
  fsync(path: string): void;
  link(source: string, destination: string): void;
  syncDirectory(path: string): void;
  removeDrillDirectory(directory: OwnedDrillDirectory): void;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.getOwnPropertySymbols(value).length !== 0
  ) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function drillError(
  code: ConstructorParameters<typeof LegacyImportBackupError>[0],
  message: string,
  stage: ConstructorParameters<typeof LegacyImportBackupError>[3],
  context: Readonly<Record<string, LegacyImportValue>> = {},
): LegacyImportBackupError {
  return new LegacyImportBackupError(code, message, context, stage, false);
}

function detachedInput(value: LegacyImportBackupRestoreDrillInput): LegacyImportBackupRestoreDrillInput {
  if (!hasExactKeys(value, INPUT_KEYS)) {
    throw drillError(
      "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
      "legacy import backup restore drill requires one exact input",
      "contract",
    );
  }
  let input: LegacyImportBackupRestoreDrillInput;
  try {
    input = structuredClone(value);
  } catch {
    throw drillError(
      "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
      "legacy import backup restore drill input must be detached strict data",
      "contract",
    );
  }
  if (!hasExactKeys(input, INPUT_KEYS)) {
    throw drillError(
      "LEGACY_IMPORT_BACKUP_CONTRACT_INVALID",
      "legacy import backup restore drill input changed while being detached",
      "contract",
    );
  }
  verifyLegacyImportBackupArtifact(input);
  return deepFreeze(input);
}

function identityOf(stat: { dev: bigint; ino: bigint }): FileIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requireRestoreFile(
  path: string,
  byteSize: number,
  expected?: FileIdentity,
  forbidden?: FileIdentity,
): FileIdentity {
  try {
    const stat = lstatSync(path, { bigint: true });
    const identity = identityOf(stat);
    if (
      realpathSync(path) !== path
      || !stat.isFile()
      || stat.isSymbolicLink()
      || stat.size !== BigInt(byteSize)
      || (expected !== undefined && !sameIdentity(identity, expected))
      || (forbidden !== undefined && sameIdentity(identity, forbidden))
    ) throw new Error("restore file identity changed");
    return identity;
  } catch {
    throw drillError(
      "LEGACY_IMPORT_BACKUP_SNAPSHOT_INVALID",
      "restore drill file identity changed across a durable boundary",
      "snapshot",
      { path },
    );
  }
}

function requireOwnedDirectory(path: string): OwnedDrillDirectory {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (
      !isAbsolute(path)
      || realpathSync(path) !== path
      || !stat.isDirectory()
      || stat.isSymbolicLink()
      || (process.platform !== "win32" && (Number(stat.mode) & 0o777) !== 0o700)
      || readdirSync(path).length !== 0
    ) throw new Error("invalid private directory");
    return { path, identity: identityOf(stat) };
  } catch {
    throw drillError(
      "LEGACY_IMPORT_BACKUP_DESTINATION_INVALID",
      "restore drill could not pin one empty private directory",
      "destination",
    );
  }
}

function confirmOwnedDirectory(directory: OwnedDrillDirectory): void {
  try {
    const stat = lstatSync(directory.path, { bigint: true });
    if (
      realpathSync(directory.path) !== directory.path
      || !stat.isDirectory()
      || stat.isSymbolicLink()
      || !sameIdentity(identityOf(stat), directory.identity)
    ) throw new Error("directory identity changed");
  } catch {
    throw drillError(
      "LEGACY_IMPORT_BACKUP_DESTINATION_INVALID",
      "restore drill private directory identity changed",
      "destination",
    );
  }
}

const DRILL_DIRECTORY_PREFIX = "gsd-legacy-import-restore-drill-";
// A drill always finishes in well under a minute (its fresh-process
// verification has a 60s timeout), so residue older than a day can only come
// from a crashed or SIGKILLed drill that can never return to clean itself.
const STALE_DRILL_DIRECTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function makeDrillDirectory(): string {
  sweepStaleDrillDirectories(tmpdir(), Date.now());
  const path = mkdtempSync(join(tmpdir(), DRILL_DIRECTORY_PREFIX));
  chmodSync(path, 0o700);
  return realpathSync(path);
}

/**
 * Best-effort janitor for drill directories orphaned by crashed/SIGKILLed
 * drills. Only exact-prefix real directories older than the staleness
 * threshold are removed; a live drill, a foreign entry, or any filesystem
 * error must never block or fail a new drill, so every failure is swallowed.
 */
function sweepStaleDrillDirectories(root: string, nowMs: number): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(DRILL_DIRECTORY_PREFIX)) continue;
    try {
      const stat = lstatSync(join(root, entry), { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const ageMs = nowMs - Number(stat.mtimeMs);
      if (!Number.isFinite(ageMs) || ageMs < STALE_DRILL_DIRECTORY_MAX_AGE_MS) continue;
      rmSync(join(root, entry), { recursive: true, force: true });
    } catch {
      // best effort: the next drill start retries the sweep
    }
  }
}

export function _sweepStaleRestoreDrillDirectoriesForTest(root: string, nowMs: number): void {
  sweepStaleDrillDirectories(root, nowMs);
}

function copyFile(source: string, destination: string): void {
  try {
    copyFileSync(source, destination, fsConstants.COPYFILE_EXCL);
    chmodSync(destination, 0o600);
  } catch {
    throw drillError(
      "LEGACY_IMPORT_BACKUP_SNAPSHOT_FAILED",
      "restore drill could not materialize an exclusive staging copy",
      "snapshot",
    );
  }
}

function fsyncFile(path: string): void {
  let fd: number;
  try {
    // The sync pass opens read-write on Windows because fsync (FlushFileBuffers)
    // requires a handle with GENERIC_WRITE. POSIX keeps O_RDONLY (same
    // convention as legacy-import-backup.ts hashSnapshotPass).
    const access = process.platform === "win32" ? fsConstants.O_RDWR : fsConstants.O_RDONLY;
    fd = openSync(path, access | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    throw drillError(
      "LEGACY_IMPORT_BACKUP_SYNC_FAILED",
      "restore drill file could not be opened for synchronization",
      "sync",
    );
  }
  let failure: unknown;
  try {
    fsyncSync(fd);
  } catch {
    failure = drillError(
      "LEGACY_IMPORT_BACKUP_SYNC_FAILED",
      "restore drill file could not be synchronized",
      "sync",
    );
  } finally {
    try {
      closeSync(fd);
    } catch {
      failure = drillError(
        "LEGACY_IMPORT_BACKUP_CLOSE_FAILED",
        "restore drill synchronized file could not be closed",
        "sync",
      );
    }
  }
  if (failure !== undefined) throw failure;
}

function systemErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function unsupportedDirectorySync(error: unknown): boolean {
  const code = systemErrorCode(error);
  return code === "EINVAL"
    || code === "ENOTSUP"
    || (process.platform === "win32" && (code === "EISDIR" || code === "EPERM"));
}

function syncDirectory(path: string): void {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
  } catch (error) {
    if (unsupportedDirectorySync(error)) return;
    throw drillError(
      "LEGACY_IMPORT_BACKUP_SYNC_FAILED",
      "restore drill directory could not be opened for synchronization",
      "sync",
    );
  }
  let failure: unknown;
  try {
    fsyncSync(fd);
  } catch (error) {
    if (!unsupportedDirectorySync(error)) {
      failure = drillError(
        "LEGACY_IMPORT_BACKUP_SYNC_FAILED",
        "restore drill directory could not be synchronized",
        "sync",
      );
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      failure = drillError(
        "LEGACY_IMPORT_BACKUP_CLOSE_FAILED",
        "restore drill directory could not be closed",
        "sync",
      );
    }
  }
  if (failure !== undefined) throw failure;
}

function linkFile(source: string, destination: string): void {
  try {
    linkSync(source, destination);
  } catch {
    throw drillError(
      "LEGACY_IMPORT_BACKUP_PUBLICATION_FAILED",
      "restore drill could not publish its isolated database without replacement",
      "publication",
    );
  }
}

function removeDrillDirectory(directory: OwnedDrillDirectory): void {
  confirmOwnedDirectory(directory);
  const allowed = new Set([
    STAGING_NAME,
    ISOLATED_NAME,
    `${STAGING_NAME}-journal`,
    `${STAGING_NAME}-shm`,
    `${STAGING_NAME}-wal`,
    `${ISOLATED_NAME}-journal`,
    `${ISOLATED_NAME}-shm`,
    `${ISOLATED_NAME}-wal`,
  ]);
  for (const entry of readdirSync(directory.path)) {
    if (!allowed.has(entry)) throw new Error("restore drill contains an unknown entry");
    const path = join(directory.path, entry);
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("restore drill entry changed kind");
    unlinkSync(path);
  }
  rmdirSync(directory.path);
}

function representativeRows(base: LegacyImportBaseSnapshot): LegacyImportBaseSnapshot["rows"] {
  return base.rows.filter((row) => (
    row.row_set === "milestones" || row.row_set === "slices" || row.row_set === "tasks"
  ));
}

function childArguments(): string[] {
  const args: string[] = [];
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const value = process.execArgv[index];
    if (value === "--import" || value === "--loader") {
      const next = process.execArgv[index + 1];
      if (next !== undefined) {
        args.push(value, next);
        index += 1;
      }
    } else if (
      value === "--experimental-strip-types"
      || value.startsWith("--import=")
      || value.startsWith("--loader=")
    ) {
      args.push(value);
    }
  }
  return args;
}

function verifyInFreshProcess(input: FreshProcessInput): FreshProcessEvidence {
  const child = spawnSync(process.execPath, [
    ...childArguments(),
    fileURLToPath(import.meta.url),
    WORKER_ARGUMENT,
  ], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  if (child.status !== 0 || child.signal !== null) {
    throw drillError(
      "LEGACY_IMPORT_BACKUP_OPEN_FAILED",
      "restore drill fresh-process verification failed",
      "verification",
    );
  }
  let evidence: unknown;
  try {
    evidence = JSON.parse(child.stdout);
  } catch {
    throw drillError(
      "LEGACY_IMPORT_BACKUP_OPEN_FAILED",
      "restore drill fresh-process verification returned malformed evidence",
      "verification",
    );
  }
  if (!hasExactKeys(evidence, CHILD_KEYS)) {
    throw drillError(
      "LEGACY_IMPORT_BACKUP_OPEN_FAILED",
      "restore drill fresh-process verification returned an unexpected contract",
      "verification",
    );
  }
  return evidence as unknown as FreshProcessEvidence;
}

function dependencies(
  overrides: Partial<LegacyImportBackupRestoreDrillDependencies>,
): LegacyImportBackupRestoreDrillDependencies {
  return {
    makeDrillDirectory,
    verifyInFreshProcess,
    copyFile,
    fsync: fsyncFile,
    link: linkFile,
    syncDirectory,
    removeDrillDirectory,
    ...overrides,
  };
}

function requireChildEvidence(
  evidence: FreshProcessEvidence,
  input: LegacyImportBackupRestoreDrillInput,
  isolatedPath: string,
): void {
  const rows = representativeRows(input.base);
  if (
    !Number.isSafeInteger(evidence.pid)
    || evidence.pid <= 0
    || evidence.pid === process.pid
    || evidence.opened_path !== isolatedPath
    || evidence.quick_check !== "ok"
    || evidence.integrity_check !== "ok"
    || evidence.foreign_key_violations !== 0
    || evidence.relevant_rows_hash !== input.base.relevant_rows_hash
    || evidence.representative_query_hash !== hashLegacyImportValue(rows)
    || evidence.representative_query_count !== rows.length
    || evidence.representative_queries !== "ok"
  ) {
    throw drillError(
      "LEGACY_IMPORT_BACKUP_VERIFIED_BASE_MISMATCH",
      "restore drill fresh-process evidence does not match the isolated approved base",
      "verification",
    );
  }
}

function resultFor(input: LegacyImportBackupRestoreDrillInput): LegacyImportBackupRestoreDrillResult {
  return deepFreeze({
    backup_id: input.backup.backup_id,
    backup_sha256: input.backup.backup_sha256,
    backup_byte_size: input.backup.backup_byte_size,
    quick_check: "ok",
    integrity_check: "ok",
    foreign_key_violations: 0,
    representative_queries: "ok",
  });
}

export function _drillLegacyImportBackupRestoreForTest(
  value: LegacyImportBackupRestoreDrillInput,
  overrides: Partial<LegacyImportBackupRestoreDrillDependencies> = {},
): LegacyImportBackupRestoreDrillResult {
  const input = detachedInput(value);
  const ops = dependencies(overrides);
  ops.boundary?.("after-source-verification");

  let directory: OwnedDrillDirectory | undefined;
  let result: LegacyImportBackupRestoreDrillResult | undefined;
  let failure: unknown;
  try {
    directory = requireOwnedDirectory(ops.makeDrillDirectory());
    const stagingPath = join(directory.path, STAGING_NAME);
    const isolatedPath = join(directory.path, ISOLATED_NAME);
    const sourceIdentity = requireRestoreFile(
      input.backup.backup_ref,
      input.backup.backup_byte_size,
    );

    ops.copyFile(input.backup.backup_ref, stagingPath);
    const stagingIdentity = requireRestoreFile(
      stagingPath,
      input.backup.backup_byte_size,
      undefined,
      sourceIdentity,
    );
    ops.boundary?.("after-stage", { staging_path: stagingPath });
    ops.fsync(stagingPath);
    ops.boundary?.("after-flush", { staging_path: stagingPath });
    verifyLegacyImportBackupArtifact({
      ...input,
      backup: { ...input.backup, backup_ref: stagingPath },
    });
    confirmOwnedDirectory(directory);
    requireRestoreFile(input.backup.backup_ref, input.backup.backup_byte_size, sourceIdentity);
    requireRestoreFile(stagingPath, input.backup.backup_byte_size, stagingIdentity, sourceIdentity);

    ops.link(stagingPath, isolatedPath);
    confirmOwnedDirectory(directory);
    const isolatedIdentity = requireRestoreFile(
      isolatedPath,
      input.backup.backup_byte_size,
      stagingIdentity,
      sourceIdentity,
    );
    ops.fsync(isolatedPath);
    requireRestoreFile(stagingPath, input.backup.backup_byte_size, stagingIdentity, sourceIdentity);
    requireRestoreFile(isolatedPath, input.backup.backup_byte_size, isolatedIdentity, sourceIdentity);
    ops.syncDirectory(directory.path);
    confirmOwnedDirectory(directory);
    unlinkSync(stagingPath);
    ops.syncDirectory(directory.path);
    confirmOwnedDirectory(directory);
    requireRestoreFile(isolatedPath, input.backup.backup_byte_size, isolatedIdentity, sourceIdentity);
    ops.boundary?.("after-publish", { isolated_path: isolatedPath });

    const evidence = ops.verifyInFreshProcess({ ...input, isolatedPath });
    requireChildEvidence(evidence, input, isolatedPath);
    ops.boundary?.("after-fresh-process-verification", {
      ...evidence,
      isolated_path: isolatedPath,
    });
    confirmOwnedDirectory(directory);
    const finalVerification = verifyLegacyImportBackupArtifact({
      ...input,
      backup: { ...input.backup, backup_ref: isolatedPath },
    });
    if (finalVerification.opened_path !== isolatedPath) {
      throw drillError(
        "LEGACY_IMPORT_BACKUP_OPEN_FAILED",
        "restore drill final verification opened an unexpected database",
        "verification",
      );
    }
    requireRestoreFile(isolatedPath, input.backup.backup_byte_size, isolatedIdentity, sourceIdentity);
    verifyLegacyImportBackupArtifact(input);
    result = resultFor(input);
  } catch (error) {
    failure = error;
  }

  if (directory !== undefined) {
    try {
      ops.removeDrillDirectory(directory);
      directory = undefined;
    } catch (cleanupError) {
      const cleanupFailure = drillError(
        "LEGACY_IMPORT_BACKUP_STAGING_CLEANUP_FAILED",
        "restore drill cleanup failed",
        "cleanup",
      );
      if (failure === undefined) {
        failure = cleanupFailure;
      } else {
        // The drill body failure stays primary; the cleanup failure is
        // chained at the end of its cause chain so a cleanup crash can never
        // silently discard the original error.
        let tail = failure;
        while (tail instanceof Error && tail.cause instanceof Error) tail = tail.cause;
        if (tail instanceof Error) {
          try {
            tail.cause = cleanupFailure;
          } catch {
            // a frozen primary cannot carry the chain; the primary still wins
          }
        }
      }
    }
  }
  if (failure !== undefined) throw failure;
  ops.boundary?.("after-cleanup");
  return result!;
}

export function drillLegacyImportBackupRestore(
  input: LegacyImportBackupRestoreDrillInput,
): LegacyImportBackupRestoreDrillResult {
  return _drillLegacyImportBackupRestoreForTest(input);
}

function workerEvidence(input: FreshProcessInput): FreshProcessEvidence {
  const backup = { ...input.backup, backup_ref: input.isolatedPath };
  const verification = verifyLegacyImportBackupArtifact({
    backup,
    preview: input.preview,
    base: input.base,
  });
  const rows = representativeRows(verification.independent_base);
  return {
    pid: process.pid,
    opened_path: verification.opened_path,
    quick_check: verification.quick_check,
    integrity_check: verification.integrity_check,
    foreign_key_violations: verification.foreign_key_violations,
    relevant_rows_hash: verification.independent_base.relevant_rows_hash,
    representative_query_hash: hashLegacyImportValue(rows),
    representative_query_count: rows.length,
    representative_queries: "ok",
  };
}

function runWorker(): void {
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as FreshProcessInput;
    process.stdout.write(JSON.stringify(workerEvidence(input)));
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : "restore drill worker failed");
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain && process.argv[2] === WORKER_ARGUMENT) runWorker();
