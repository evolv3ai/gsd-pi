// Project/App: gsd-pi
// File Purpose: Public legacy Import Application contention and projection-delivery isolation proof.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import {
  prepareLegacyImportBackup,
  type LegacyImportVerifiedBackup,
} from "../legacy-import-backup.ts";
import {
  applyLegacyImport,
  LegacyImportApplicationError,
  type LegacyImportApplicationInput,
  type LegacyImportApplicationReceipt,
} from "../legacy-import-application.ts";
import { createLegacyImportPreview } from "../legacy-import-preview.ts";
import { captureCurrentLegacyImportBaseSnapshot } from "../legacy-import-preview-base.ts";
import { createDbAdapter, type DbAdapter } from "../db-adapter.ts";
import {
  _getAdapter,
  closeDatabase,
  openDatabase,
} from "../gsd-db.ts";
import { createLegacyImportCorpusSourceRoots } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = fileURLToPath(
  new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url),
);
const tempDirectories = new Set<string>();
let applicationSequence = 0;

interface PreparedApplicationCase {
  source: string;
  databasePath: string;
  backup: LegacyImportVerifiedBackup;
  input: LegacyImportApplicationInput;
}

function db(): DbAdapter {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function rows(
  sql: string,
  params?: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const statement = db().prepare(sql);
  return params === undefined ? statement.all() : statement.all(params);
}

function row(sql: string, params?: Record<string, unknown>): Record<string, unknown> {
  const statement = db().prepare(sql);
  return (params === undefined ? statement.get() : statement.get(params)) ?? {};
}

function changes(result: unknown): number {
  const value = (result as { changes?: unknown })?.changes;
  return typeof value === "number" ? value : 0;
}

function prepareCase(): PreparedApplicationCase {
  applicationSequence += 1;
  const workspace = mkdtempSync(join(tmpdir(), "gsd-legacy-application-delivery-"));
  tempDirectories.add(workspace);
  const source = join(workspace, "source");
  const destination = join(workspace, "backups");
  const databasePath = join(workspace, "canonical.sqlite");
  cpSync(join(CORPUS_ROOT, "custom-workflow", "source"), source, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  mkdirSync(destination);
  assert.equal(openDatabase(databasePath), true);
  const roots = createLegacyImportCorpusSourceRoots(source);
  const previewInput = { roots };
  const base = captureCurrentLegacyImportBaseSnapshot();
  const preview = createLegacyImportPreview(previewInput);
  const backup = prepareLegacyImportBackup({
    preview,
    base,
    roots,
    destination_directory: destination,
    label: "pre-delivery",
  });
  return {
    source,
    databasePath,
    backup,
    input: {
      invocation: {
        idempotencyKey: `legacy-import/delivery-${applicationSequence}`,
        sourceTransport: "internal",
        actorType: "agent",
        actorId: "legacy-import-delivery-test",
        traceId: `delivery-trace-${applicationSequence}`,
        turnId: `delivery-turn-${applicationSequence}`,
      },
      previewInput,
      preview,
      backup,
    },
  };
}

function applicationAuthoritySnapshot(): Record<string, unknown> {
  return {
    authority: rows("SELECT * FROM project_authority ORDER BY singleton"),
    milestones: rows("SELECT * FROM milestones ORDER BY id"),
    slices: rows("SELECT * FROM slices ORDER BY milestone_id, id"),
    tasks: rows("SELECT * FROM tasks ORDER BY milestone_id, slice_id, id"),
    dependencies: rows(
      "SELECT * FROM slice_dependencies ORDER BY milestone_id, slice_id, depends_on_slice_id",
    ),
    requirements: rows("SELECT * FROM requirements ORDER BY id"),
    decisions: rows("SELECT * FROM decisions ORDER BY id"),
    memories: rows("SELECT * FROM memories ORDER BY seq"),
    artifacts: rows("SELECT * FROM artifacts ORDER BY path"),
    assessments: rows("SELECT * FROM assessments ORDER BY path"),
    lifecycles: rows("SELECT * FROM workflow_item_lifecycles ORDER BY lifecycle_id"),
    workers: rows("SELECT * FROM workers ORDER BY worker_id"),
    leases: rows("SELECT * FROM milestone_leases ORDER BY milestone_id"),
    dispatches: rows("SELECT * FROM unit_dispatches ORDER BY id"),
    attempts: rows("SELECT * FROM workflow_execution_attempts ORDER BY attempt_id"),
    operations: rows("SELECT * FROM workflow_operations ORDER BY resulting_revision"),
    applications: rows(
      "SELECT * FROM workflow_import_applications ORDER BY resulting_project_revision",
    ),
    events: rows("SELECT * FROM workflow_domain_events ORDER BY project_revision, event_index"),
    outbox: rows("SELECT * FROM workflow_outbox ORDER BY outbox_id"),
  };
}

function logicalSnapshot(): Record<string, unknown> {
  return {
    ...applicationAuthoritySnapshot(),
    projections: rows("SELECT * FROM workflow_projection_work ORDER BY projection_work_id"),
  };
}

function immutableApplicationSnapshot(): Record<string, unknown> {
  return {
    ...applicationAuthoritySnapshot(),
    projectionIdentity: rows(`SELECT projection_work_id, project_id, projection_key,
      projection_kind, supersedes_projection_work_id, source_project_revision,
      source_authority_epoch, renderer_version, enqueue_operation_id, created_at
      FROM workflow_projection_work ORDER BY projection_work_id`),
  };
}

function projectionDelivery(projectionWorkId: string): Record<string, unknown> {
  return row(`SELECT delivery_state, state_version, claim_owner, claim_fencing_token,
      claimed_at, claim_expires_at, attempt_count, next_attempt_at, last_error,
      rendered_content_hash, rendered_at, updated_at
    FROM workflow_projection_work WHERE projection_work_id = :projection_work_id`, {
    ":projection_work_id": projectionWorkId,
  });
}

function receiptIdentity(
  receipt: LegacyImportApplicationReceipt,
): Omit<LegacyImportApplicationReceipt, "status"> {
  const { status: _, ...identity } = receipt;
  return identity;
}

function reopen(databasePath: string): void {
  closeDatabase();
  assert.equal(openDatabase(databasePath), true);
  assert.equal(row("PRAGMA quick_check")["quick_check"], "ok");
}

afterEach(() => {
  closeDatabase();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

test("held writer lock is a typed retryable Application contention failure with no residue", {
  concurrency: false,
}, (t) => {
  const prepared = prepareCase();
  const before = logicalSnapshot();
  const blocker = createDbAdapter(new DatabaseSync(prepared.databasePath));
  let lockHeld = true;
  blocker.exec("BEGIN IMMEDIATE");
  t.after(() => {
    if (lockHeld) blocker.exec("ROLLBACK");
    blocker.close();
  });
  db().exec("PRAGMA busy_timeout = 1");

  let observed: unknown;
  try {
    applyLegacyImport(prepared.input);
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof LegacyImportApplicationError);
  assert.equal(observed.stage, "transaction");
  assert.equal(observed.code, "LEGACY_IMPORT_APPLICATION_WRITER_CONTENTION");
  assert.equal(observed.retryable, true);
  assert.equal(`${observed.message}${JSON.stringify(observed.context)}`.includes(prepared.source), false);
  assert.equal(
    `${observed.message}${JSON.stringify(observed.context)}`.includes(prepared.backup.backup_ref),
    false,
  );

  blocker.exec("ROLLBACK");
  lockHeld = false;
  reopen(prepared.databasePath);
  assert.deepEqual(logicalSnapshot(), before);
});

test("projection delivery failure cannot change or duplicate committed Application authority", {
  concurrency: false,
}, () => {
  const prepared = prepareCase();
  const committed = applyLegacyImport(prepared.input);
  assert.equal(committed.status, "committed");
  assert.ok(committed.projectionWorkIds.length > 0);
  const projectionWorkId = committed.projectionWorkIds[0]!;
  const immutable = immutableApplicationSnapshot();

  const claimedAt = "2099-01-01T00:00:00.000Z";
  const expiresAt = "2099-01-01T00:01:00.000Z";
  const failedAt = "2099-01-01T00:02:00.000Z";
  const retryAt = "2099-01-01T00:03:00.000Z";
  const claimed = db().prepare(`UPDATE workflow_projection_work
    SET delivery_state = 'claimed', claim_owner = 'delivery-test-worker',
        claim_fencing_token = 1, claimed_at = :claimed_at, claim_expires_at = :expires_at,
        state_version = 1, updated_at = :claimed_at
    WHERE projection_work_id = :projection_work_id
      AND delivery_state = 'pending' AND state_version = 0`).run({
    ":claimed_at": claimedAt,
    ":expires_at": expiresAt,
    ":projection_work_id": projectionWorkId,
  });
  assert.equal(changes(claimed), 1);
  const failed = db().prepare(`UPDATE workflow_projection_work
    SET delivery_state = 'pending', claim_owner = NULL,
        claimed_at = NULL, claim_expires_at = NULL,
        state_version = 2, attempt_count = 1,
        next_attempt_at = :retry_at, last_error = 'injected projection delivery failure',
        updated_at = :failed_at
    WHERE projection_work_id = :projection_work_id
      AND delivery_state = 'claimed' AND state_version = 1
      AND claim_owner = 'delivery-test-worker' AND claim_fencing_token = 1`).run({
    ":failed_at": failedAt,
    ":retry_at": retryAt,
    ":projection_work_id": projectionWorkId,
  });
  assert.equal(changes(failed), 1);
  const deliveryFailure = {
    delivery_state: "pending",
    state_version: 2,
    claim_owner: null,
    claim_fencing_token: 1,
    claimed_at: null,
    claim_expires_at: null,
    attempt_count: 1,
    next_attempt_at: retryAt,
    last_error: "injected projection delivery failure",
    rendered_content_hash: null,
    rendered_at: null,
    updated_at: failedAt,
  };
  assert.deepEqual(projectionDelivery(projectionWorkId), deliveryFailure);
  assert.deepEqual(immutableApplicationSnapshot(), immutable);

  const replayed = applyLegacyImport(prepared.input);
  assert.equal(replayed.status, "replayed");
  assert.deepEqual(receiptIdentity(replayed), receiptIdentity(committed));
  assert.deepEqual(immutableApplicationSnapshot(), immutable);
  assert.deepEqual(projectionDelivery(projectionWorkId), deliveryFailure);

  reopen(prepared.databasePath);
  assert.deepEqual(immutableApplicationSnapshot(), immutable);
  assert.deepEqual(projectionDelivery(projectionWorkId), deliveryFailure);
});
