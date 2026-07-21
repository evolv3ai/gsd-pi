// Project/App: gsd-pi
// File Purpose: Real-process crash and contention worker for live legacy import restore tests.

import { readFileSync, writeFileSync, writeSync } from "node:fs";

import { executeDomainOperation } from "../db/domain-operation.ts";
import {
  _setMaintenanceLockHooksForTest,
  checkpointDatabase,
} from "../db/engine.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { _restoreLegacyImportLiveForTest } from "../legacy-import-live-restore.ts";
import {
  cutoverProjectAuthority,
  inspectProjectAuthorityCutoverEvidence,
  PROJECT_AUTHORITY_CONTRACT_VERSION,
  PROJECT_AUTHORITY_CUTOVER_CONSENT_SCHEMA_VERSION,
} from "../project-authority-cutover-domain-operation.ts";

interface RestoreChildConfig {
  action: "restore";
  databasePath: string;
  inputPath: string;
  pauseBoundary?: string;
  crashBoundary?: string;
  busyTimeoutMs?: number;
  tamperPublishedDatabase?: boolean;
}

interface WriterChildConfig {
  action: "writer";
  databasePath: string;
  expectedRevision: number;
  expectedAuthorityEpoch: number;
  idempotencyKey: string;
  pauseBeforeBegin?: boolean;
  pauseAfterBegin?: boolean;
}

interface CutoverChildConfig {
  action: "cutover";
  databasePath: string;
  idempotencyKey: string;
  pauseBeforeBegin?: boolean;
  pauseAfterBegin?: boolean;
}

interface MaintenanceChildConfig {
  action: "maintenance";
  databasePath: string;
  pauseBeforeLock?: boolean;
  pauseAfterClaim?: boolean;
}

interface WalReaderChildConfig {
  action: "wal-reader";
  databasePath: string;
}

type ChildConfig = RestoreChildConfig | WriterChildConfig | CutoverChildConfig | MaintenanceChildConfig | WalReaderChildConfig;

interface ChildError {
  code: string;
  message: string;
  stage?: string;
  retryable?: boolean;
}

