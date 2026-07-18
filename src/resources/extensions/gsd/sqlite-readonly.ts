// Project/App: gsd-pi
// File Purpose: Narrow provider-portable SQLite opener for untrusted read-only inspection.

import { createRequire } from "node:module";
import { resolve } from "node:path";

import { createDbAdapter, type DbAdapter } from "./db-adapter.js";
import { BETTER_SQLITE3_PACKAGE } from "./db-provider.js";

export interface SqliteReadOnlyConnection {
  db: DbAdapter;
  enableDefensive?(): void;
}

export class SqliteReadOnlyProviderUnavailableError extends Error {
  constructor() {
    super("no SQLite provider is available for read-only inspection");
    this.name = "SqliteReadOnlyProviderUnavailableError";
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

function openRawSqliteReadOnly(path: string): SqliteReadOnlyConnection {
  const require = systemRequire();
  let nodeSqlite: unknown;
  try {
    nodeSqlite = require("node:sqlite");
  } catch {
    nodeSqlite = undefined;
  }
  const NodeDatabase = (nodeSqlite as { DatabaseSync?: new (path: string, options: object) => unknown } | undefined)
    ?.DatabaseSync;
  if (NodeDatabase !== undefined) {
    const raw = new NodeDatabase(path, {
      readOnly: true,
      allowExtension: false,
      enableForeignKeyConstraints: false,
      timeout: 0,
    }) as { enableDefensive?(active: boolean): void };
    return {
      db: createDbAdapter(raw),
      ...(typeof raw.enableDefensive === "function"
        ? { enableDefensive: () => raw.enableDefensive!(true) }
        : {}),
    };
  }

  let betterSqlite: unknown;
  try {
    betterSqlite = require(BETTER_SQLITE3_PACKAGE);
  } catch {
    betterSqlite = undefined;
  }
  const BetterDatabase = typeof betterSqlite === "function"
    ? betterSqlite
    : (betterSqlite as { default?: unknown } | undefined)?.default;
  if (typeof BetterDatabase !== "function") throw new SqliteReadOnlyProviderUnavailableError();

  const raw = new (BetterDatabase as new (path: string, options: object) => unknown)(path, {
    readonly: true,
    fileMustExist: true,
    timeout: 0,
  });
  return { db: createDbAdapter(raw) };
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

export function openSqliteReadOnly(path: string): SqliteReadOnlyConnection {
  const connection = openRawSqliteReadOnly(path);
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
