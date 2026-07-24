// Project/App: gsd-pi
// File Purpose: Public live-restore capstone across every eligible sealed corpus case and journal mode.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { prepareLegacyImportBackup } from "../legacy-import-backup.ts";
import {
  applyLegacyImport,
  createLegacyImportApplicationConsent,
  createLegacyImportApplicationIdentity,
  LegacyImportApplicationError,
  type LegacyImportApplicationInput,
} from "../legacy-import-application.ts";
import { restoreLegacyImportLive } from "../legacy-import-live-restore.ts";
import { createLegacyImportPreview } from "../legacy-import-preview.ts";
import { captureCurrentLegacyImportBaseSnapshot } from "../legacy-import-preview-base.ts";
import {
  assessLegacyImportRestore,
  LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION,
} from "../legacy-import-restore-assessment.ts";
import { _getAdapter, closeDatabase, insertDecision, openDatabase } from "../gsd-db.ts";
import { openSqliteReadOnly } from "../sqlite-readonly.ts";
import {
  createLegacyImportCorpusSourceRoots,
  fingerprintLegacyImportCorpusTree,
  type LegacyImportCorpusManifest,
} from "./helpers/legacy-import-corpus.ts";

const CORPUS_ROOT = new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url);
const CORPUS_PATH = fileURLToPath(CORPUS_ROOT);
const MANIFEST = JSON.parse(
  readFileSync(join(CORPUS_PATH, "corpus.json"), "utf8"),
) as LegacyImportCorpusManifest;
const JOURNAL_MODES = ["delete", "wal"] as const;
const ELIGIBLE_CASES = new Set([
  "action-matrix",
  "custom-workflow",
  "gsd-nested",
  "jsonl-history",
  "knowledge-graph",
  "planning-flat-complete",
  "planning-multi-milestone-completed-range",
  "planning-multi-milestone-details",
  "planning-multi-milestone-emoji-range",
  "planning-multi-milestone-heading",
  "planning-multi-milestone-summary",
  "root-external-boundaries",
  "synthetic-smoke",
]);