function terminate(): never {
  process.kill(process.pid, "SIGKILL");
  throw new Error("SIGKILL did not terminate the live restore worker");
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

function ready(boundary: string): void {
  writeSync(1, `READY=${JSON.stringify({ boundary, pid: process.pid })}\n`);
  readFileSync(0, "utf8");
}

function runRestore(config: RestoreChildConfig): unknown {
  if (config.busyTimeoutMs !== undefined) {
    _getAdapter()?.exec(`PRAGMA busy_timeout = ${config.busyTimeoutMs}`);
  }
  const input = JSON.parse(readFileSync(config.inputPath, "utf8"));
  let tampered = false;
  return _restoreLegacyImportLiveForTest(input, {
    boundary(point) {
      if (config.tamperPublishedDatabase && !tampered && point === "after-database-publish") {
        tampered = true;
        const bytes = readFileSync(config.databasePath);
        const changed = (bytes.readUInt32BE(24) + 1) >>> 0;
        bytes.writeUInt32BE(changed, 24);
        bytes.writeUInt32BE(changed, 92);
        writeFileSync(config.databasePath, bytes);
      }
      if (point === config.crashBoundary) terminate();
      if (point === config.pauseBoundary) ready(point);
    },
  });
}

function installBeginPause(config: {
  pauseBeforeBegin?: boolean;
  pauseAfterBegin?: boolean;
}): void {
  const adapter = _getAdapter();
  if (!adapter) throw new Error("live restore writer adapter is unavailable");
  const originalExec = adapter.exec;
  if (config.pauseBeforeBegin || config.pauseAfterBegin) {
    let paused = false;
    adapter.exec = (sql: string): void => {
      if (!paused && sql.trim().toLowerCase() === "begin immediate") {
        paused = true;
        if (config.pauseBeforeBegin) ready("before-writer-lock");
        originalExec.call(adapter, sql);
        if (config.pauseAfterBegin) ready("writer-lock");
        return;
      }
      originalExec.call(adapter, sql);
    };
  }
}

function runWriter(config: WriterChildConfig): unknown {
  installBeginPause(config);
  return executeDomainOperation({
    operationType: "milestone.describe",
    idempotencyKey: config.idempotencyKey,
    expectedRevision: config.expectedRevision,
    expectedAuthorityEpoch: config.expectedAuthorityEpoch,
    actorType: "agent",
    actorId: "live-restore-fault-test",
    sourceTransport: "internal",
    payload: { accepted: true },
  }, () => ({
    events: [{
      eventType: "milestone.described",
      entityType: "milestone",
      entityId: "M001",
      payload: { accepted: true },
      destinations: ["projection"],
    }],
    projections: [{
      projectionKey: "milestone/m001",
      projectionKind: "state",
      rendererVersion: "v1",
    }],
  }));
}

function runCutover(config: CutoverChildConfig): unknown {
  const evidence = inspectProjectAuthorityCutoverEvidence();
  installBeginPause(config);
  return cutoverProjectAuthority({
    invocation: {
      idempotencyKey: config.idempotencyKey,
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "live-restore-fault-test",
    },
    expectedRevision: evidence.projectRevision,
    expectedAuthorityEpoch: evidence.authorityEpoch,
    authorityContractVersion: PROJECT_AUTHORITY_CONTRACT_VERSION,
    evidenceHash: evidence.evidenceHash,
    consent: {
      consentSchemaVersion: PROJECT_AUTHORITY_CUTOVER_CONSENT_SCHEMA_VERSION,
      decision: "proceed",
      irreversibleAuthorityCutover: true,
      evidenceHash: evidence.evidenceHash,
    },
  });
}

function runMaintenance(config: MaintenanceChildConfig): unknown {
  _setMaintenanceLockHooksForTest({
    ...(config.pauseBeforeLock ? { beforeLock: () => ready("before-maintenance-lock") } : {}),
    ...(config.pauseAfterClaim ? { afterClaim: () => ready("maintenance-claim") } : {}),
  });
  try {
    checkpointDatabase();
    return { status: "completed" };
  } finally {
    _setMaintenanceLockHooksForTest(null);
  }
}

function runWalReader(_config: WalReaderChildConfig): unknown {
  const adapter = _getAdapter();
  if (!adapter) throw new Error("live restore wal reader adapter is unavailable");
  // Commit one harmless page write so the WAL holds a committed frame, then
  // hold a read snapshot: a TRUNCATE checkpoint cannot reset the WAL while
  // this snapshot is open, so a restore detaching the active database
  // observes busy contention until the snapshot is released.
  const row = adapter.prepare("PRAGMA user_version").get();
  const current = typeof row?.["user_version"] === "number" ? row["user_version"] : 0;
  adapter.exec(`PRAGMA user_version = ${current}`);
  adapter.exec("BEGIN");
  adapter.prepare("SELECT COUNT(*) AS count FROM milestones").get();
  ready("reader-snapshot");
  adapter.exec("ROLLBACK");
  return { status: "released" };
}

function main(): void {
  let databaseOpen = false;
  let outcome: unknown;
  try {
    const configPath = process.argv[2];
    if (!configPath) throw new Error("live restore worker requires a config path");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as ChildConfig;
    if (!openDatabase(config.databasePath)) throw new Error("live restore worker could not open its database");
    databaseOpen = true;
    if (config.action === "restore") {
      outcome = { result: runRestore(config) };
    } else if (config.action === "writer") {
      outcome = { result: runWriter(config) };
    } else if (config.action === "cutover") {
      outcome = { result: runCutover(config) };
    } else if (config.action === "wal-reader") {
      outcome = { result: runWalReader(config) };
    } else {
      outcome = { result: runMaintenance(config) };
    }
  } catch (error) {
    outcome = { error: childError(error) };
  } finally {
    if (databaseOpen) closeDatabase();
  }
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

main();
