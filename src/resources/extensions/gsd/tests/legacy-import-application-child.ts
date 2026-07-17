// Project/App: gsd-pi
// File Purpose: Real-process fault and contention worker for legacy Import Application tests.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { DbAdapter, DbStatement } from "../db-adapter.ts";
import {
  _setDomainOperationFaultForTest,
  type DomainOperationFaultPoint,
} from "../db/domain-operation.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import {
  _setLegacyImportApplicationBoundaryForTest,
  applyLegacyImport,
  type LegacyImportApplicationBoundaryPoint,
} from "../legacy-import-application.ts";

interface ChildConfig {
  databasePath: string;
  applicationInputPath: string;
  barrier?: {
    readyPath: string;
    releasePath: string;
  };
  crash?: {
    sqlPattern: string;
    occurrence: number;
  };
  domainFault?: DomainOperationFaultPoint;
  applicationBoundary?: LegacyImportApplicationBoundaryPoint;
  killAfterApply?: boolean;
  committedPath?: string;
}

interface ChildError {
  code: string;
  message: string;
  stage?: string;
  retryable?: boolean;
}

type ChildOutcome =
  | { receipt: ReturnType<typeof applyLegacyImport> }
  | { error: ChildError };

function terminate(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL did not terminate the legacy import Application worker");
}

function waitForRelease(path: string): void {
  const deadline = Date.now() + 30_000;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for release barrier: ${path}`);
    Atomics.wait(waiter, 0, 0, 5);
  }
}

function normalizeSql(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function installSqlCrash(
  adapter: DbAdapter,
  crash: NonNullable<ChildConfig["crash"]>,
): () => void {
  if (!Number.isSafeInteger(crash.occurrence) || crash.occurrence < 1) {
    throw new Error("legacy import Application crash occurrence must be a positive safe integer");
  }
  const pattern = normalizeSql(crash.sqlPattern);
  if (pattern.length === 0) throw new Error("legacy import Application crash SQL pattern must not be blank");

  const originalPrepare = adapter.prepare;
  let occurrence = 0;
  adapter.prepare = (sql: string): DbStatement => {
    const statement = originalPrepare.call(adapter, sql);
    if (!normalizeSql(sql).includes(pattern)) return statement;
    return {
      run(...params: unknown[]): unknown {
        const result = statement.run(...params);
        occurrence += 1;
        if (occurrence === crash.occurrence) terminate();
        return result;
      },
      get(...params: unknown[]): Record<string, unknown> | undefined {
        return statement.get(...params);
      },
      all(...params: unknown[]): Record<string, unknown>[] {
        return statement.all(...params);
      },
    };
  };
  return () => {
    adapter.prepare = originalPrepare;
  };
}

function childError(error: unknown): ChildError {
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    stage?: unknown;
    retryable?: unknown;
  };
  return {
    code: typeof candidate.code === "string" ? candidate.code : "UNKNOWN",
    message: typeof candidate.message === "string" ? candidate.message : String(error),
    ...(typeof candidate.stage === "string" ? { stage: candidate.stage } : {}),
    ...(typeof candidate.retryable === "boolean" ? { retryable: candidate.retryable } : {}),
  };
}

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main(): void {
  let databaseOpen = false;
  let restorePrepare: (() => void) | undefined;
  let outcome: ChildOutcome;
  try {
    const configPath = process.argv[2];
    if (configPath === undefined) throw new Error("legacy import Application worker requires a config path");
    const config = loadJson(configPath) as ChildConfig;
    if (!openDatabase(config.databasePath)) {
      throw new Error("legacy import Application worker could not open its database");
    }
    databaseOpen = true;
    const applicationInput = loadJson(config.applicationInputPath);

    if (config.barrier) {
      writeFileSync(config.barrier.readyPath, String(process.pid), "utf8");
      waitForRelease(config.barrier.releasePath);
    }
    if (config.crash) {
      const adapter = _getAdapter();
      if (!adapter) throw new Error("legacy import Application worker database adapter is unavailable");
      restorePrepare = installSqlCrash(adapter, config.crash);
    }
    if (config.domainFault) _setDomainOperationFaultForTest(config.domainFault);
    if (config.applicationBoundary) {
      _setLegacyImportApplicationBoundaryForTest((boundary) => {
        if (boundary === config.applicationBoundary) terminate();
      });
    }

    const receipt = applyLegacyImport(applicationInput);
    if (config.killAfterApply) {
      if (config.committedPath) writeFileSync(config.committedPath, receipt.operationId, "utf8");
      terminate();
    }
    outcome = { receipt };
  } catch (error) {
    outcome = { error: childError(error) };
  } finally {
    _setDomainOperationFaultForTest(null);
    _setLegacyImportApplicationBoundaryForTest(null);
    restorePrepare?.();
    if (databaseOpen) closeDatabase();
  }
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

main();
