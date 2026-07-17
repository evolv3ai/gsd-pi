// Project/App: gsd-pi
// File Purpose: Public fault, crash, restart, and lost-response proof for legacy Import Application.

import assert from "node:assert/strict";
import {
  spawn,
  spawnSync,
  type ChildProcessByStdio,
  type SpawnSyncReturns,
} from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  prepareLegacyImportBackup,
  type LegacyImportVerifiedBackup,
} from "../legacy-import-backup.ts";
import * as applicationModule from "../legacy-import-application.ts";
import {
  LegacyImportApplicationError,
  applyLegacyImport,
  createLegacyImportApplicationIdentity,
  type LegacyImportApplicationInput,
  type LegacyImportApplicationReceipt,
} from "../legacy-import-application.ts";
import {
  createLegacyImportPreview,
} from "../legacy-import-preview.ts";
import {
  captureCurrentLegacyImportBaseSnapshot,
  type LegacyImportBaseSnapshot,
} from "../legacy-import-preview-base.ts";
import {
  _setDomainOperationFaultForTest,
  type DomainOperationFaultPoint,
} from "../db/domain-operation.ts";
import type { DbAdapter, DbStatement } from "../db-adapter.ts";
import {
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";
import { createLegacyImportCorpusSourceRoots } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = fileURLToPath(new URL(
  "./__fixtures__/legacy-import-corpus/v1/",
  import.meta.url,
));
const CHILD_PATH = fileURLToPath(new URL("./legacy-import-application-child.ts", import.meta.url));
const RESOLVER_PATH = fileURLToPath(new URL("./resolve-ts.mjs", import.meta.url));
const tempDirectories = new Set<string>();
let applicationSequence = 0;
let childSequence = 0;

const DOMAIN_PRECOMMIT_FAULTS: readonly DomainOperationFaultPoint[] = [
  "after-operation",
  "after-mutation",
  "after-events",
  "after-outbox",
  "after-projections",
  "before-cas",
];

const APPLICATION_BOUNDARIES = [
  "after-coordination",
  "after-final-validation",
  "after-plan",
  "after-receipt",
] as const;

type ApplicationBoundary = typeof APPLICATION_BOUNDARIES[number];
type ApplicationBoundaryCallback = (boundary: ApplicationBoundary) => void;
type ApplicationBoundarySetter = (callback: ApplicationBoundaryCallback | null) => void;

interface PreparedApplicationCase {
  workspace: string;
  databasePath: string;
  base: LegacyImportBaseSnapshot;
  backup: LegacyImportVerifiedBackup;
  input: LegacyImportApplicationInput;
}

interface ChildConfig {
  databasePath: string;
  applicationInputPath: string;
  applicationBoundary?: ApplicationBoundary;
  domainFault?: DomainOperationFaultPoint;
  crash?: {
    sqlPattern: string;
    occurrence: number;
  };
  barrier?: {
    readyPath: string;
    releasePath: string;
  };
  transactionBarrier?: {
    readyPath: string;
    releasePath: string;
  };
  killAfterApply?: boolean;
  committedPath?: string;
}

type MutationFixture = "gsd-nested" | "planning-flat-complete" | "decision-create";

interface MutationFaultCase {
  family: string;
  fixture: MutationFixture;
  sqlPattern: string;
  occurrence: number;
}

interface SqlFaultController {
  hitCount(): number;
  restore(): void;
}

interface ChildErrorOutcome {
  code: string;
  message: string;
  stage?: string;
  retryable?: boolean;
}

type ChildOutcome =
  | { receipt: LegacyImportApplicationReceipt }
  | { error: ChildErrorOutcome };

const MUTATION_FAULT_CASES: readonly MutationFaultCase[] = [
  { family: "operation insert", fixture: "gsd-nested", sqlPattern: "insert into workflow_operations", occurrence: 1 },
  { family: "row create", fixture: "gsd-nested", sqlPattern: "insert into tasks", occurrence: 1 },
  { family: "dependency replacement", fixture: "gsd-nested", sqlPattern: "insert into slice_dependencies", occurrence: 1 },
  { family: "lifecycle adoption", fixture: "planning-flat-complete", sqlPattern: "insert into workflow_item_lifecycles", occurrence: 1 },
  { family: "decision-memory write", fixture: "decision-create", sqlPattern: "insert into memories", occurrence: 1 },
  { family: "receipt insert", fixture: "gsd-nested", sqlPattern: "insert into workflow_import_applications", occurrence: 1 },
  { family: "event", fixture: "gsd-nested", sqlPattern: "insert into workflow_domain_events", occurrence: 1 },
  { family: "outbox", fixture: "gsd-nested", sqlPattern: "insert into workflow_outbox", occurrence: 1 },
  { family: "projection work", fixture: "gsd-nested", sqlPattern: "insert into workflow_projection_work", occurrence: 1 },
  { family: "authority CAS", fixture: "gsd-nested", sqlPattern: "update project_authority", occurrence: 1 },
];

function db(): DbAdapter {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function rows(sql: string, params?: Record<string, unknown>): Array<Record<string, unknown>> {
  const statement = db().prepare(sql);
  return (params === undefined ? statement.all() : statement.all(params)) as Array<Record<string, unknown>>;
}

function tableRows(table: string): Array<Record<string, unknown>> {
  return rows(`SELECT * FROM ${table} ORDER BY rowid`);
}

function durableSnapshot(): Record<string, unknown> {
  return {
    authority: tableRows("project_authority"),
    milestones: tableRows("milestones"),
    slices: tableRows("slices"),
    tasks: tableRows("tasks"),
    dependencies: tableRows("slice_dependencies"),
    requirements: tableRows("requirements"),
    decisions: tableRows("decisions"),
    memories: tableRows("memories"),
    artifacts: tableRows("artifacts"),
    assessments: tableRows("assessments"),
    workers: tableRows("workers"),
    leases: tableRows("milestone_leases"),
    dispatches: tableRows("unit_dispatches"),
    lifecycles: tableRows("workflow_item_lifecycles"),
    attempts: tableRows("workflow_execution_attempts"),
    attemptResults: tableRows("workflow_attempt_results"),
    checkpoints: tableRows("workflow_kernel_checkpoints"),
    operations: tableRows("workflow_operations"),
    applications: tableRows("workflow_import_applications"),
    events: tableRows("workflow_domain_events"),
    outbox: tableRows("workflow_outbox"),
    projections: tableRows("workflow_projection_work"),
  };
}

function prepareCase(fixture: MutationFixture = "gsd-nested"): PreparedApplicationCase {
  applicationSequence += 1;
  const workspace = mkdtempSync(join(tmpdir(), "gsd-legacy-application-fault-"));
  tempDirectories.add(workspace);
  const source = join(workspace, "source");
  const backupDirectory = join(workspace, "backups");
  const databasePath = join(workspace, "canonical.sqlite");
  const corpusFixture = fixture === "decision-create" ? "registries" : fixture;
  cpSync(join(CORPUS_ROOT, corpusFixture, "source"), source, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  if (fixture === "decision-create") {
    rmSync(join(source, ".gsd", "REQUIREMENTS.md"));
    writeFileSync(join(source, ".gsd", "DECISIONS.md"), `# Decisions Register

| # | When | Scope | Decision | Choice | Rationale | Revisable? | Made By |
|---|------|-------|----------|--------|-----------|------------|---------|
| D001 | M001 | storage | Choose persistence | SQLite | Local durable authority | No | agent |
`, "utf8");
  }
  mkdirSync(backupDirectory);
  assert.equal(openDatabase(databasePath), true);
  const previewInput = { roots: createLegacyImportCorpusSourceRoots(source) };
  const base = captureCurrentLegacyImportBaseSnapshot();
  const preview = createLegacyImportPreview(previewInput);
  const backup = prepareLegacyImportBackup({
    preview,
    base,
    roots: previewInput.roots,
    destination_directory: backupDirectory,
    label: "pre-application",
  });
  const input: LegacyImportApplicationInput = {
    invocation: {
      idempotencyKey: `legacy-import/fault-${applicationSequence}`,
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "legacy-import-fault-test",
      traceId: `fault-trace-${applicationSequence}`,
      turnId: `fault-turn-${applicationSequence}`,
    },
    previewInput,
    preview,
    backup,
  };
  return { workspace, databasePath, base, backup, input };
}

function normalizedSql(sql: string): string {
  return sql.trim().replace(/\s+/g, " ").toLowerCase();
}

function installSqlException(
  adapter: DbAdapter,
  sqlPattern: string,
  occurrence: number,
): SqlFaultController {
  const originalPrepare = adapter.prepare;
  const pattern = normalizedSql(sqlPattern);
  let hits = 0;
  adapter.prepare = (sql: string): DbStatement => {
    const statement = originalPrepare.call(adapter, sql);
    if (!normalizedSql(sql).includes(pattern)) return statement;
    return {
      ...statement,
      run(...params: unknown[]): unknown {
        const result = statement.run(...params);
        hits += 1;
        if (hits === occurrence) {
          throw new Error(`injected SQL fault after ${sqlPattern} occurrence ${occurrence}`);
        }
        return result;
      },
    };
  };
  return {
    hitCount: () => hits,
    restore: () => {
      adapter.prepare = originalPrepare;
    },
  };
}

function boundarySetter(): ApplicationBoundarySetter {
  const candidate = (applicationModule as unknown as Record<string, unknown>)[
    "_setLegacyImportApplicationBoundaryForTest"
  ];
  assert.equal(
    typeof candidate,
    "function",
    "legacy Import Application requires a private named-boundary test seam",
  );
  return candidate as ApplicationBoundarySetter;
}

function expectTransactionFailure(run: () => unknown): LegacyImportApplicationError {
  let observed: unknown;
  try {
    run();
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof LegacyImportApplicationError);
  assert.equal(observed.stage, "transaction");
  assert.equal(observed.code, "LEGACY_IMPORT_APPLICATION_MUTATION_FAILED");
  assert.equal(observed.retryable, false);
  return observed;
}

function reopenAndSnapshot(prepared: PreparedApplicationCase): Record<string, unknown> {
  closeDatabase();
  assert.equal(openDatabase(prepared.databasePath), true);
  assert.deepEqual(db().prepare("PRAGMA integrity_check").get(), { integrity_check: "ok" });
  return durableSnapshot();
}

function runChild(
  prepared: PreparedApplicationCase,
  config: Omit<ChildConfig, "databasePath" | "applicationInputPath">,
): SpawnSyncReturns<string> {
  const applicationInputPath = join(prepared.workspace, `application-input-${applicationSequence}.json`);
  const configPath = join(prepared.workspace, `child-config-${applicationSequence}.json`);
  writeFileSync(applicationInputPath, JSON.stringify(prepared.input), "utf8");
  writeFileSync(configPath, JSON.stringify({
    databasePath: prepared.databasePath,
    applicationInputPath,
    ...config,
  } satisfies ChildConfig), "utf8");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [
    "--import",
    RESOLVER_PATH,
    "--experimental-strip-types",
    CHILD_PATH,
    configPath,
  ], {
    cwd: process.cwd(),
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function prepareSiblingCase(
  prepared: PreparedApplicationCase,
  fixture: Exclude<MutationFixture, "decision-create">,
): PreparedApplicationCase {
  applicationSequence += 1;
  const source = join(prepared.workspace, `source-${fixture}-${applicationSequence}`);
  const backupDirectory = join(prepared.workspace, `backups-${fixture}-${applicationSequence}`);
  cpSync(join(CORPUS_ROOT, fixture, "source"), source, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  mkdirSync(backupDirectory);
  const previewInput = { roots: createLegacyImportCorpusSourceRoots(source) };
  const base = captureCurrentLegacyImportBaseSnapshot();
  assert.deepEqual(base, prepared.base);
  const preview = createLegacyImportPreview(previewInput);
  const backup = prepareLegacyImportBackup({
    preview,
    base,
    roots: previewInput.roots,
    destination_directory: backupDirectory,
    label: "pre-application-sibling",
  });
  const input: LegacyImportApplicationInput = {
    invocation: {
      idempotencyKey: `legacy-import/fault-${applicationSequence}`,
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "legacy-import-fault-test",
      traceId: `fault-trace-${applicationSequence}`,
      turnId: `fault-turn-${applicationSequence}`,
    },
    previewInput,
    preview,
    backup,
  };
  return { ...prepared, base, backup, input };
}

function spawnChild(
  prepared: PreparedApplicationCase,
  input: LegacyImportApplicationInput,
  config: Omit<ChildConfig, "databasePath" | "applicationInputPath">,
): ChildProcessByStdio<null, Readable, Readable> {
  childSequence += 1;
  const suffix = `${applicationSequence}-${childSequence}`;
  const applicationInputPath = join(prepared.workspace, `application-input-${suffix}.json`);
  const configPath = join(prepared.workspace, `child-config-${suffix}.json`);
  writeFileSync(applicationInputPath, JSON.stringify(input), "utf8");
  writeFileSync(configPath, JSON.stringify({
    databasePath: prepared.databasePath,
    applicationInputPath,
    ...config,
  } satisfies ChildConfig), "utf8");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawn(process.execPath, [
    "--import",
    RESOLVER_PATH,
    "--experimental-strip-types",
    CHILD_PATH,
    configPath,
  ], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function collectChild(
  child: ChildProcessByStdio<null, Readable, Readable>,
  timeoutMs = 5_000,
): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child outcome timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || signal !== null) {
        reject(new Error(stderr || stdout || `child exited with code ${code} signal ${signal}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as ChildOutcome);
      } catch (error) {
        reject(new Error(`child emitted invalid JSON: ${stdout}`, { cause: error }));
      }
    });
  });
}

async function waitForPath(path: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runConcurrentApplications(
  prepared: PreparedApplicationCase,
  inputs: readonly [LegacyImportApplicationInput, LegacyImportApplicationInput],
): Promise<readonly [ChildOutcome, ChildOutcome]> {
  const startRelease = join(prepared.workspace, `start-release-${childSequence}`);
  const transactionRelease = join(prepared.workspace, `transaction-release-${childSequence}`);
  const startReady = inputs.map((_, index) => join(prepared.workspace, `start-ready-${childSequence}-${index}`));
  const transactionReady = inputs.map((_, index) => (
    join(prepared.workspace, `transaction-ready-${childSequence}-${index}`)
  ));
  const children = inputs.map((input, index) => spawnChild(prepared, input, {
    barrier: { readyPath: startReady[index]!, releasePath: startRelease },
    transactionBarrier: { readyPath: transactionReady[index]!, releasePath: transactionRelease },
  })) as [
    ChildProcessByStdio<null, Readable, Readable>,
    ChildProcessByStdio<null, Readable, Readable>,
  ];
  const outcomes = children.map((child) => collectChild(child)) as [
    Promise<ChildOutcome>,
    Promise<ChildOutcome>,
  ];
  try {
    await Promise.all(startReady.map((path) => waitForPath(path, 1_000, "start barrier")));
    writeFileSync(startRelease, "release", "utf8");
    await Promise.all(transactionReady.map((path) => waitForPath(path, 750, "transaction barrier")));
    writeFileSync(transactionRelease, "release", "utf8");
    return await Promise.all(outcomes);
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.allSettled(outcomes);
  }
}

function assertSingleImportLineage(prepared: PreparedApplicationCase): void {
  assert.deepEqual(rows("SELECT revision, authority_epoch FROM project_authority"), [{
    revision: prepared.base.authority.revision + 1,
    authority_epoch: prepared.base.authority.authority_epoch,
  }]);
  const operations = tableRows("workflow_operations");
  const applications = tableRows("workflow_import_applications");
  const events = tableRows("workflow_domain_events");
  const outbox = tableRows("workflow_outbox");
  const projections = tableRows("workflow_projection_work");
  assert.equal(operations.length, 1);
  assert.equal(applications.length, 1);
  assert.equal(events.length, 1);
  assert.equal(outbox.length, 1);
  const operationId = operations[0]?.["operation_id"];
  assert.equal(applications[0]?.["operation_id"], operationId);
  assert.equal(events[0]?.["operation_id"], operationId);
  assert.ok(projections.every((row) => row["enqueue_operation_id"] === operationId));
}

function assertReceiptMatchesDurable(
  prepared: PreparedApplicationCase,
  receipt: LegacyImportApplicationReceipt,
): void {
  const operation = db().prepare(
    "SELECT * FROM workflow_operations WHERE operation_id = :operation_id",
  ).get({ ":operation_id": receipt.operationId });
  const application = db().prepare(
    "SELECT * FROM workflow_import_applications WHERE operation_id = :operation_id",
  ).get({ ":operation_id": receipt.operationId });
  assert.ok(operation);
  assert.ok(application);
  assert.deepEqual(receipt, {
    status: "replayed",
    operationId: operation["operation_id"],
    projectId: operation["project_id"],
    applicationIdentityHash: createLegacyImportApplicationIdentity(prepared.input).applicationIdentityHash,
    previewId: application["preview_id"],
    previewHash: application["preview_hash"],
    backupId: prepared.backup.backup_id,
    baseProjectRevision: operation["expected_revision"],
    baseAuthorityEpoch: operation["expected_authority_epoch"],
    resultingRevision: operation["resulting_revision"],
    resultingAuthorityEpoch: operation["resulting_authority_epoch"],
    appliedAt: application["applied_at"],
    eventIds: rows(`SELECT event_id FROM workflow_domain_events
      WHERE operation_id = :operation_id ORDER BY event_index`, {
      ":operation_id": receipt.operationId,
    }).map((row) => row["event_id"]),
    outboxIds: rows(`SELECT outbox.outbox_id
      FROM workflow_outbox outbox
      JOIN workflow_domain_events event ON event.event_id = outbox.event_id
      WHERE event.operation_id = :operation_id ORDER BY outbox.outbox_id`, {
      ":operation_id": receipt.operationId,
    }).map((row) => row["outbox_id"]),
    projectionWorkIds: rows(`SELECT projection_work_id FROM workflow_projection_work
      WHERE enqueue_operation_id = :operation_id ORDER BY projection_work_id`, {
      ":operation_id": receipt.operationId,
    }).map((row) => row["projection_work_id"]),
  });
}

afterEach(() => {
  _setDomainOperationFaultForTest(null);
  const candidate = (applicationModule as unknown as Record<string, unknown>)[
    "_setLegacyImportApplicationBoundaryForTest"
  ];
  if (typeof candidate === "function") (candidate as ApplicationBoundarySetter)(null);
  closeDatabase();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

for (const fault of DOMAIN_PRECOMMIT_FAULTS) {
  test(`public Application ${fault} exception rolls back every durable surface after reopen`, () => {
    const prepared = prepareCase();
    const before = durableSnapshot();
    _setDomainOperationFaultForTest(fault);

    expectTransactionFailure(() => applyLegacyImport(prepared.input));

    _setDomainOperationFaultForTest(null);
    assert.deepEqual(reopenAndSnapshot(prepared), before);
  });
}

for (const boundary of APPLICATION_BOUNDARIES) {
  test(`public Application ${boundary} exception rolls back every durable surface after reopen`, () => {
    const prepared = prepareCase();
    const before = durableSnapshot();
    let hits = 0;
    boundarySetter()((observed) => {
      if (observed !== boundary) return;
      hits += 1;
      throw new Error(`injected Application fault at ${boundary}`);
    });

    expectTransactionFailure(() => applyLegacyImport(prepared.input));

    boundarySetter()(null);
    assert.equal(hits, 1);
    assert.deepEqual(reopenAndSnapshot(prepared), before);
  });

  test(`public Application ${boundary} SIGKILL rolls back every durable surface after reopen`, {
    concurrency: false,
  }, () => {
    const prepared = prepareCase();
    const before = durableSnapshot();
    closeDatabase();

    const child = runChild(prepared, { applicationBoundary: boundary });

    assert.equal(child.status, null, child.stderr || child.stdout);
    assert.equal(child.signal, "SIGKILL", child.stderr || child.stdout);
    assert.deepEqual(reopenAndSnapshot(prepared), before);
  });
}

for (const faultCase of MUTATION_FAULT_CASES) {
  test(`public Application mutation SQL ${faultCase.family} exception rolls back exact pre-state`, () => {
    const prepared = prepareCase(faultCase.fixture);
    const before = durableSnapshot();
    const controller = installSqlException(db(), faultCase.sqlPattern, faultCase.occurrence);
    let observed: unknown;

    try {
      applyLegacyImport(prepared.input);
    } catch (error) {
      observed = error;
    } finally {
      controller.restore();
    }

    assert.equal(controller.hitCount(), faultCase.occurrence, `${faultCase.sqlPattern} was not reached`);
    assert.ok(observed instanceof LegacyImportApplicationError);
    assert.deepEqual(reopenAndSnapshot(prepared), before);
  });

  test(`public Application mutation SQL ${faultCase.family} SIGKILL rolls back exact pre-state`, {
    concurrency: false,
  }, () => {
    const prepared = prepareCase(faultCase.fixture);
    const before = durableSnapshot();
    closeDatabase();

    const child = runChild(prepared, {
      crash: {
        sqlPattern: faultCase.sqlPattern,
        occurrence: faultCase.occurrence,
      },
    });

    assert.equal(child.status, null, child.stderr || child.stdout);
    assert.equal(child.signal, "SIGKILL", child.stderr || child.stdout);
    assert.deepEqual(reopenAndSnapshot(prepared), before);
  });
}

test("lost response after commit reopens and returns the exact durable public receipt", {
  concurrency: false,
}, () => {
  const prepared = prepareCase();
  const before = durableSnapshot();
  const committedPath = join(prepared.workspace, "committed-operation-id");
  closeDatabase();

  const child = runChild(prepared, { killAfterApply: true, committedPath });

  assert.equal(child.status, null, child.stderr || child.stdout);
  assert.equal(child.signal, "SIGKILL", child.stderr || child.stdout);
  const committed = reopenAndSnapshot(prepared);
  assert.notDeepEqual(committed, before);
  assert.deepEqual(rows("SELECT revision, authority_epoch FROM project_authority"), [{
    revision: prepared.base.authority.revision + 1,
    authority_epoch: prepared.base.authority.authority_epoch,
  }]);
  assert.equal((committed.operations as unknown[]).length, 1);
  assert.equal((committed.applications as unknown[]).length, 1);
  const afterKill = durableSnapshot();

  const replayed = applyLegacyImport(prepared.input);

  assert.equal(replayed.operationId, readFileSync(committedPath, "utf8"));
  assertReceiptMatchesDurable(prepared, replayed);
  assert.deepEqual(durableSnapshot(), afterKill);
  assert.deepEqual(applyLegacyImport(structuredClone(prepared.input)), replayed);
  assert.deepEqual(durableSnapshot(), afterKill);
});

test("two processes with the same key and input commit once and return receipt-equivalent replay", {
  concurrency: false,
}, async () => {
  const prepared = prepareCase();
  closeDatabase();

  const outcomes = await runConcurrentApplications(prepared, [prepared.input, prepared.input]);

  const receipts = outcomes.flatMap((outcome) => "receipt" in outcome ? [outcome.receipt] : []);
  assert.deepEqual(receipts.map((receipt) => receipt.status).sort(), ["committed", "replayed"]);
  const [first, second] = receipts.map(({ status: _status, ...receipt }) => receipt);
  assert.deepEqual(first, second);
  reopenAndSnapshot(prepared);
  assertSingleImportLineage(prepared);
  assert.equal(tableRows("workflow_operations")[0]?.["operation_id"], receipts[0]?.operationId);
});

test("two processes with different keys for one Preview commit once and return typed replay conflict", {
  concurrency: false,
}, async () => {
  const prepared = prepareCase();
  const competingInput: LegacyImportApplicationInput = {
    ...structuredClone(prepared.input),
    invocation: {
      ...structuredClone(prepared.input.invocation),
      idempotencyKey: `${prepared.input.invocation.idempotencyKey}-competing`,
    },
  };
  closeDatabase();

  const outcomes = await runConcurrentApplications(prepared, [prepared.input, competingInput]);

  const receipts = outcomes.flatMap((outcome) => "receipt" in outcome ? [outcome.receipt] : []);
  const errors = outcomes.flatMap((outcome) => "error" in outcome ? [outcome.error] : []);
  assert.equal(receipts.length, 1);
  assert.deepEqual(errors, [{
    code: "LEGACY_IMPORT_APPLICATION_REPLAY_CONFLICT",
    message: "legacy import durable identity does not match the requested key and Preview",
    stage: "replay",
    retryable: false,
  }]);
  reopenAndSnapshot(prepared);
  assertSingleImportLineage(prepared);
  assert.equal(tableRows("workflow_operations")[0]?.["operation_id"], receipts[0]?.operationId);
});

test("two distinct valid corpus requests from one base commit once and return typed authority stale", {
  concurrency: false,
}, async () => {
  const prepared = prepareCase("gsd-nested");
  const sibling = prepareSiblingCase(prepared, "planning-flat-complete");
  closeDatabase();

  const outcomes = await runConcurrentApplications(prepared, [prepared.input, sibling.input]);

  const receipts = outcomes.flatMap((outcome) => "receipt" in outcome ? [outcome.receipt] : []);
  const errors = outcomes.flatMap((outcome) => "error" in outcome ? [outcome.error] : []);
  assert.equal(receipts.length, 1);
  assert.deepEqual(errors, [{
    code: "LEGACY_IMPORT_APPLICATION_AUTHORITY_STALE",
    message: "legacy import authority changed after approval",
    stage: "transaction",
    retryable: false,
  }]);
  reopenAndSnapshot(prepared);
  assertSingleImportLineage(prepared);
  assert.equal(tableRows("workflow_operations")[0]?.["operation_id"], receipts[0]?.operationId);
});