function database(): NonNullable<ReturnType<typeof _getAdapter>> {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function seedActionMatrixBase(source: string): void {
  const fixture = openSqliteReadOnly(join(source, ".gsd", "gsd.db"));
  try {
    const rows = fixture.db.prepare(`
      SELECT id, when_context, scope, decision, choice, rationale, revisable,
             made_by, source, superseded_by
      FROM decisions
      WHERE id IN ('D002', 'D003', 'D004')
      ORDER BY id
    `).all() as unknown as Array<Parameters<typeof insertDecision>[0]>;
    rows.forEach(insertDecision);
  } finally {
    fixture.db.close();
  }
}

function seedJournalSentinel(id: string): void {
  insertDecision({
    id,
    when_context: "before public live restore",
    scope: "restore-public-corpus-test",
    decision: id,
    choice: "retain",
    rationale: "prove the exact pre-Application database survives live replacement",
    revisable: "no",
    made_by: "agent",
    source: "discussion",
    superseded_by: null,
  });
}

test("every eligible sealed corpus Application restores exactly once after explicit Consent in rollback and WAL modes", (t) => {
  assert.equal(MANIFEST.cases.length, 26);
  assert.equal(ELIGIBLE_CASES.size, 13);
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "gsd-restore-public-corpus-")));
  t.after(() => {
    closeDatabase();
    rmSync(workspace, { recursive: true, force: true });
  });
  let completedRuns = 0;

  for (const entry of MANIFEST.cases.filter(({ name }) => ELIGIBLE_CASES.has(name))) {
    for (const journalMode of JOURNAL_MODES) {
      const runName = `${entry.name}/${journalMode}`;
      const runRoot = join(workspace, entry.name, journalMode);
      const source = join(runRoot, "source");
      const backups = join(runRoot, "backups");
      const databasePath = join(runRoot, "canonical.sqlite");
      cpSync(join(CORPUS_PATH, entry.name, "source"), source, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      mkdirSync(backups);
      assert.equal(openDatabase(databasePath), true, runName);

      try {
        const observedMode = database().prepare(`PRAGMA journal_mode=${journalMode}`).get()?.["journal_mode"];
        assert.equal(observedMode, journalMode, `${runName}: requested journal mode`);
        if (entry.name === "action-matrix") seedActionMatrixBase(source);
        seedJournalSentinel(`D-${entry.name}-${journalMode}`);

        const roots = createLegacyImportCorpusSourceRoots(source);
        const previewInput = { roots };
        const base = captureCurrentLegacyImportBaseSnapshot();
        const preview = createLegacyImportPreview(previewInput);
        assert.equal(preview.preview.counts.unresolved, 0, runName);
        const sourceHash = fingerprintLegacyImportCorpusTree(source);
        const backup = prepareLegacyImportBackup({
          preview,
          base,
          roots,
          destination_directory: backups,
          label: "public-live-restore",
        });
        const backupHash = sha256(backup.backup_ref);
        const applicationInput: LegacyImportApplicationInput = {
          invocation: {
            idempotencyKey: `legacy-import/public-restore/application/${entry.name}/${journalMode}`,
            sourceTransport: "internal",
            actorType: "agent",
            actorId: "restore-public-corpus-test",
          },
          previewInput,
          preview,
          backup,
          ...(preview.preview.counts.delete === 0
            ? {}
            : { destructiveConsent: createLegacyImportApplicationConsent(preview) }),
        };
        const applicationIdentityHash = createLegacyImportApplicationIdentity(
          applicationInput,
        ).applicationIdentityHash;
        applyLegacyImport(applicationInput);

        const changesBeforeAssessment = Number(
          database().prepare("SELECT total_changes() AS count").get()?.["count"],
        );
        const consentRequired = assessLegacyImportRestore({ applicationIdentityHash, backup });
        assert.equal(consentRequired.decision, "restore-consent-required", runName);
        assert.equal(consentRequired.recommendation.recommendedOptionId, "restore-backup", runName);
        assert.equal(consentRequired.recommendation.question?.endsWith("Proceed?"), true, runName);
        assert.equal(
          database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"],
          0,
          `${runName}: assessment never replaces the live database`,
        );
        assert.equal(
          database().prepare("SELECT total_changes() AS count").get()?.["count"],
          changesBeforeAssessment,
          `${runName}: assessment is read-only`,
        );

        const staleConsent = {
          consentSchemaVersion: LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION,
          decision: "proceed" as const,
          destructiveDatabaseRestore: true as const,
          evidenceHash: `sha256:${"0".repeat(64)}`,
        };
        assert.equal(
          assessLegacyImportRestore({ applicationIdentityHash, backup, consent: staleConsent }).decision,
          "restore-consent-required",
          `${runName}: changed evidence cannot authorize replacement`,
        );

        const consent = {
          ...staleConsent,
          evidenceHash: consentRequired.evidenceHash,
        };
        const assessment = assessLegacyImportRestore({ applicationIdentityHash, backup, consent });
        assert.equal(assessment.decision, "restore-eligible", runName);
        const restoreInput = {
          invocation: {
            idempotencyKey: `legacy-import/public-restore/${entry.name}/${journalMode}`,
            sourceTransport: "internal" as const,
            actorType: "agent" as const,
            actorId: "restore-public-corpus-test",
          },
          applicationIdentityHash,
          backup,
          assessment,
          consent,
        };
        const committed = restoreLegacyImportLive(restoreInput);
        assert.equal(committed.status, "committed", runName);
        assert.equal(committed.resultingProjectRevision, base.authority.revision + 1, runName);
        assert.equal(committed.resultingAuthorityEpoch, base.authority.authority_epoch, runName);
        assert.equal(committed.eventIds.length, 1, runName);
        assert.equal(committed.outboxIds.length, 1, runName);
        assert.equal(committed.projectionWorkIds.length, 1, runName);

        closeDatabase();
        assert.equal(openDatabase(databasePath), true, `${runName}: independent restart`);
        assert.equal(captureCurrentLegacyImportBaseSnapshot().relevant_rows_hash, base.relevant_rows_hash, runName);
        assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_applications").get()?.["count"], 0, runName);
        assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 1, runName);
        assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'import.restore'").get()?.["count"], 1, runName);
        assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_domain_events WHERE event_type = 'legacy-import.restored'").get()?.["count"], 1, runName);
        assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_outbox").get()?.["count"], 1, runName);
        assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_projection_work").get()?.["count"], 1, runName);
        assert.equal(existsSync(backup.backup_ref), true, `${runName}: backup retained`);
        assert.equal(sha256(backup.backup_ref), backupHash, `${runName}: backup bytes retained`);
        assert.equal(fingerprintLegacyImportCorpusTree(source), sourceHash, `${runName}: source retained`);

        const changesBeforeReplay = Number(
          database().prepare("SELECT total_changes() AS count").get()?.["count"],
        );
        const replayed = restoreLegacyImportLive(structuredClone(restoreInput));
        assert.deepEqual(replayed, { ...committed, status: "replayed" }, runName);
        assert.equal(
          database().prepare("SELECT total_changes() AS count").get()?.["count"],
          changesBeforeReplay,
          `${runName}: replay is read-only`,
        );
        completedRuns += 1;
      } finally {
        closeDatabase();
      }
    }
  }

  assert.equal(completedRuns, 26);
});

