// Project/App: gsd-pi
// File Purpose: Narrow provider-portable SQLite opener for untrusted read-only inspection.

import { createRequire } from "node:module";
import { fstatSync, lstatSync, readdirSync, readSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  acquireSqliteFileIdentityLock,
  isSqliteFileIdentityLockAvailable,
} from "@gsd/native/file-identity";

import { createDbAdapter, type DbAdapter } from "./db-adapter.js";
import { GSDError, GSD_STALE_STATE } from "./errors.js";

export interface SqliteReadOnlyConnection {
  db: DbAdapter;
  openedPath?: string;
  enableDefensive?(): void;
}

export class SqliteReadOnlyProviderUnavailableError extends Error {
  constructor() {
    super("no SQLite provider is available for read-only inspection");
    this.name = "SqliteReadOnlyProviderUnavailableError";
  }
}

export class SqliteReadOnlyCapabilityUnavailableError extends Error {
  constructor(capability: string) {
    super(
      `the available SQLite provider does not support ${capability} for read-only inspection`,
    );
    this.name = "SqliteReadOnlyCapabilityUnavailableError";
  }
}

export class SqliteReadOnlyConfigurationError extends Error {
  constructor() {
    super("SQLite read-only safeguards could not be configured");
    this.name = "SqliteReadOnlyConfigurationError";
  }
}

export class SqliteReadOnlyConfigurationCloseError extends Error {
  constructor() {
    super("SQLite read-only connection failed configuration and close");
    this.name = "SqliteReadOnlyConfigurationCloseError";
  }
}

function systemRequire(): ReturnType<typeof createRequire> {
  const packageRoot = process.env.GSD_WEB_PACKAGE_ROOT || process.env.GSD_PKG_ROOT || process.cwd();
  return createRequire(resolve(packageRoot, "package.json"));
}

export interface SqliteFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly release?: () => void;
}

export interface SqliteOpenIdentityCapture {
  readonly before?: SqliteFileIdentity;
  readonly descriptors: ReadonlyMap<number, string> | null;
  readonly windowsLock?: { close(): void };
  readonly exact: boolean;
}

let sqliteReadOnlyOpenBoundaryForTest: Readonly<{
  beforeRaw?: (path: string) => void;
  afterRaw?: (path: string) => void;
  afterRelease?: () => void;
}> | null = null;

export function _setSqliteReadOnlyOpenBoundaryForTest(boundary: typeof sqliteReadOnlyOpenBoundaryForTest): void {
  sqliteReadOnlyOpenBoundaryForTest = boundary;
}

let nodeSqliteModuleLoaderForTest: (() => unknown) | null = null;

export function _setSqliteReadOnlyNodeSqliteLoaderForTest(loader: (() => unknown) | null): void {
  nodeSqliteModuleLoaderForTest = loader;
}

function fileIdentity(path: string): SqliteFileIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("SQLite path is not a regular file");
  return { device: stat.dev, inode: stat.ino };
}

