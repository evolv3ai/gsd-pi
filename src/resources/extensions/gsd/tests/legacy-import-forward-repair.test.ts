// Project/App: gsd-pi
// File Purpose: Executable contract for three-way legacy Import Forward Repair.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  _setDomainOperationFaultForTest,
  executeDomainOperation,
  type DomainOperationFaultPoint,
} from "../db/domain-operation.ts";
import {
  prepareLegacyImportBackup,
  type LegacyImportVerifiedBackup,
} from "../legacy-import-backup.ts";
import {
  applyLegacyImport,
  createLegacyImportApplicationIdentity,
  type LegacyImportApplicationInput,
  type LegacyImportApplicationReceipt,
} from "../legacy-import-application.ts";
import type { LegacyImportApplicationPlan } from "../legacy-import-application-plan.ts";
import {
  applyLegacyImportForwardRepair,
  inspectLegacyImportForwardRepair,
  LegacyImportForwardRepairError,
  type LegacyImportForwardRepairInput,
} from "../legacy-import-forward-repair.ts";
import {
  compileLegacyImportForwardRepairPlan,
  type LegacyImportForwardRepairPlan,
} from "../legacy-import-forward-repair-plan.ts";
import {
  createLegacyImportPreview,
  hashLegacyImportValue,
} from "../legacy-import-preview.ts";
import {
  captureCurrentLegacyImportBaseSnapshot,
  type LegacyImportBaseRow,
  type LegacyImportBaseSnapshot,
} from "../legacy-import-preview-base.ts";
import { _getAdapter, closeDatabase, openDatabase, SCHEMA_VERSION } from "../gsd-db.ts";
import { createLegacyImportCorpusSourceRoots } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = fileURLToPath(new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url));
const tempDirectories = new Set<string>();
let sequence = 0;

interface PreparedCase {
  databasePath: string;
  backup: LegacyImportVerifiedBackup;
  applicationReceipt: LegacyImportApplicationReceipt;
  applicationIdentityHash: string;
}

