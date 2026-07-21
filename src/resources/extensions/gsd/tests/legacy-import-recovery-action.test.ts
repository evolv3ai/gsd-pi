// Project/App: gsd-pi
// File Purpose: Typed action-boundary refusals for verified Import Application recovery.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { prepareLegacyImportBackup } from "../legacy-import-backup.ts";
import {
  applyLegacyImport,
  createLegacyImportApplicationIdentity,
  type LegacyImportApplicationInput,
} from "../legacy-import-application.ts";
import { createLegacyImportPreview } from "../legacy-import-preview.ts";
import { captureCurrentLegacyImportBaseSnapshot } from "../legacy-import-preview-base.ts";
import {
  executeLegacyImportRecoveryAction,
  LegacyImportRecoveryActionError,
} from "../legacy-import-recovery-action.ts";
import type { VerifiedRecoverApplicationResult } from "../db-workspace.ts";
import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { createLegacyImportCorpusSourceRoots } from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = fileURLToPath(new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url));
const tempDirectories = new Set<string>();
let sequence = 0;

afterEach(() => {
  closeDatabase();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

function prepareAppliedApplication(): VerifiedRecoverApplicationResult {
  sequence += 1;
  const workspace = mkdtempSync(join(tmpdir(), "gsd-recovery-action-"));
  tempDirectories.add(workspace);
  const source = join(workspace, "source");
  const backupDirectory = join(workspace, "backups");
  cpSync(join(CORPUS_ROOT, "gsd-nested", "source"), source, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  mkdirSync(backupDirectory);
  assert.equal(openDatabase(join(workspace, "canonical.sqlite")), true);
  const roots = createLegacyImportCorpusSourceRoots(source);
  const previewInput = { roots };
  const base = captureCurrentLegacyImportBaseSnapshot();
  const preview = createLegacyImportPreview(previewInput);
  const backup = prepareLegacyImportBackup({
    preview,
    base,
    roots,
    destination_directory: backupDirectory,
    label: "before-recovery-action",
  });
  const applicationInput: LegacyImportApplicationInput = {
    invocation: {
      idempotencyKey: `legacy-import/recovery-action-${sequence}`,
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "recovery-action-test",
    },
    previewInput,
    preview,
    backup,
  };
  const applicationIdentityHash = createLegacyImportApplicationIdentity(
    applicationInput,
  ).applicationIdentityHash;
  applyLegacyImport(applicationInput);
  return {
    receipt: { applicationIdentityHash },
    backup,
  } as unknown as VerifiedRecoverApplicationResult;
}

function consentStub(evidenceHash: string) {
  return {
    consentSchemaVersion: 1 as const,
    decision: "proceed" as const,
    destructiveDatabaseRestore: true as const,
    evidenceHash,
  };
}

test("destructive restore without Consent refuses with a typed boundary error", () => {
  const application = prepareAppliedApplication();
  assert.throws(
    () => executeLegacyImportRecoveryAction(application, "restore"),
    (error: unknown) => {
      assert.ok(error instanceof LegacyImportRecoveryActionError);
      assert.equal(error.stage, "restore");
      assert.equal(error.code, "LEGACY_IMPORT_RECOVERY_ACTION_CONSENT_REQUIRED");
      assert.equal(error.retryable, false);
      assert.equal(error.message, "destructive restore requires explicit evidence-bound Consent");
      return true;
    },
  );
});

test("restore outside the consent window refuses with the assessment reason code", () => {
  const application = prepareAppliedApplication();
  // Later canonical work closes the exact restore window, so the action
  // boundary must refuse rather than attempt a destructive restore.
  const db = _getAdapter();
  assert.ok(db);
  db.prepare("UPDATE milestones SET title = 'out-of-band change' WHERE id = 'M001'").run();
  assert.throws(
    () => executeLegacyImportRecoveryAction(
      application,
      "restore",
      [],
      consentStub(`sha256:${"0".repeat(64)}`),
    ),
    (error: unknown) => {
      assert.ok(error instanceof LegacyImportRecoveryActionError);
      assert.equal(error.stage, "restore");
      assert.equal(error.code, "LEGACY_IMPORT_RECOVERY_ACTION_RESTORE_UNAVAILABLE");
      assert.match(error.message, /^destructive restore is unavailable: [A-Z_]+$/u);
      return true;
    },
  );
});

test("stale Consent refuses with a typed ineligibility error", () => {
  const application = prepareAppliedApplication();
  assert.throws(
    () => executeLegacyImportRecoveryAction(
      application,
      "restore",
      [],
      consentStub(`sha256:${"0".repeat(64)}`),
    ),
    (error: unknown) => {
      assert.ok(error instanceof LegacyImportRecoveryActionError);
      assert.equal(error.stage, "restore");
      assert.equal(error.code, "LEGACY_IMPORT_RECOVERY_ACTION_CONSENT_INELIGIBLE");
      assert.match(error.message, /^destructive restore Consent became ineligible: [A-Z_]+$/u);
      return true;
    },
  );
});

test("Forward Repair outside its route refuses with a typed boundary error", () => {
  const application = prepareAppliedApplication();
  assert.throws(
    () => executeLegacyImportRecoveryAction(application, "forward-repair"),
    (error: unknown) => {
      assert.ok(error instanceof LegacyImportRecoveryActionError);
      assert.equal(error.stage, "forward-repair");
      assert.equal(error.code, "LEGACY_IMPORT_RECOVERY_ACTION_FORWARD_REPAIR_UNAVAILABLE");
      assert.match(error.message, /^Forward Repair is unavailable: [A-Z_]+$/u);
      return true;
    },
  );
});