function sameIdentity(left: SqliteFileIdentity, right: SqliteFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function openFileDescriptors(): ReadonlyMap<number, string> | null {
  let entries: string[] | null = null;
  for (const directory of ["/proc/self/fd", "/dev/fd"]) {
    try {
      entries = readdirSync(directory);
      break;
    } catch {
      continue;
    }
  }
  if (entries === null) return null;
  return new Map(entries
    .filter((entry) => /^(?:0|[1-9][0-9]*)$/.test(entry))
    .map(Number)
    .flatMap((descriptor): Array<[number, string]> => {
      try {
        const stat = fstatSync(descriptor, { bigint: true });
        return [[descriptor, `${stat.dev}:${stat.ino}:${stat.mode}`]];
      } catch {
        return [];
      }
    }));
}

function openedSqliteFileIdentity(previous: ReadonlyMap<number, string>): SqliteFileIdentity | undefined {
  const header = Buffer.alloc(16);
  const sqliteCandidates = new Map<string, SqliteFileIdentity>();
  const emptyCandidates = new Map<string, SqliteFileIdentity>();
  for (const [descriptor, descriptorIdentity] of openFileDescriptors() ?? []) {
    if (previous.get(descriptor) === descriptorIdentity) continue;
    try {
      const stat = fstatSync(descriptor, { bigint: true });
      if (!stat.isFile()) continue;
      const bytesRead = readSync(descriptor, header, 0, header.length, 0);
      const identity = { device: stat.dev, inode: stat.ino };
      const key = `${identity.device}:${identity.inode}`;
      if (bytesRead === header.length && header.toString("binary") === "SQLite format 3\0") {
        sqliteCandidates.set(key, identity);
      } else if (stat.size === 0n) {
        emptyCandidates.set(key, identity);
      }
    } catch {
      continue;
    }
  }
  const candidates = [...(sqliteCandidates.size > 0 ? sqliteCandidates : emptyCandidates).values()];
  if (candidates.length > 1) throw new Error("SQLite handle correlated to multiple file identities");
  return candidates[0];
}

function acquireWindowsLock(path: string, create: boolean): { close(): void } {
  return acquireSqliteFileIdentityLock(path, create);
}

export function captureSqliteOpenIdentity(
  path: string,
  create = false,
  requireExactIdentity = false,
): SqliteOpenIdentityCapture {
  const descriptors = openFileDescriptors();
  const windowsLock = descriptors === null
    && process.platform === "win32"
    && isSqliteFileIdentityLockAvailable()
    ? acquireWindowsLock(path, create)
    : undefined;
  let before: SqliteFileIdentity | undefined;
  try {
    before = fileIdentity(path);
  } catch (error) {
    windowsLock?.close();
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
  }
  const exact = descriptors !== null || windowsLock !== undefined;
  if (requireExactIdentity && !exact) {
    throw new Error("exact SQLite handle identity correlation is unavailable");
  }
  return { before, descriptors, windowsLock, exact };
}

export function releaseSqliteOpenIdentityCapture(capture: SqliteOpenIdentityCapture): void {
  try {
    capture.windowsLock?.close();
  } finally {
    sqliteReadOnlyOpenBoundaryForTest?.afterRelease?.();
  }
}

export function correlateSqliteOpenIdentity(
  path: string,
  capture: SqliteOpenIdentityCapture,
  raw: unknown,
): SqliteFileIdentity {
  const probe = createDbAdapter(raw);
  probe.prepare("PRAGMA schema_version").get();
  const main = probe.prepare("PRAGMA database_list").all().find((row) => row["seq"] === 0 && row["name"] === "main");
  if (!main || typeof main["file"] !== "string" || realpathSync(main["file"]) !== realpathSync(path)) {
    throw new Error("SQLite handle did not report the requested canonical database path");
  }
  const after = fileIdentity(path);
  const opened = capture.descriptors === null
    ? capture.before ?? (capture.exact ? undefined : after)
    : openedSqliteFileIdentity(capture.descriptors) ?? after;
  if (opened === undefined) throw new Error("SQLite handle identity was not captured");
  if ((capture.before && !sameIdentity(capture.before, after)) || !sameIdentity(opened, after)) {
    throw new Error("SQLite path changed while its handle opened");
  }
  return capture.windowsLock === undefined
    ? opened
    : { ...opened, release: () => capture.windowsLock!.close() };
}

function fileBoundAdapter(raw: unknown, path: string, expected: SqliteFileIdentity): DbAdapter {
  const adapter = createDbAdapter(raw, () => {
    if (!sameIdentity(expected, fileIdentity(path))) {
      throw new GSDError(GSD_STALE_STATE, "SQLite read-only handle is detached from its path");
    }
  });
  return {
    ...adapter,
    close(): void {
      try {
        adapter.close();
      } finally {
        expected.release?.();
      }
    },
  };
}

export interface SqliteReadOnlyOpenOptions {
  readonly immutable?: boolean;
}

function openRawSqliteReadOnly(
  path: string,
  options: SqliteReadOnlyOpenOptions = {},
): SqliteReadOnlyConnection {
  const capture = captureSqliteOpenIdentity(path, false, true);
  let raw: { enableDefensive?(active: boolean): void; close(): void } | undefined;
  let captureTransferred = false;
  try {
    sqliteReadOnlyOpenBoundaryForTest?.beforeRaw?.(path);
    const require = systemRequire();
    let nodeSqlite: unknown;
    if (nodeSqliteModuleLoaderForTest !== null) {
      nodeSqlite = nodeSqliteModuleLoaderForTest();
    } else {
      try {
        nodeSqlite = require("node:sqlite");
      } catch {
        nodeSqlite = undefined;
      }
    }
    const NodeDatabase = (nodeSqlite as { DatabaseSync?: new (path: string | URL, options: object) => unknown } | undefined)
      ?.DatabaseSync;
    if (NodeDatabase !== undefined) {
      let openPath: string | URL = path;
      if (options.immutable) {
        openPath = pathToFileURL(path);
        openPath.searchParams.set("immutable", "1");
      }
      const nodeRaw = new NodeDatabase(openPath, {
        readOnly: true,
        allowExtension: false,
        enableForeignKeyConstraints: false,
        timeout: 0,
      }) as { enableDefensive?(active: boolean): void; close(): void };
      raw = nodeRaw;
      sqliteReadOnlyOpenBoundaryForTest?.afterRaw?.(path);
      const identity = correlateSqliteOpenIdentity(path, capture, nodeRaw);
      captureTransferred = true;
      return {
        db: fileBoundAdapter(nodeRaw, path, identity),
        openedPath: path,
        ...(typeof nodeRaw.enableDefensive === "function"
          ? { enableDefensive: () => nodeRaw.enableDefensive!(true) }
          : {}),
      };
    }

    if (options.immutable) {
      throw new SqliteReadOnlyCapabilityUnavailableError("immutable mode (requires node:sqlite)");
    }
    throw new SqliteReadOnlyProviderUnavailableError();
  } finally {
    if (!captureTransferred) {
      try {
        raw?.close();
      } finally {
        releaseSqliteOpenIdentityCapture(capture);
      }
    }
  }
}

function requirePragma(db: DbAdapter, name: string, expected: number): void {
  const rows = db.prepare(`PRAGMA ${name}`).all();
  const row = rows[0];
  if (
    rows.length !== 1
    || row === undefined
    || Object.keys(row).length !== 1
    || !Object.hasOwn(row, name)
    || row[name] !== expected
  ) throw new Error(`SQLite read-only safeguard ${name} was not applied`);
}

export function configureSqliteReadOnly(connection: SqliteReadOnlyConnection): void {
  connection.enableDefensive?.();
  connection.db.exec("PRAGMA query_only=ON");
  connection.db.exec("PRAGMA trusted_schema=OFF");
  connection.db.exec("PRAGMA cell_size_check=ON");
  connection.db.exec("PRAGMA mmap_size=0");
  requirePragma(connection.db, "query_only", 1);
  requirePragma(connection.db, "trusted_schema", 0);
  requirePragma(connection.db, "cell_size_check", 1);
  requirePragma(connection.db, "mmap_size", 0);
}

export function openSqliteReadOnly(
  path: string,
  options: SqliteReadOnlyOpenOptions = {},
): SqliteReadOnlyConnection {
  const connection = openRawSqliteReadOnly(path, options);
  try {
    configureSqliteReadOnly(connection);
    return connection;
  } catch {
    try {
      connection.db.close();
    } catch {
      throw new SqliteReadOnlyConfigurationCloseError();
    }
    throw new SqliteReadOnlyConfigurationError();
  }
}

export function inspectSqliteReadOnlySnapshot<T>(path: string, inspect: (db: DbAdapter) => T): T {
  const connection = openSqliteReadOnly(path);
  let transactionOpen = false;
  let failure: unknown;
  let result: T | undefined;
  try {
    connection.db.exec("BEGIN");
    transactionOpen = true;
    result = inspect(connection.db);
  } catch (error) {
    failure = error;
  } finally {
    if (transactionOpen) {
      try {
        connection.db.exec("ROLLBACK");
      } catch (error) {
        if (failure === undefined) failure = error;
      }
    }
    try {
      connection.db.close();
    } catch (error) {
      if (failure === undefined) failure = error;
    }
  }
  if (failure !== undefined) throw failure;
  if (result === undefined) throw new Error("SQLite read-only snapshot returned no result");
  return result;
}