function db(): NonNullable<ReturnType<typeof _getAdapter>> {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function prepareCase(seedExistingMilestone = false): PreparedCase {
  sequence += 1;
  const workspace = mkdtempSync(join(tmpdir(), "gsd-forward-repair-"));
  tempDirectories.add(workspace);
  const source = join(workspace, "source");
  const backupDirectory = join(workspace, "backups");
  const databasePath = join(workspace, "canonical.sqlite");
  cpSync(join(CORPUS_ROOT, "gsd-nested", "source"), source, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  mkdirSync(backupDirectory);
  assert.equal(openDatabase(databasePath), true);
  if (seedExistingMilestone) {
    db().prepare(`INSERT INTO milestones (id, title, status, created_at)
      VALUES ('M001', 'Original foundation', 'active', '2026-07-18T00:00:00.000Z')`).run();
  }
  const roots = createLegacyImportCorpusSourceRoots(source);
  const previewInput = { roots };
  const base = captureCurrentLegacyImportBaseSnapshot();
  const preview = createLegacyImportPreview(previewInput);
  const backup = prepareLegacyImportBackup({
    preview,
    base,
    roots,
    destination_directory: backupDirectory,
    label: "before-forward-repair",
  });
  const applicationInput: LegacyImportApplicationInput = {
    invocation: {
      idempotencyKey: `legacy-import/forward-repair-application-${sequence}`,
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "forward-repair-test",
    },
    previewInput,
    preview,
    backup,
  };
  const applicationIdentityHash = createLegacyImportApplicationIdentity(
    applicationInput,
  ).applicationIdentityHash;
  const applicationReceipt = applyLegacyImport(applicationInput);
  return {
    databasePath,
    backup,
    applicationReceipt,
    applicationIdentityHash,
  };
}

function prepareRepairInput(prepared: PreparedCase, suffix: string): {
  plan: LegacyImportForwardRepairPlan;
  input: LegacyImportForwardRepairInput;
} {
  const plan = inspectLegacyImportForwardRepair({
    applicationIdentityHash: prepared.applicationIdentityHash,
    backup: prepared.backup,
  });
  return {
    plan,
    input: {
      invocation: {
        idempotencyKey: `legacy-import/forward-repair-${sequence}-${suffix}`,
        sourceTransport: "internal",
        actorType: "agent",
        actorId: "forward-repair-test",
      },
      applicationIdentityHash: prepared.applicationIdentityHash,
      backup: prepared.backup,
      plan,
    },
  };
}

function durableRepairSnapshot(): unknown {
  return {
    base: captureCurrentLegacyImportBaseSnapshot(),
    operations: db().prepare("SELECT COUNT(*) AS count FROM workflow_operations").get()?.["count"],
    repairs: db().prepare("SELECT COUNT(*) AS count FROM workflow_import_forward_repairs").get()?.["count"],
    events: db().prepare("SELECT COUNT(*) AS count FROM workflow_domain_events").get()?.["count"],
    outbox: db().prepare("SELECT COUNT(*) AS count FROM workflow_outbox").get()?.["count"],
    projections: db().prepare("SELECT COUNT(*) AS count FROM workflow_projection_work").get()?.["count"],
  };
}

function commitLaterCanonicalRow(prepared: PreparedCase): void {
  executeDomainOperation({
    operationType: "milestone.describe",
    idempotencyKey: `legacy-import/forward-repair-later-${sequence}`,
    expectedRevision: prepared.applicationReceipt.resultingRevision,
    expectedAuthorityEpoch: prepared.applicationReceipt.resultingAuthorityEpoch,
    actorType: "agent",
    actorId: "forward-repair-test",
    sourceTransport: "internal",
    payload: { milestoneId: "M-LATER" },
  }, () => {
    db().prepare(`
      INSERT INTO milestones (id, title, status, created_at)
      VALUES ('M-LATER', 'Accepted later work', 'active', '2026-07-18T00:00:00.000Z')
    `).run();
    const evolved = db().prepare(`UPDATE milestones
      SET title = 'Accepted imported-row evolution'
      WHERE id = 'M001'`).run();
    assert.equal((evolved as { changes?: unknown }).changes, 1);
    return {
      events: [{
        eventType: "milestone.described",
        entityType: "milestone",
        entityId: "M-LATER",
        payload: { title: "Accepted later work" },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "milestone/m-later",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
}

function baseSnapshot(revision: number, rows: readonly LegacyImportBaseRow[]): LegacyImportBaseSnapshot {
  return {
    snapshot_schema_version: 1,
    database_schema_version: SCHEMA_VERSION,
    authority: {
      singleton: 1,
      project_id: "project-1",
      project_root_realpath: "/tmp/project-1",
      revision,
      authority_epoch: 0,
      created_at: "2026-07-18T00:00:00.000Z",
      updated_at: "2026-07-18T00:00:00.000Z",
    },
    rows,
    relevant_rows_hash: hashLegacyImportValue(rows),
  };
}

afterEach(() => {
  _setDomainOperationFaultForTest(null);
  closeDatabase();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

test("Forward Repair preserves accepted later work and commits one exact terminal receipt", () => {
  const prepared = prepareCase();
  commitLaterCanonicalRow(prepared);
  const backupBytes = readFileSync(prepared.backup.backup_ref);
  const { plan, input } = prepareRepairInput(prepared, "commit");
  assert.equal(plan.expectedProjectRevision, prepared.applicationReceipt.resultingRevision + 1);
  assert.equal(plan.expectedAuthorityEpoch, prepared.applicationReceipt.resultingAuthorityEpoch);
  assert.equal(plan.unresolvedCount, 0);
  assert.ok(plan.targetCount > 0);
  assert.ok(plan.mutationCount > 0);
  assert.ok(Number(db().prepare(`SELECT COUNT(*) AS count FROM slice_dependencies
    WHERE milestone_id = 'M001'`).get()?.["count"]) > 0);
  assert.deepEqual(inspectLegacyImportForwardRepair({
    applicationIdentityHash: prepared.applicationIdentityHash,
    backup: prepared.backup,
  }), plan);

  const committed = applyLegacyImportForwardRepair(input);
  assert.equal(committed.status, "committed");
  assert.equal(committed.resultingRevision, plan.expectedProjectRevision + 1);
  assert.equal(committed.resultingAuthorityEpoch, plan.expectedAuthorityEpoch);
  assert.equal(committed.targetCount, plan.targetCount);
  assert.equal(committed.mutationCount, plan.mutationCount);
  assert.deepEqual(readFileSync(prepared.backup.backup_ref), backupBytes);
  assert.deepEqual(db().prepare(`
    SELECT title, status FROM milestones WHERE id = 'M-LATER'
  `).get(), { title: "Accepted later work", status: "active" });
  assert.equal(db().prepare("SELECT title FROM milestones WHERE id = 'M001'").get()?.["title"], "Accepted imported-row evolution");
  assert.equal(db().prepare(`SELECT COUNT(*) AS count FROM slice_dependencies
    WHERE milestone_id = 'M001'`).get()?.["count"], 0);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM workflow_import_forward_repairs").get()?.["count"], 1);
  assert.equal(db().prepare(`
    SELECT COUNT(*) AS count FROM workflow_domain_events
    WHERE event_type = 'legacy-import.forward-repaired'
  `).get()?.["count"], 1);

  const replayed = applyLegacyImportForwardRepair(input);
  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.operationId, committed.operationId);
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM workflow_import_forward_repairs").get()?.["count"], 1);
});

const PRECOMMIT_FAULTS = [
  "after-operation",
  "after-mutation",
  "after-events",
  "after-outbox",
  "after-projections",
  "before-cas",
] as const satisfies readonly DomainOperationFaultPoint[];

for (const fault of PRECOMMIT_FAULTS) {
  test(`Forward Repair ${fault} failure leaves no durable change after restart`, () => {
    const prepared = prepareCase();
    commitLaterCanonicalRow(prepared);
    const { input } = prepareRepairInput(prepared, fault);
    const before = durableRepairSnapshot();
    const backupBytes = readFileSync(prepared.backup.backup_ref);
    _setDomainOperationFaultForTest(fault);

    assert.throws(() => applyLegacyImportForwardRepair(input), new RegExp(fault));

    _setDomainOperationFaultForTest(null);
    closeDatabase();
    assert.equal(openDatabase(prepared.databasePath), true);
    assert.deepEqual(durableRepairSnapshot(), before);
    assert.deepEqual(readFileSync(prepared.backup.backup_ref), backupBytes);
  });
}

test("a lost response after commit reopens and replays the exact Forward Repair receipt", () => {
  const prepared = prepareCase();
  commitLaterCanonicalRow(prepared);
  const { input } = prepareRepairInput(prepared, "lost-response");
  _setDomainOperationFaultForTest("after-commit");

  assert.throws(() => applyLegacyImportForwardRepair(input), /after-commit/);

  _setDomainOperationFaultForTest(null);
  closeDatabase();
  assert.equal(openDatabase(prepared.databasePath), true);
  const replayed = applyLegacyImportForwardRepair(input);
  assert.equal(replayed.status, "replayed");
  assert.equal(db().prepare("SELECT COUNT(*) AS count FROM workflow_import_forward_repairs").get()?.["count"], 1);
  assert.equal(db().prepare(`SELECT COUNT(*) AS count FROM slice_dependencies
    WHERE milestone_id = 'M001'`).get()?.["count"], 0);
});

test("a canonical write after inspection makes the Forward Repair plan stale without residue", () => {
  const prepared = prepareCase();
  commitLaterCanonicalRow(prepared);
  const { plan, input } = prepareRepairInput(prepared, "stale");
  executeDomainOperation({
    operationType: "milestone.describe",
    idempotencyKey: `legacy-import/forward-repair-race-${sequence}`,
    expectedRevision: plan.expectedProjectRevision,
    expectedAuthorityEpoch: plan.expectedAuthorityEpoch,
    actorType: "agent",
    sourceTransport: "internal",
    payload: { milestoneId: "M-RACE" },
  }, () => {
    db().prepare(`INSERT INTO milestones (id, title, status, created_at)
      VALUES ('M-RACE', 'Accepted after inspection', 'active', '2026-07-18T00:00:00.000Z')`).run();
    return {
      events: [{
        eventType: "milestone.described",
        entityType: "milestone",
        entityId: "M-RACE",
        payload: { title: "Accepted after inspection" },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "milestone/m-race",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
  const before = durableRepairSnapshot();

  assert.throws(() => applyLegacyImportForwardRepair(input), (error) => (
    error instanceof LegacyImportForwardRepairError
    && error.code === "LEGACY_IMPORT_FORWARD_REPAIR_PLAN_CHANGED"
  ));

  assert.deepEqual(durableRepairSnapshot(), before);
  assert.equal(db().prepare("SELECT title FROM milestones WHERE id = 'M-RACE'").get()?.["title"], "Accepted after inspection");
});

test("the generic Domain Operation seam refuses Forward Repair", () => {
  prepareCase();
  assert.throws(() => executeDomainOperation({
    operationType: "import.forward_repair",
    idempotencyKey: `legacy-import/forward-repair-generic-${sequence}`,
    expectedRevision: 1,
    expectedAuthorityEpoch: 0,
    actorType: "agent",
    sourceTransport: "internal",
    payload: {},
  }, () => ({ events: [], projections: [] })), /requires the typed Forward Repair operation/);
});

test("public Forward Repair refuses a true imported-field overlap without writing", () => {
  const prepared = prepareCase(true);
  executeDomainOperation({
    operationType: "milestone.describe",
    idempotencyKey: `legacy-import/forward-repair-overlap-${sequence}`,
    expectedRevision: prepared.applicationReceipt.resultingRevision,
    expectedAuthorityEpoch: prepared.applicationReceipt.resultingAuthorityEpoch,
    actorType: "agent",
    sourceTransport: "internal",
    payload: { milestoneId: "M001" },
  }, () => {
    const changed = db().prepare("UPDATE milestones SET title = 'Accepted later foundation' WHERE id = 'M001'").run();
    assert.equal((changed as { changes?: unknown }).changes, 1);
    return {
      events: [{
        eventType: "milestone.described",
        entityType: "milestone",
        entityId: "M001",
        payload: { title: "Accepted later foundation" },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: "milestone/m001",
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
  const { plan, input } = prepareRepairInput(prepared, "overlap");
  assert.ok(plan.targets.some((entry) => entry.disposition === "choice-required"));
  const before = durableRepairSnapshot();

  assert.throws(() => applyLegacyImportForwardRepair(input), (error) => (
    error instanceof LegacyImportForwardRepairError
    && error.code === "LEGACY_IMPORT_FORWARD_REPAIR_CHOICE_REQUIRED"
  ));

  assert.deepEqual(durableRepairSnapshot(), before);
  assert.equal(db().prepare("SELECT title FROM milestones WHERE id = 'M001'").get()?.["title"], "Accepted later foundation");
});

test("Forward Repair requires a choice when a field changed away from both base and import values", () => {
  const identity = hashLegacyImportValue({ id: "R001" });
  const baseRow: LegacyImportBaseRow = {
    row_set: "requirements",
    identity: JSON.stringify({ id: "R001" }),
    value: { id: "R001", description: "base" },
  };
  const currentRow: LegacyImportBaseRow = {
    row_set: "requirements",
    identity: baseRow.identity,
    value: { id: "R001", description: "later" },
  };
  const applicationPlan = {
    planSchemaVersion: 2,
    previewId: identity,
    previewHash: identity,
    baseProjectRevision: 0,
    baseAuthorityEpoch: 0,
    receiptCounts: { create: 0, update: 1, delete: 0, preserve: 0, unparsed: 0, unresolved: 0 },
    instructions: [{
      action: "update",
      targetKind: "requirement",
      targetKey: "R001",
      rowSet: "requirements",
      identity: { id: "R001" },
      values: { description: "imported" },
      changeIds: [identity],
    }],
    accounting: {
      sourceIds: [], diagnosisIds: [], resolutionIds: [], changeIds: [identity],
      preserveChangeIds: [], unparsedSourceIds: [],
    },
    mutationCounts: {
      create: 0, update: 1, delete: 0,
      replaceSliceDependencies: 0, deleteSliceDependencies: 0, adoptLifecycle: 0,
    },
    affectedTargets: [{ targetKind: "requirement", targetKey: "R001" }],
    eventFacts: {
      previewId: identity,
      previewHash: identity,
      sourceSetHash: identity,
      changeSetHash: identity,
      receiptCounts: { create: 0, update: 1, delete: 0, preserve: 0, unparsed: 0, unresolved: 0 },
      mutationCounts: {
        create: 0, update: 1, delete: 0,
        replaceSliceDependencies: 0, deleteSliceDependencies: 0, adoptLifecycle: 0,
      },
      affectedTargetHashes: [identity],
      sourceCount: 0, diagnosisCount: 0, resolutionCount: 0, preserveCount: 0, unparsedCount: 0,
    },
    projectionKeys: ["legacy-import/test"],
  } as LegacyImportApplicationPlan;
  const plan = compileLegacyImportForwardRepairPlan({
    applicationOperationId: "application-op",
    applicationIdentityHash: identity,
    applicationRelevantRowsHash: identity,
    previewId: identity,
    previewHash: identity,
    backupId: identity,
    applicationPlan,
    backupBase: baseSnapshot(0, [baseRow]),
    currentBase: baseSnapshot(2, [currentRow]),
  });

  assert.equal(plan.unresolvedCount, 1);
  assert.equal(plan.mutationCount, 0);
  assert.equal(plan.targets[0]?.disposition, "choice-required");
  assert.equal(plan.targets[0]?.reasonCode, "UPDATED_FIELD_CHANGED_LATER");
});

test("an imported decision already removed from a base without it is already repaired", () => {
  const identity = hashLegacyImportValue({ id: "D001" });
  const applicationPlan = {
    planSchemaVersion: 2,
    previewId: identity,
    previewHash: identity,
    baseProjectRevision: 0,
    baseAuthorityEpoch: 0,
    instructions: [{
      action: "create-decision-memory",
      targetKind: "decision",
      targetKey: "D001",
      decisionId: "D001",
      values: { decision: "Imported decision", choice: "Imported choice" },
      changeIds: [identity],
    }],
  } as unknown as LegacyImportApplicationPlan;
  const plan = compileLegacyImportForwardRepairPlan({
    applicationOperationId: "application-op",
    applicationIdentityHash: identity,
    applicationRelevantRowsHash: identity,
    previewId: identity,
    previewHash: identity,
    backupId: identity,
    applicationPlan,
    backupBase: baseSnapshot(0, []),
    currentBase: baseSnapshot(2, []),
  });

  assert.equal(plan.unresolvedCount, 0);
  assert.equal(plan.mutationCount, 0);
  assert.equal(plan.targets[0]?.disposition, "already-repaired");
  assert.equal(plan.targets[0]?.reasonCode, "DECISION_ALREADY_RESTORED");
});