test("every ineligible sealed corpus case refuses Application before restore in rollback and WAL modes", (t) => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "gsd-restore-public-refusal-")));
  t.after(() => {
    closeDatabase();
    rmSync(workspace, { recursive: true, force: true });
  });
  let refusedRuns = 0;

  for (const entry of MANIFEST.cases.filter(({ name }) => !ELIGIBLE_CASES.has(name))) {
    for (const journalMode of JOURNAL_MODES) {
      const runName = `${entry.name}/${journalMode}`;
      const runRoot = join(workspace, entry.name, journalMode);
      const source = join(runRoot, "source");
      const backups = join(runRoot, "backups");
      const databasePath = join(runRoot, "canonical.sqlite");
      cpSync(join(CORPUS_PATH, entry.name, "source"), source, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      mkdirSync(backups);
      assert.equal(openDatabase(databasePath), true, runName);

      try {
        assert.equal(database().prepare(`PRAGMA journal_mode=${journalMode}`).get()?.["journal_mode"], journalMode, runName);
        const roots = createLegacyImportCorpusSourceRoots(source);
        const previewInput = { roots };
        const preview = createLegacyImportPreview(previewInput);
        assert.ok(preview.preview.counts.unresolved > 0, runName);
        const backup = prepareLegacyImportBackup({
          preview,
          base: captureCurrentLegacyImportBaseSnapshot(),
          roots,
          destination_directory: backups,
          label: "public-live-restore-refusal",
        });
        const changesBefore = Number(database().prepare("SELECT total_changes() AS count").get()?.["count"]);

        assert.throws(
          () => applyLegacyImport({
            invocation: {
              idempotencyKey: `legacy-import/public-restore/refusal/${entry.name}/${journalMode}`,
              sourceTransport: "internal",
              actorType: "agent",
              actorId: "restore-public-corpus-test",
            },
            previewInput,
            preview,
            backup,
          }),
          (error: unknown) => error instanceof LegacyImportApplicationError
            && error.code === "LEGACY_IMPORT_APPLICATION_PREVIEW_UNRESOLVED",
          runName,
        );
        assert.equal(database().prepare("SELECT total_changes() AS count").get()?.["count"], changesBefore, runName);
        assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_applications").get()?.["count"], 0, runName);
        assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 0, runName);
        refusedRuns += 1;
      } finally {
        closeDatabase();
      }
    }
  }

  assert.equal(refusedRuns, 26);
});
