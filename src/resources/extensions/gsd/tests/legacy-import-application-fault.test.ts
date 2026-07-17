// Project/App: gsd-pi
// File Purpose: Public fault, crash, restart, and lost-response proof for legacy Import Application.

import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { DbAdapter } from "../db-adapter.ts";
import {
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";
import { createLegacyImportCorpusSourceRoots } from "./helpers/legacy-import-corpus.ts";

const CORPUS_SOURCE = fileURLToPath(new URL(
  "./__fixtures__/legacy-import-corpus/v1/gsd-nested/source/",
  import.meta.url,
));
const CHILD_PATH = fileURLToPath(new URL("./legacy-import-application-child.ts", import.meta.url));
const RESOLVER_PATH = fileURLToPath(new URL("./resolve-ts.mjs", import.meta.url));
const tempDirectories = new Set<string>();
let applicationSequence = 0;

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
  killAfterApply?: boolean;
  committedPath?: string;
}

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

function prepareCase(): PreparedApplicationCase {
  applicationSequence += 1;
  const workspace = mkdtempSync(join(tmpdir(), "gsd-legacy-application-fault-"));
  tempDirectories.add(workspace);
  const source = join(workspace, "source");
  const backupDirectory = join(workspace, "backups");
  const databasePath = join(workspace, "canonical.sqlite");
  cpSync(CORPUS_SOURCE, source, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
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
